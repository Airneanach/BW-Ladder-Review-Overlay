// bwfind: locates SC:R's live game-state structures in memory, using the
// OpenBW simulator as ground truth.
//
// The point of this tool is to make offset discovery repeatable rather than a
// one-off reverse-engineering session. Blizzard patches move everything; if
// finding the offsets again is a scripted twenty minutes instead of a research
// project, live state reading stays maintainable.
//
// The method leans on three things we already have:
//   1. SC:R replay playback is deterministic - the same replay produces the same
//      game state every time, so a scan can be re-run as often as needed.
//   2. bwstats.exe tells us exactly what the state SHOULD be at any given frame
//      (accurate in the early game, which is all this needs).
//   3. Those expected values are highly distinctive: twelve consecutive int32s
//      where the occupied player slots match specific numbers is not something
//      that occurs by chance.
//
// So instead of hunting for patterns in a binary, we ask "which address in this
// process currently holds the twelve numbers we know the game must be holding?"
//
// Read-only throughout: PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, no writes,
// no injection, nothing that alters the game being observed.
//
// Usage:
//   bwfind.exe frames [--all]
//       Stage 1. Finds the game frame counter by looking for an int32 that
//       advances at ~23.81 per second (BW's "fastest" speed). Run it with a
//       replay PLAYING.
//
//   bwfind.exe values <frame-counter-offset-hex> <groundtruth.csv> [--all]
//       Stage 2. Reads the current frame via the counter found in stage 1, looks
//       up what each player's minerals/gas should be at that frame, and finds
//       the arrays holding them. Run it with a replay PLAYING (it samples
//       repeatedly and keeps only candidates that stay correct).
//
// Generate the ground truth with a sample interval of 1 so every frame is present:
//   node src/dumpBins.mjs <replay.rep> <dir>
//   native\bwstats.exe "<install>" <dir>\header.bin <dir>\commands.bin <dir>\map.bin 1 > gt.csv

#define NOMINMAX // windows.h defines min/max macros that break std::max below
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

struct Region {
	uintptr_t base = 0;
	size_t size = 0;
	std::string label;
	std::vector<uint8_t> data;
};

// The module is loaded at a different address every launch (ASLR), so an absolute
// address is only meaningful for the session that produced it. What gets recorded
// and reused is the offset from the module base.
static uintptr_t g_moduleBase = 0;
static size_t g_moduleSize = 0;

static std::string describe_addr(uintptr_t addr) {
	char buf[64];
	if (g_moduleBase && addr >= g_moduleBase && addr < g_moduleBase + g_moduleSize) {
		snprintf(buf, sizeof(buf), "module+0x%llx", (unsigned long long)(addr - g_moduleBase));
	} else {
		snprintf(buf, sizeof(buf), "heap@0x%llx", (unsigned long long)addr); // not stable across runs
	}
	return buf;
}

static DWORD find_process_id(const wchar_t* name) {
	HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
	if (snap == INVALID_HANDLE_VALUE) return 0;
	PROCESSENTRY32W e{};
	e.dwSize = sizeof(e);
	DWORD pid = 0;
	if (Process32FirstW(snap, &e)) {
		do {
			if (_wcsicmp(e.szExeFile, name) == 0) { pid = e.th32ProcessID; break; }
		} while (Process32NextW(snap, &e));
	}
	CloseHandle(snap);
	return pid;
}

// The install ships both an x86 and an x86_64 StarCraft.exe and either can be the
// one running, so the PE headers are parsed for whichever bitness is actually
// there rather than assuming 64-bit.
static std::vector<Region> module_writable_sections(HANDLE proc, uintptr_t base) {
	std::vector<Region> out;
	IMAGE_DOS_HEADER dos{};
	SIZE_T got = 0;
	if (!ReadProcessMemory(proc, (LPCVOID)base, &dos, sizeof(dos), &got) || dos.e_magic != IMAGE_DOS_SIGNATURE) return out;

	uintptr_t nt = base + dos.e_lfanew;
	DWORD sig = 0;
	IMAGE_FILE_HEADER fh{};
	if (!ReadProcessMemory(proc, (LPCVOID)nt, &sig, sizeof(sig), &got) || sig != IMAGE_NT_SIGNATURE) return out;
	if (!ReadProcessMemory(proc, (LPCVOID)(nt + 4), &fh, sizeof(fh), &got)) return out;

	uintptr_t sections = nt + 4 + sizeof(IMAGE_FILE_HEADER) + fh.SizeOfOptionalHeader;
	for (int i = 0; i < fh.NumberOfSections; i++) {
		IMAGE_SECTION_HEADER sh{};
		if (!ReadProcessMemory(proc, (LPCVOID)(sections + i * sizeof(sh)), &sh, sizeof(sh), &got)) continue;
		bool writable = (sh.Characteristics & IMAGE_SCN_MEM_WRITE) != 0;
		bool executable = (sh.Characteristics & IMAGE_SCN_MEM_EXECUTE) != 0;
		if (!writable || executable || sh.Misc.VirtualSize == 0) continue;
		char name[9] = {};
		memcpy(name, sh.Name, 8);
		out.push_back({ base + sh.VirtualAddress, sh.Misc.VirtualSize, std::string("module+") + name, {} });
	}
	return out;
}

static std::vector<Region> module_executable_sections(HANDLE proc, uintptr_t base) {
	std::vector<Region> out;
	IMAGE_DOS_HEADER dos{};
	SIZE_T got = 0;
	if (!ReadProcessMemory(proc, (LPCVOID)base, &dos, sizeof(dos), &got) || dos.e_magic != IMAGE_DOS_SIGNATURE) return out;
	uintptr_t nt = base + dos.e_lfanew;
	DWORD sig = 0;
	IMAGE_FILE_HEADER fh{};
	if (!ReadProcessMemory(proc, (LPCVOID)nt, &sig, sizeof(sig), &got) || sig != IMAGE_NT_SIGNATURE) return out;
	if (!ReadProcessMemory(proc, (LPCVOID)(nt + 4), &fh, sizeof(fh), &got)) return out;
	uintptr_t sections = nt + 4 + sizeof(IMAGE_FILE_HEADER) + fh.SizeOfOptionalHeader;
	for (int i = 0; i < fh.NumberOfSections; i++) {
		IMAGE_SECTION_HEADER sh{};
		if (!ReadProcessMemory(proc, (LPCVOID)(sections + i * sizeof(sh)), &sh, sizeof(sh), &got)) continue;
		bool executable = (sh.Characteristics & IMAGE_SCN_MEM_EXECUTE) != 0;
		if (!executable || sh.Misc.VirtualSize == 0) continue;
		char name[9] = {};
		memcpy(name, sh.Name, 8);
		out.push_back({ base + sh.VirtualAddress, sh.Misc.VirtualSize, std::string("module+") + name, {} });
	}
	return out;
}

// SC:R is a modern client, so some state that was static in classic BW may well
// live on the heap. --all widens the search to committed private read/write pages.
static std::vector<Region> heap_regions(HANDLE proc) {
	std::vector<Region> out;
	MEMORY_BASIC_INFORMATION mbi{};
	uintptr_t addr = 0;
	size_t total = 0;
	const size_t kMaxTotal = (size_t)3 * 1024 * 1024 * 1024;
	while (VirtualQueryEx(proc, (LPCVOID)addr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
		uintptr_t next = (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
		if (next <= addr) break;
		bool committed = mbi.State == MEM_COMMIT;
		bool writable = (mbi.Protect & (PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE)) != 0;
		bool guarded = (mbi.Protect & (PAGE_GUARD | PAGE_NOACCESS)) != 0;
		if (committed && writable && !guarded && mbi.RegionSize >= 4096 && total + mbi.RegionSize < kMaxTotal) {
			out.push_back({ (uintptr_t)mbi.BaseAddress, mbi.RegionSize, "heap", {} });
			total += mbi.RegionSize;
		}
		addr = next;
	}
	return out;
}

static bool snapshot(HANDLE proc, std::vector<Region>& regions) {
	for (auto& r : regions) {
		r.data.resize(r.size);
		SIZE_T got = 0;
		if (!ReadProcessMemory(proc, (LPCVOID)r.base, r.data.data(), r.size, &got) || got != r.size) {
			// Partially-readable regions are normal; treat them as empty rather
			// than aborting the whole scan.
			r.data.assign(r.size, 0);
		}
	}
	return true;
}

static int32_t read_i32(const std::vector<uint8_t>& buf, size_t off) {
	int32_t v;
	memcpy(&v, buf.data() + off, 4);
	return v;
}

// ---------------------------------------------------------------------------
// Stage 1: the frame counter
// ---------------------------------------------------------------------------

static int cmd_frames(HANDLE proc, std::vector<Region> regions) {
	printf("stage 1: looking for the game frame counter\n");
	printf("  (needs a replay PLAYING, not paused - it identifies the counter by its rate)\n\n");

	auto t0 = std::chrono::steady_clock::now();
	snapshot(proc, regions);
	auto snapA = regions;

	std::this_thread::sleep_for(std::chrono::milliseconds(1500));
	auto t1 = std::chrono::steady_clock::now();
	snapshot(proc, regions);
	auto snapB = regions;

	std::this_thread::sleep_for(std::chrono::milliseconds(1500));
	auto t2 = std::chrono::steady_clock::now();
	snapshot(proc, regions);
	auto& snapC = regions;

	double msAB = std::chrono::duration<double, std::milli>(t1 - t0).count();
	double msBC = std::chrono::duration<double, std::milli>(t2 - t1).count();
	printf("  sampled %.0fms then %.0fms apart\n\n", msAB, msBC);

	// Deliberately rate-agnostic rather than assuming 23.81 fps: SC:R lets you
	// change replay playback speed, and hard-coding "fastest" would silently find
	// nothing if the replay happened to be running at 2x. Instead accept any
	// counter advancing at a steady, plausible rate and print the implied fps -
	// the game frame counter is the one reading ~23.8 at normal speed.
	const double kMinFps = 4.0, kMaxFps = 250.0, kRateTolerance = 0.12;
	size_t found = 0;
	for (size_t ri = 0; ri < regions.size(); ri++) {
		const auto& a = snapA[ri].data;
		const auto& b = snapB[ri].data;
		const auto& c = snapC[ri].data;
		if (a.size() < 4) continue;
		for (size_t off = 0; off + 4 <= a.size(); off += 4) {
			int32_t va = read_i32(a, off), vb = read_i32(b, off), vc = read_i32(c, off);
			if (va <= 0 || va > 500000) continue;          // a plausible frame number
			if (vb <= va || vc <= vb) continue;             // monotonic
			double rateAB = (vb - va) * 1000.0 / msAB;
			double rateBC = (vc - vb) * 1000.0 / msBC;
			if (rateAB < kMinFps || rateAB > kMaxFps) continue;
			if (fabs(rateAB - rateBC) / rateAB > kRateTolerance) continue; // steady, not bursty
			uintptr_t addr = regions[ri].base + off;
			printf("  CANDIDATE %-22s abs 0x%llx  %d -> %d -> %d  (%.1f fps)%s\n",
				describe_addr(addr).c_str(), (unsigned long long)addr, va, vb, vc, rateAB,
				(rateAB > 21.0 && rateAB < 27.0) ? "   <-- looks like game frames" : "");
			found++;
			if (found > 60) { printf("  ...more than 60 candidates, stopping\n"); return 0; }
		}
	}
	if (!found) printf("  no candidates. Is a replay actually playing (not paused)? Try --all for heap regions.\n");
	else printf("\n  %zu candidate(s). The game frame counter runs at ~23.8 fps at normal speed.\n"
	            "  Re-run to see which survive - a real counter keeps the same module offset across\n"
	            "  runs. Pass the winning address to `bwfind values`.\n", found);
	return 0;
}

// ---------------------------------------------------------------------------
// Stage 2: the per-player resource arrays
// ---------------------------------------------------------------------------

struct GroundTruth {
	// frame -> slot -> {minerals, gas}
	std::unordered_map<int, std::map<int, std::pair<int, int>>> byFrame;
};

static GroundTruth load_ground_truth(const std::string& path) {
	GroundTruth gt;
	std::ifstream f(path);
	if (!f) { fprintf(stderr, "bwfind: cannot open %s\n", path.c_str()); exit(1); }
	std::string line;
	while (std::getline(f, line)) {
		if (line.empty() || !isdigit((unsigned char)line[0])) continue; // header / player / victory rows
		std::stringstream ss(line);
		std::string cell;
		std::vector<std::string> cells;
		while (std::getline(ss, cell, ',')) cells.push_back(cell);
		if (cells.size() < 4) continue;
		int frame = atoi(cells[0].c_str());
		int slot = atoi(cells[1].c_str());
		gt.byFrame[frame][slot] = { atoi(cells[2].c_str()), atoi(cells[3].c_str()) };
	}
	return gt;
}

// Scores a 12-int32 window against what the occupied slots should hold. Slots the
// replay doesn't mention are wildcards - unoccupied slots may hold anything.
static bool window_matches(const std::vector<uint8_t>& buf, size_t off,
                           const std::map<int, std::pair<int, int>>& expect, bool gas) {
	for (const auto& [slot, mg] : expect) {
		if (slot < 0 || slot >= 12) continue;
		int32_t v = read_i32(buf, off + (size_t)slot * 4);
		if (v != (gas ? mg.second : mg.first)) return false;
	}
	return true;
}

static int cmd_values(HANDLE proc, std::vector<Region> regions, uintptr_t frameAddr, const std::string& gtPath) {
	GroundTruth gt = load_ground_truth(gtPath);
	printf("stage 2: locating the per-player resource arrays\n");
	printf("  ground truth: %zu frames loaded from %s\n", gt.byFrame.size(), gtPath.c_str());
	printf("  frame counter at 0x%llx\n\n", (unsigned long long)frameAddr);

	// Region index rather than a label string: the first pass can legitimately
	// produce a very large number of hits, and a std::string per hit is the
	// difference between "a lot of memory" and "far too much".
	struct Hit { uintptr_t addr; uint32_t region; int confirmations; };
	std::vector<Hit> mineralHits, gasHits;
	bool first = true;

	// The first scan is the only one searching all of memory; every later round
	// just filters survivors. So it must not run against a frame whose expected
	// values are things like 16 and 0, which match essentially everywhere. Wait
	// for a frame where at least two players hold distinct, non-trivial amounts.
	// Two specific int32s at fixed relative offsets is already a strong pattern; what
	// has to be avoided is values like 0, 1 or 16, which appear everywhere. Players
	// spend more or less continuously, so demanding large banked amounts would wait
	// forever - a modest floor plus "all distinct" is the right bar.
	auto distinctive = [](const std::map<int, std::pair<int, int>>& expect, bool gas) {
		std::vector<int> vals;
		for (const auto& [slot, mg] : expect) vals.push_back(gas ? mg.second : mg.first);
		if (vals.size() < 2) return false;
		std::sort(vals.begin(), vals.end());
		if (std::unique(vals.begin(), vals.end()) != vals.end()) return false; // all distinct
		return vals.front() >= 24;
	};
	int lastScannedFrame = -1;

	for (int round = 0; round < 8; round++) {
		// Read the frame, snapshot, read it again - if the game advanced mid-scan
		// the comparison would be against the wrong expected values.
		int32_t frameBefore = 0, frameAfter = 0;
		SIZE_T got = 0;
		ReadProcessMemory(proc, (LPCVOID)frameAddr, &frameBefore, 4, &got);
		snapshot(proc, regions);
		ReadProcessMemory(proc, (LPCVOID)frameAddr, &frameAfter, 4, &got);
		if (frameBefore != frameAfter) {
			printf("  round %d: frame moved %d -> %d during the scan, retrying\n", round, frameBefore, frameAfter);
			std::this_thread::sleep_for(std::chrono::milliseconds(400));
			continue;
		}
		auto it = gt.byFrame.find(frameBefore);
		if (it == gt.byFrame.end()) {
			printf("  round %d: frame %d not in ground truth (is this the right replay? was it dumped with interval 1?)\n", round, frameBefore);
			std::this_thread::sleep_for(std::chrono::milliseconds(500));
			continue;
		}
		const auto& expect = it->second;
		std::string desc;
		for (const auto& [slot, mg] : expect) desc += "  slot" + std::to_string(slot) + " " + std::to_string(mg.first) + "m/" + std::to_string(mg.second) + "g";
		printf("  round %d: frame %d expects%s\n", round, frameBefore, desc.c_str());

		if (frameBefore == lastScannedFrame) {
			// Same frame as the previous round means nothing new can be learned from
			// it - and if it keeps happening the replay has ended or is paused.
			printf("    frame hasn't advanced since the last round - is the replay still playing?\n");
			std::this_thread::sleep_for(std::chrono::milliseconds(1200));
			round--;
			continue;
		}

		if (first && !distinctive(expect, false)) {
			printf("    values too common to search on (need two distinct amounts, lowest >= 100)\n"
			       "    - let the replay run a little further\n");
			std::this_thread::sleep_for(std::chrono::milliseconds(1500));
			round--; // this round didn't happen
			continue;
		}

		auto scan = [&](bool gas, std::vector<Hit>& hits) {
			std::vector<Hit> now;
			for (size_t ri = 0; ri < regions.size(); ri++) {
				const auto& buf = regions[ri].data;
				if (buf.size() < 48) continue;
				for (size_t off = 0; off + 48 <= buf.size(); off += 4) {
					if (window_matches(buf, off, expect, gas)) {
						now.push_back({ regions[ri].base + off, (uint32_t)ri, 1 });
					}
				}
			}
			if (first) {
				hits = now;
			} else {
				// Keep only addresses that are still correct at this new frame.
				std::vector<Hit> kept;
				for (auto& h : hits) {
					for (auto& n : now) {
						if (n.addr == h.addr) { h.confirmations++; kept.push_back(h); break; }
					}
				}
				hits = kept;
			}
		};
		scan(false, mineralHits);
		scan(true, gasHits);
		first = false;
		lastScannedFrame = frameBefore;
		printf("    minerals: %zu surviving candidate(s), gas: %zu\n", mineralHits.size(), gasHits.size());
		if (mineralHits.size() == 1 && gasHits.size() == 1 && round >= 3) break;
		std::this_thread::sleep_for(std::chrono::milliseconds(700));
	}

	auto report = [&](const char* what, std::vector<Hit>& hits) {
		printf("\n  %s:\n", what);
		if (hits.empty()) { printf("    none survived - widen with --all, or check the replay matches the ground truth\n"); return; }
		for (size_t i = 0; i < hits.size() && i < 20; i++) {
			const auto& h = hits[i];
			printf("    %-24s abs 0x%llx  (%s)  confirmed %d time(s)\n",
				describe_addr(h.addr).c_str(), (unsigned long long)h.addr,
				regions[h.region].label.c_str(), h.confirmations);
		}
		if (hits.size() > 20) printf("    ...and %zu more\n", hits.size() - 20);
	};
	report("minerals array", mineralHits);
	report("gas array", gasHits);
	printf("\n  Both arrays should sit a fixed distance apart, and that gap plus the\n"
	       "  surrounding layout is how the rest of the player struct gets mapped.\n");
	return 0;
}

// ---------------------------------------------------------------------------
// Stage 2b: the resource arrays, structurally (no ground truth)
// ---------------------------------------------------------------------------

// Matching against simulated values has a weakness: it requires our simulation to
// agree with SC:R to the exact mineral, and we know it doesn't always. A dropped
// command early on means a building that never got built, and the numbers diverge.
//
// But a per-player array has a shape that doesn't depend on knowing any value:
// twelve consecutive int32s in which the occupied slots hold plausible, CHANGING
// amounts, and all ten other slots are exactly zero and stay that way. Ten hard
// zeros around two live counters is a very rare thing to find by accident, and it
// needs no ground truth, no exact frame, and no simulation accuracy at all.
static int cmd_arrays(HANDLE proc, std::vector<Region> regions, const std::vector<int>& occupied) {
	printf("stage 2b: locating per-player arrays structurally\n");
	printf("  occupied slots:");
	for (int s : occupied) printf(" %d", s);
	printf("  (all other slots must be zero throughout)\n");
	printf("  needs a game or replay PLAYING; sampling over ~9 seconds\n\n");

	// Two phases, because holding six full snapshots of a --all scan would need
	// tens of gigabytes. Phase 1 uses two snapshots to shortlist addresses, then
	// releases them; phase 2 re-reads only the 48 bytes at each shortlisted
	// address, which costs nothing.
	const int kSamples = 6;
	std::vector<std::vector<Region>> snaps;
	snapshot(proc, regions);
	snaps.push_back(regions);
	printf("  sample 1/2 (shortlisting)\n");
	std::this_thread::sleep_for(std::chrono::milliseconds(2000));
	snapshot(proc, regions);
	snaps.push_back(regions);
	printf("  sample 2/2 (shortlisting)\n");

	// Which array slots the players actually occupy is itself a guess - BW's
	// internal player indexing need not line up with the replay header's slot
	// numbering - so rather than assume, find windows where a SMALL number of
	// slots are live and everything else is hard zero, and report which slots
	// those turned out to be. `occupied` is then only used to rank the output.
	(void)occupied;
	struct Cand { uintptr_t addr; std::vector<int> live; };
	std::vector<Cand> shortlist;
	for (size_t ri = 0; ri < regions.size(); ri++) {
		if (snaps[0][ri].data.size() < 48) continue;
		for (size_t off = 0; off + 48 <= snaps[0][ri].data.size(); off += 4) {
			std::vector<int> live;
			bool ok = true, changed = false;
			for (int slot = 0; slot < 12 && ok; slot++) {
				int32_t a = read_i32(snaps[0][ri].data, off + (size_t)slot * 4);
				int32_t b = read_i32(snaps[1][ri].data, off + (size_t)slot * 4);
				if (a < 0 || a > 100000 || b < 0 || b > 100000) { ok = false; break; }
				if (a != 0 || b != 0) live.push_back(slot);
				if (a != b) changed = true;
			}
			if (!ok || !changed || live.size() < 2 || live.size() > 3) continue;
			shortlist.push_back({ regions[ri].base + off, live });
		}
	}
	snaps.clear();
	snaps.shrink_to_fit();
	for (auto& r : regions) { r.data.clear(); r.data.shrink_to_fit(); }
	printf("  %zu shortlisted; watching them over %d more samples\n", shortlist.size(), kSamples - 2);

	// Phase 2. Two extra tests kill almost all of what phase 1 lets through:
	//
	//   - the live slots must DIFFER from each other at some point. Symmetric
	//     data (unit stat tables reading 250/250 then 300/300) changes over time
	//     and survives phase 1, but two players almost never hold identical
	//     resources sample after sample.
	//   - some live slot must take at least three distinct values. Resources move
	//     constantly as workers deliver; a value that just steps once or twice is
	//     something else.
	std::vector<std::vector<std::vector<int32_t>>> history(shortlist.size()); // cand -> sample -> 12 slots
	for (int s = 0; s < kSamples - 2; s++) {
		std::this_thread::sleep_for(std::chrono::milliseconds(1400));
		for (size_t c = 0; c < shortlist.size(); c++) {
			int32_t vals[12] = {};
			SIZE_T got = 0;
			if (!ReadProcessMemory(proc, (LPCVOID)shortlist[c].addr, vals, 48, &got) || got != 48) continue;
			history[c].push_back(std::vector<int32_t>(vals, vals + 12));
		}
		printf("  sample %d/%d\n", s + 3, kSamples);
	}

	size_t found = 0;
	for (size_t c = 0; c < shortlist.size(); c++) {
		const auto& live = shortlist[c].live;
		const auto& hist = history[c];
		if (hist.size() < 3) continue;

		bool everDiffer = false;
		for (const auto& row : hist) {
			for (size_t i = 1; i < live.size(); i++) {
				if (row[live[i]] != row[live[0]]) everDiffer = true;
			}
		}
		size_t mostDistinct = 0;
		for (int slot : live) {
			std::vector<int32_t> vs;
			for (const auto& row : hist) vs.push_back(row[slot]);
			std::sort(vs.begin(), vs.end());
			mostDistinct = std::max(mostDistinct, (size_t)(std::unique(vs.begin(), vs.end()) - vs.begin()));
		}
		if (!everDiffer || mostDistinct < 3) continue;

		printf("  CANDIDATE %-22s abs 0x%llx  slots{", describe_addr(shortlist[c].addr).c_str(),
			(unsigned long long)shortlist[c].addr);
		for (size_t k = 0; k < live.size(); k++) printf("%s%d", k ? "," : "", live[k]);
		printf("}  ");
		for (const auto& row : hist) {
			printf("[");
			for (size_t k = 0; k < live.size(); k++) printf("%s%d", k ? "/" : "", row[live[k]]);
			printf("]");
		}
		printf("\n");
		if (++found >= 40) { printf("  ...stopping at 40\n"); break; }
	}
	if (!found) {
		printf("  nothing found. Is a game actually in progress and running? Try --all.\n");
		return 1;
	}
	printf("\n  %zu candidate(s). Minerals start at 50 and climb immediately; gas stays 0\n"
	       "  until a refinery finishes, which is how to tell the two apart.\n", found);
	return 0;
}

// ---------------------------------------------------------------------------
// Stage 2c: track single values (layout-agnostic)
// ---------------------------------------------------------------------------

// Both earlier scans assumed classic BW's layout - twelve contiguous int32s per
// stat, indexed by player. The evidence says SC:R doesn't do that: the resource
// figures found so far sit as isolated per-player PAIRS separated by a large
// stride, i.e. per-player structs. Under that layout a twelve-int window over one
// stat simply doesn't exist, which is why both scans came back empty.
//
// This makes no layout assumption at all. It tracks one value at a time the way
// you would by hand: find every int32 currently equal to what the value should be,
// then keep only those still correct at the next frame, and the next. A few rounds
// takes it from a lot of addresses to a handful, and it works wherever the value
// lives and whatever surrounds it.
//
// It does depend on the simulation agreeing with the game, so it doubles as an
// accuracy test: converging means the numbers match, and collapsing to zero
// candidates in round 1 means they don't.
static int cmd_track(HANDLE proc, std::vector<Region> regions, uintptr_t frameAddr, const std::string& gtPath) {
	GroundTruth gt = load_ground_truth(gtPath);
	printf("stage 2c: tracking individual values (no layout assumptions)\n");
	printf("  ground truth: %zu frames\n\n", gt.byFrame.size());

	struct Target { int slot; bool gas; std::vector<uintptr_t> cands; };
	std::vector<Target> targets;
	const int kFrameWindow = 24; // ~1 second either side

	int lastFrame = -1;
	for (int round = 0; round < 8; round++) {
		int32_t frameBefore = 0, frameAfter = 0;
		SIZE_T got = 0;
		ReadProcessMemory(proc, (LPCVOID)frameAddr, &frameBefore, 4, &got);
		if (frameBefore == lastFrame) { std::this_thread::sleep_for(std::chrono::milliseconds(600)); round--; continue; }

		auto it = gt.byFrame.find(frameBefore);
		if (it == gt.byFrame.end()) { printf("  frame %d not in ground truth\n", frameBefore); break; }
		const auto& expect = it->second;

		if (targets.empty()) {
			for (const auto& [slot, mg] : expect) {
				targets.push_back({ slot, false, {} });
				targets.push_back({ slot, true, {} });
			}
		}

		// Accept any value the simulation predicts for this slot within a window of
		// frames around the counter, rather than demanding the value at exactly
		// that frame. Resources move every few frames, so even a small constant
		// offset between the game's frame counter and our indexing of the command
		// stream makes exact matching fail everywhere - which is what happened.
		// The window costs little: a wrong address has to keep landing inside the
		// predicted set round after round, and the set is small.
		auto acceptable = [&](int slot, bool gas) {
			std::vector<int32_t> vals;
			for (int f = frameBefore - kFrameWindow; f <= frameBefore + kFrameWindow; f++) {
				auto fit = gt.byFrame.find(f);
				if (fit == gt.byFrame.end()) continue;
				auto sit = fit->second.find(slot);
				if (sit == fit->second.end()) continue;
				vals.push_back(gas ? sit->second.second : sit->second.first);
			}
			std::sort(vals.begin(), vals.end());
			vals.erase(std::unique(vals.begin(), vals.end()), vals.end());
			return vals;
		};

		if (round == 0) {
			snapshot(proc, regions);
			ReadProcessMemory(proc, (LPCVOID)frameAddr, &frameAfter, 4, &got);
			if (frameBefore != frameAfter) { printf("  frame moved during snapshot, retrying\n"); round--; continue; }
			for (auto& t : targets) {
				auto want = acceptable(t.slot, t.gas);
				if (want.empty()) continue;
				for (size_t ri = 0; ri < regions.size(); ri++) {
					const auto& buf = regions[ri].data;
					for (size_t off = 0; off + 4 <= buf.size(); off += 4) {
						int32_t v = read_i32(buf, off);
						if (std::binary_search(want.begin(), want.end(), v)) t.cands.push_back(regions[ri].base + off);
					}
				}
			}
			for (auto& r : regions) { r.data.clear(); r.data.shrink_to_fit(); }
		} else {
			for (auto& t : targets) {
				auto want = acceptable(t.slot, t.gas);
				if (want.empty()) continue;
				std::vector<uintptr_t> kept;
				for (uintptr_t a : t.cands) {
					int32_t v = 0;
					if (ReadProcessMemory(proc, (LPCVOID)a, &v, 4, &got) && got == 4 &&
						std::binary_search(want.begin(), want.end(), v)) kept.push_back(a);
				}
				t.cands = kept;
			}
		}

		printf("  round %d frame %d:", round, frameBefore);
		for (auto& t : targets) printf("  slot%d%s=%zu", t.slot, t.gas ? "gas" : "min", t.cands.size());
		printf("\n");
		lastFrame = frameBefore;

		bool allSmall = true;
		for (auto& t : targets) if (t.cands.size() > 4) allSmall = false;
		if (allSmall && round >= 2) break;
		std::this_thread::sleep_for(std::chrono::milliseconds(900));
	}

	printf("\n  results:\n");
	for (auto& t : targets) {
		printf("    slot %d %s: %zu candidate(s)\n", t.slot, t.gas ? "gas    " : "minerals", t.cands.size());
		for (size_t i = 0; i < t.cands.size() && i < 8; i++) {
			printf("      %s (abs 0x%llx)\n", describe_addr(t.cands[i]).c_str(), (unsigned long long)t.cands[i]);
		}
	}
	printf("\n  Zero candidates as early as round 1 means the simulation and the game\n"
	       "  disagree on the value, not that the address is missing.\n");
	return 0;
}

// ---------------------------------------------------------------------------
// Stage 2d: find resources by behaviour, with no ground truth at all
// ---------------------------------------------------------------------------

// Every ground-truth approach is dead: the simulation and the game disagree on
// the actual numbers, so no scan can look for "the value we think it should be".
//
// But a mineral bank behaves in a way almost nothing else in memory does:
//   - a worker delivering adds exactly 8 (several at once give a multiple of 8);
//   - everything purchasable in BW costs a multiple of 25, so every decrease is
//     a multiple of 25;
//   - it must go DOWN sometimes - that's what separates the current bank from the
//     cumulative "gathered" totals, which only ever climb.
//
// Sampled fast enough that events don't overlap, that triple constraint is very
// selective and needs no ground truth, no exact frame, and no correct simulation.
static int cmd_resources(HANDLE proc, std::vector<Region> regions) {
	printf("stage 2d: finding resource banks by behaviour (no ground truth)\n");
	printf("  rule: increases are multiples of 8, decreases are multiples of 25,\n");
	printf("        and the value must decrease at least once\n\n");

	auto plausible = [](int32_t v) { return v >= 0 && v <= 30000; };
	auto legalDelta = [](int32_t d) {
		if (d == 0) return true;
		if (d > 0) return d % 8 == 0 && d <= 200;      // deliveries
		return (-d) % 25 == 0 && -d <= 2000;            // purchases
	};

	// Phase 1: two reads a short interval apart. Snapshot A is held; B is read
	// region by region and discarded immediately, so peak memory is one snapshot
	// rather than two.
	snapshot(proc, regions);
	std::this_thread::sleep_for(std::chrono::milliseconds(250));

	std::vector<uintptr_t> cands;
	for (size_t ri = 0; ri < regions.size(); ri++) {
		std::vector<uint8_t> b(regions[ri].size);
		SIZE_T got = 0;
		if (ReadProcessMemory(proc, (LPCVOID)regions[ri].base, b.data(), b.size(), &got) && got == b.size()) {
			const auto& a = regions[ri].data;
			for (size_t off = 0; off + 4 <= a.size(); off += 4) {
				int32_t va = read_i32(a, off), vb = read_i32(b, off);
				if (!plausible(va) || !plausible(vb)) continue;
				int32_t d = vb - va;
				if (d == 0 || !legalDelta(d)) continue; // must have moved, legally
				cands.push_back(regions[ri].base + off);
			}
		}
		regions[ri].data.clear();
		regions[ri].data.shrink_to_fit();
	}
	printf("  phase 1: %zu addresses moved by a legal amount\n", cands.size());
	if (cands.empty()) { printf("  none - is the game actually running?\n"); return 1; }

	// Phase 2: watch just those, often enough that events stay separated.
	std::vector<int32_t> last(cands.size());
	std::vector<int> decreases(cands.size(), 0), increases(cands.size(), 0);
	std::vector<bool> alive(cands.size(), true);
	for (size_t i = 0; i < cands.size(); i++) {
		SIZE_T got = 0;
		ReadProcessMemory(proc, (LPCVOID)cands[i], &last[i], 4, &got);
	}

	const int kRounds = 150; // ~37 seconds
	for (int r = 0; r < kRounds; r++) {
		std::this_thread::sleep_for(std::chrono::milliseconds(250));
		for (size_t i = 0; i < cands.size(); i++) {
			if (!alive[i]) continue;
			int32_t v = 0;
			SIZE_T got = 0;
			if (!ReadProcessMemory(proc, (LPCVOID)cands[i], &v, 4, &got) || got != 4) { alive[i] = false; continue; }
			int32_t d = v - last[i];
			if (!plausible(v) || !legalDelta(d)) { alive[i] = false; continue; }
			if (d > 0) increases[i]++;
			if (d < 0) decreases[i]++;
			last[i] = v;
		}
		if (r % 30 == 29) {
			size_t n = 0;
			for (size_t i = 0; i < cands.size(); i++) if (alive[i]) n++;
			printf("  %2ds: %zu still behaving like a resource bank\n", (r + 1) / 4, n);
		}
	}

	printf("\n  surviving addresses that both rose and fell:\n");
	size_t shown = 0;
	for (size_t i = 0; i < cands.size(); i++) {
		if (!alive[i] || decreases[i] == 0 || increases[i] < 3) continue;
		int32_t v = 0;
		SIZE_T got = 0;
		ReadProcessMemory(proc, (LPCVOID)cands[i], &v, 4, &got);
		printf("    %-24s abs 0x%llx  now=%d  +%d/-%d\n", describe_addr(cands[i]).c_str(),
			(unsigned long long)cands[i], v, increases[i], decreases[i]);
		if (++shown >= 30) { printf("    ...stopping at 30\n"); break; }
	}
	if (!shown) printf("    none. Increase the sampling window, or the game may store these as 16-bit.\n");
	else printf("\n  Two of these should be one player's minerals and gas; the gap between the\n"
	            "  two players' copies gives the per-player stride.\n");
	return 0;
}

// ---------------------------------------------------------------------------
// Stage 3: the unit array
// ---------------------------------------------------------------------------

// Unlike the resource arrays, we don't know what the unit struct looks like, so
// there is no fixed pattern to match. What we do know is every live unit's
// position at a given frame, and a position is a distinctive pair of int16s.
//
// The trick is not finding one of them - single (x, y) pairs collide all over a
// gigabyte of memory - but finding lots of them laid out at a CONSTANT STRIDE.
// An array of N units is N position matches spaced sizeof(CUnit) apart, and
// nothing else in the process looks like that. So this scans for every position,
// then looks for the stride that explains the most hits. That yields the array
// base and the struct size in one go, and the struct size then anchors the field
// offsets we actually need.
struct UnitTruth { int owner, type, x, y; };

static std::vector<UnitTruth> load_unit_truth(const std::string& path) {
	std::vector<UnitTruth> out;
	std::ifstream f(path);
	if (!f) { fprintf(stderr, "bwfind: cannot open %s\n", path.c_str()); exit(1); }
	std::string line;
	while (std::getline(f, line)) {
		if (line.empty() || line[0] == '#' || !isdigit((unsigned char)line[0])) continue;
		std::stringstream ss(line);
		std::string cell;
		std::vector<int> v;
		while (std::getline(ss, cell, ',')) v.push_back(atoi(cell.c_str()));
		if (v.size() >= 4) out.push_back({ v[0], v[1], v[2], v[3] });
	}
	return out;
}

static int cmd_units(HANDLE proc, std::vector<Region> regions, const std::string& truthPath) {
	auto units = load_unit_truth(truthPath);
	printf("stage 3: locating the unit array\n");
	printf("  %zu units of ground truth from %s\n", units.size(), truthPath.c_str());
	printf("  PAUSE the replay on the exact frame the dump was taken at before running this.\n\n");
	if (units.size() < 8) {
		printf("  too few units to identify a stride reliably - dump at a later frame\n");
		return 1;
	}

	snapshot(proc, regions);

	// Index the ground-truth positions so matching is a hash lookup rather than a
	// scan over every unit for every offset in memory.
	std::unordered_map<uint32_t, size_t> byPos16, byPos32;
	for (size_t ui = 0; ui < units.size(); ui++) {
		byPos16[((uint32_t)(uint16_t)units[ui].y << 16) | (uint16_t)units[ui].x] = ui;
	}

	// Positions might be stored as two int16s or as two int32s; try both rather
	// than assume. Each encoding is scanned at its natural alignment.
	std::vector<std::pair<uintptr_t, size_t>> hits; // address, unit index
	for (int encoding = 0; encoding < 2; encoding++) {
		size_t before = hits.size();
		for (size_t ri = 0; ri < regions.size(); ri++) {
			const auto& buf = regions[ri].data;
			if (buf.size() < 8) continue;
			if (encoding == 0) {
				for (size_t off = 0; off + 4 <= buf.size(); off += 2) {
					uint32_t key;
					memcpy(&key, buf.data() + off, 4);
					auto it = byPos16.find(key);
					if (it != byPos16.end()) hits.push_back({ regions[ri].base + off, it->second });
				}
			} else {
				for (size_t off = 0; off + 8 <= buf.size(); off += 4) {
					int32_t x, y;
					memcpy(&x, buf.data() + off, 4);
					memcpy(&y, buf.data() + off + 4, 4);
					if (x <= 0 || y <= 0 || x > 65535 || y > 65535) continue;
					auto it = byPos16.find(((uint32_t)(uint16_t)y << 16) | (uint16_t)x);
					if (it != byPos16.end()) hits.push_back({ regions[ri].base + off, it->second });
				}
			}
		}
		printf("  %s positions: %zu raw matches\n", encoding == 0 ? "int16" : "int32", hits.size() - before);
	}
	printf("  %zu raw position matches total\n", hits.size());
	if (hits.empty()) {
		printf("  none. Is the replay paused on the right frame? Is it the same replay?\n"
		       "  Try --all - the unit array may well be on the heap rather than in the module.\n");
		return 1;
	}

	std::sort(hits.begin(), hits.end());

	// For each plausible struct size, count how many hits land on a common lattice.
	// Real CUnit sizes are on the order of a few hundred bytes; scan a wide range
	// rather than assuming the classic 336.
	// Score by DISTINCT units at a stride, not raw hits. That distinction matters:
	// the first attempt at this scored raw hits and confidently reported a stride
	// of 244 which turned out to be a UTF-16 text buffer, where fixed-width lines
	// produce endless coincidental byte pairs. Text can hit one position many
	// times; only a real unit array hits many DIFFERENT units at a constant
	// spacing.
	// Distinct-unit counting still wasn't enough on its own - a text buffer full of
	// coincidental byte pairs, spread over megabytes, can touch many different
	// positions at some residue. The property that actually separates an array
	// from scattered noise is DENSITY: real units occupy most consecutive slots of
	// a compact address range, whereas coincidences sit at the same residue but
	// scattered across an enormous span. So score by fill ratio over the span.
	struct StrideScore {
		size_t stride, distinct, slots, span;
		double fill;
		uintptr_t lo, hi;
	};
	std::vector<StrideScore> best;
	for (size_t stride = 64; stride <= 2048; stride += 4) {
		std::unordered_map<uintptr_t, std::vector<uintptr_t>> lattice;
		std::unordered_map<uintptr_t, std::unordered_set<size_t>> distinctUnits;
		for (auto& [addr, ui] : hits) {
			lattice[addr % stride].push_back(addr);
			distinctUnits[addr % stride].insert(ui);
		}
		for (auto& [residue, addrs] : lattice) {
			if (addrs.size() < 12) continue;
			auto sorted = addrs;
			std::sort(sorted.begin(), sorted.end());
			sorted.erase(std::unique(sorted.begin(), sorted.end()), sorted.end());

			// Longest densely-populated run of consecutive slots.
			size_t bestRunSlots = 0;
			uintptr_t bestLo = 0, bestHi = 0;
			size_t runStart = 0;
			for (size_t i = 1; i <= sorted.size(); i++) {
				bool broken = i == sorted.size() || (sorted[i] - sorted[i - 1]) > stride * 4;
				if (!broken) continue;
				size_t slots = i - runStart;
				if (slots > bestRunSlots) {
					bestRunSlots = slots;
					bestLo = sorted[runStart];
					bestHi = sorted[i - 1];
				}
				runStart = i;
			}
			if (bestRunSlots < 12) continue;
			size_t span = (size_t)((bestHi - bestLo) / stride) + 1;
			double fill = span ? (double)bestRunSlots / (double)span : 0.0;
			best.push_back({ stride, distinctUnits[residue].size(), bestRunSlots, span, fill, bestLo, bestHi });
		}
	}
	std::sort(best.begin(), best.end(), [](const StrideScore& a, const StrideScore& b) {
		if (a.slots != b.slots) return a.slots > b.slots;
		return a.fill > b.fill;
	});

	if (best.empty()) {
		printf("  no consistent stride found. Try --all, or dump at a frame with more units.\n");
		return 1;
	}
	printf("\n  best candidates, ranked by longest dense run of consecutive slots:\n");
	printf("    %8s %7s %7s %6s %9s   %s\n", "stride", "slots", "distinct", "span", "fill", "address range");
	for (size_t i = 0; i < best.size() && i < 14; i++) {
		const auto& b = best[i];
		printf("    %8zu %7zu %7zu %6zu %8.0f%%   0x%llx .. 0x%llx\n",
			b.stride, b.slots, b.distinct, b.span, b.fill * 100.0,
			(unsigned long long)b.lo, (unsigned long long)b.hi);
	}
	printf("\n  The winning stride is sizeof(CUnit); the first address is a unit's position\n"
	       "  field, so subtracting the position offset within the struct gives the array base.\n");
	return 0;
}

// ---------------------------------------------------------------------------

int main(int argc, char** argv) {
	// Unbuffered: these commands are long-running and usually watched through a
	// pipe or killed by a timeout, and block buffering loses everything printed
	// before the kill.
	setvbuf(stdout, nullptr, _IONBF, 0);
	if (argc < 2) {
		fprintf(stderr,
			"usage:\n"
			"  discovery:\n"
			"    bwfind.exe frames [--all]              find the game frame counter\n"
			"    bwfind.exe exact <out.txt> <value>...  search for literal values (pause the game first)\n"
			"    bwfind.exe ptr <target-addr-hex>       find 64-bit pointers to an address\n"
			"    bwfind.exe lists <unit-addr-hex>       find BW's unit-list head globals\n"
			"  inspection:\n"
			"    bwfind.exe peek <addr-hex>             read one int32\n"
			"    bwfind.exe dump <addr-hex> [n] [--u16] read n values (build queues need --u16)\n"
			"    bwfind.exe diff <addr-a> <addr-b>      byte-diff two unit records\n"
			"    bwfind.exe unitwalk <unit-addr-hex>    enumerate units via the linked list\n"
			"  verification:\n"
			"    bwfind.exe log <unit-costs.csv> <resource-base-hex> <unit-anchor-hex|0> [out.jsonl]\n"
			"\n"
			"see OFFSET_DISCOVERY.md for confirmed offsets and how each was established\n");
		return 1;
	}
	std::string cmd = argv[1];
	bool all = false;
	for (int i = 2; i < argc; i++) if (std::string(argv[i]) == "--all") all = true;

	DWORD pid = find_process_id(L"StarCraft.exe");
	if (!pid) { fprintf(stderr, "bwfind: StarCraft.exe is not running\n"); return 1; }

	HANDLE proc = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, FALSE, pid);
	if (!proc) { fprintf(stderr, "bwfind: OpenProcess failed (%lu) - try running as administrator\n", GetLastError()); return 1; }

	HMODULE mainModule = nullptr;
	DWORD needed = 0;
	if (!EnumProcessModules(proc, &mainModule, sizeof(mainModule), &needed)) {
		fprintf(stderr, "bwfind: EnumProcessModules failed (%lu)\n", GetLastError());
		return 1;
	}
	uintptr_t moduleBase = (uintptr_t)mainModule;
	g_moduleBase = moduleBase;
	MODULEINFO mi{};
	if (GetModuleInformation(proc, mainModule, &mi, sizeof(mi))) g_moduleSize = mi.SizeOfImage;
	BOOL isWow64 = FALSE;
	IsWow64Process(proc, &isWow64);
	printf("attached to StarCraft.exe pid %lu, module base 0x%llx (%s)\n",
		pid, (unsigned long long)moduleBase, isWow64 ? "32-bit" : "64-bit");

	auto regions = module_writable_sections(proc, moduleBase);
	size_t moduleBytes = 0;
	for (auto& r : regions) moduleBytes += r.size;
	if (all) {
		auto h = heap_regions(proc);
		printf("scanning %zu module section(s) (%.1f MB) + %zu heap region(s)\n",
			regions.size(), moduleBytes / 1048576.0, h.size());
		regions.insert(regions.end(), h.begin(), h.end());
	} else {
		printf("scanning %zu module section(s) (%.1f MB); pass --all to include the heap\n",
			regions.size(), moduleBytes / 1048576.0);
	}
	printf("\n");

	// snap/diffsnap: raw byte-for-byte capture and diff of every scanned region,
	// for finding a value the "exact"/"exactb" guess-a-literal approach can't -
	// e.g. a color id that changes to some value that isn't known in advance.
	// Pause the game between the two calls so nothing except the thing being
	// hunted for changes.
	if (cmd == "snap") {
		if (argc < 3) { fprintf(stderr, "bwfind: snap needs <out.bin> [--all]\n"); return 1; }
		snapshot(proc, regions);
		std::ofstream out(argv[2], std::ios::binary);
		uint32_t n = (uint32_t)regions.size();
		out.write((const char*)&n, sizeof(n));
		for (auto& r : regions) {
			uint64_t base = r.base, size = r.size;
			out.write((const char*)&base, sizeof(base));
			out.write((const char*)&size, sizeof(size));
			out.write((const char*)r.data.data(), r.size);
		}
		printf("wrote snapshot of %zu region(s) to %s\n", regions.size(), argv[2]);
		return 0;
	}
	if (cmd == "diffsnap") {
		if (argc < 4) { fprintf(stderr, "bwfind: diffsnap needs <in.bin> <out.txt> [--all]\n"); return 1; }
		std::ifstream in(argv[2], std::ios::binary);
		if (!in) { fprintf(stderr, "bwfind: cannot open %s\n", argv[2]); return 1; }
		uint32_t n = 0;
		in.read((char*)&n, sizeof(n));
		snapshot(proc, regions);
		std::unordered_map<uintptr_t, Region*> live;
		for (auto& r : regions) live[r.base] = &r;
		std::ofstream out(argv[3]);
		size_t totalDiffs = 0, printed = 0;
		for (uint32_t i = 0; i < n; i++) {
			uint64_t base = 0, size = 0;
			in.read((char*)&base, sizeof(base));
			in.read((char*)&size, sizeof(size));
			std::vector<uint8_t> old(size);
			in.read((char*)old.data(), size);
			auto it = live.find((uintptr_t)base);
			if (it == live.end() || it->second->data.size() != size) continue; // region gone or resized
			const auto& cur = it->second->data;
			for (uint64_t off = 0; off < size; off++) {
				if (old[off] != cur[off]) {
					uintptr_t addr = (uintptr_t)base + off;
					out << std::hex << addr << " " << std::dec << (int)old[off] << " " << (int)cur[off] << "\n";
					totalDiffs++;
					if (printed < 200) {
						printf("  %s (abs 0x%llx): %d -> %d\n", describe_addr(addr).c_str(),
							(unsigned long long)addr, old[off], cur[off]);
						printed++;
					}
				}
			}
		}
		printf("\n%zu byte(s) changed (see %s for the full list)%s\n", totalDiffs, argv[3],
			totalDiffs > 200 ? " - only the first 200 were printed" : "");
		return 0;
	}
	if (cmd == "frames") return cmd_frames(proc, std::move(regions));
	if (cmd == "values") {
		if (argc < 4) { fprintf(stderr, "bwfind: values needs <frame-counter-addr-hex> <groundtruth.csv>\n"); return 1; }
		uintptr_t addr = (uintptr_t)strtoull(argv[2], nullptr, 16);
		return cmd_values(proc, std::move(regions), addr, argv[3]);
	}
	if (cmd == "arrays") {
		std::vector<int> occupied;
		if (argc >= 3 && isdigit((unsigned char)argv[2][0])) {
			std::stringstream ss(argv[2]);
			std::string cell;
			while (std::getline(ss, cell, ',')) occupied.push_back(atoi(cell.c_str()));
		} else {
			occupied = { 1, 2 };
		}
		return cmd_arrays(proc, std::move(regions), occupied);
	}
	if (cmd == "dump") {
		// Raw int32 view around an address. Structure is much easier to read than
		// to infer: an array of one stat per player looks different from an array
		// of per-player structs, and this shows which it is.
		if (argc < 3) { fprintf(stderr, "bwfind: dump needs <addr-hex> [count-int32]\n"); return 1; }
		uintptr_t addr = (uintptr_t)strtoull(argv[2], nullptr, 16);
		// --u16 matters more than it sounds: BW stores build queues, unit type ids
		// and upgrade ids as 16-bit, so an int32 view simply cannot show them. A
		// building training three of something holds that type id three times in a
		// row as uint16, which is about as distinctive a pattern as exists.
		bool u16 = false;
		for (int i = 3; i < argc; i++) if (std::string(argv[i]) == "--u16") u16 = true;
		int count = argc >= 4 && isdigit((unsigned char)argv[3][0]) ? atoi(argv[3]) : 32;
		if (u16) {
			std::vector<uint16_t> vals(count * 2);
			SIZE_T got16 = 0;
			if (!ReadProcessMemory(proc, (LPCVOID)addr, vals.data(), vals.size() * 2, &got16)) {
				fprintf(stderr, "bwfind: read failed at 0x%llx (%lu)\n", (unsigned long long)addr, GetLastError());
				return 1;
			}
			for (size_t i = 0; i < vals.size(); i += 8) {
				printf("  +0x%03x  ", (unsigned)(i * 2));
				for (size_t k = 0; k < 8 && i + k < vals.size(); k++) printf("%7u", vals[i + k]);
				printf("\n");
			}
			return 0;
		}
		std::vector<int32_t> vals(count);
		SIZE_T got = 0;
		if (!ReadProcessMemory(proc, (LPCVOID)addr, vals.data(), count * 4, &got)) {
			fprintf(stderr, "bwfind: read failed at 0x%llx (%lu)\n", (unsigned long long)addr, GetLastError());
			return 1;
		}
		for (int i = 0; i < count; i += 4) {
			printf("  +0x%03x  ", i * 4);
			for (int k = 0; k < 4 && i + k < count; k++) printf("%12d", vals[i + k]);
			printf("\n");
		}
		return 0;
	}
	if (cmd == "peek") {
		// Reads one int32. Used to ask "which frame is the replay paused on?" so a
		// unit dump can be generated for exactly that frame, rather than having to
		// pause on a frame chosen in advance.
		if (argc < 3) { fprintf(stderr, "bwfind: peek needs <addr-hex>\n"); return 1; }
		uintptr_t addr = (uintptr_t)strtoull(argv[2], nullptr, 16);
		int32_t v = 0;
		SIZE_T got = 0;
		if (!ReadProcessMemory(proc, (LPCVOID)addr, &v, 4, &got) || got != 4) {
			fprintf(stderr, "bwfind: read failed at 0x%llx (%lu)\n", (unsigned long long)addr, GetLastError());
			return 1;
		}
		printf("%s = %d\n", describe_addr(addr).c_str(), v);
		return 0;
	}
	// exact / recheck: scan for values read off the game's own UI.
	//
	// This is the approach that depends on nothing we might have wrong. Pause the
	// replay, read the resource panel, and search for those literal numbers - no
	// simulation, no frame mapping, no assumption about layout. Pausing also means
	// the values hold still while a multi-gigabyte scan runs. `recheck` then
	// filters the saved candidates against a second paused reading, and two
	// readings is normally enough to leave only the real addresses.
	if (cmd == "exact" || cmd == "recheck") {
		bool recheck = cmd == "recheck";
		int argi = 2;
		std::vector<uintptr_t> prior;
		if (recheck) {
			if (argc < 4) { fprintf(stderr, "bwfind: recheck needs <candidates.txt> <out.txt> <val>...\n"); return 1; }
			std::ifstream in(argv[argi++]);
			uintptr_t a;
			while (in >> std::hex >> a) prior.push_back(a);
			printf("loaded %zu prior candidates\n", prior.size());
		}
		if (argc < argi + 2) { fprintf(stderr, "bwfind: needs <out.txt> <value>...\n"); return 1; }
		std::string outPath = argv[argi++];
		std::vector<int32_t> wanted;
		for (int i = argi; i < argc; i++) {
			if (std::string(argv[i]) == "--all") continue;
			wanted.push_back((int32_t)atoi(argv[i]));
		}
		printf("searching for:");
		for (int32_t w : wanted) printf(" %d", w);
		printf("\n\n");

		std::ofstream out(outPath);
		std::vector<std::vector<uintptr_t>> perValue(wanted.size());
		for (size_t wi = 0; wi < wanted.size(); wi++) {
			int32_t want = wanted[wi];
			std::vector<uintptr_t> hits;
			if (recheck) {
				for (uintptr_t a : prior) {
					int32_t v = 0;
					SIZE_T got = 0;
					if (ReadProcessMemory(proc, (LPCVOID)a, &v, 4, &got) && got == 4 && v == want) hits.push_back(a);
				}
			} else {
				snapshot(proc, regions);
				for (size_t ri = 0; ri < regions.size(); ri++) {
					const auto& buf = regions[ri].data;
					for (size_t off = 0; off + 4 <= buf.size(); off += 4) {
						if (read_i32(buf, off) == want) hits.push_back(regions[ri].base + off);
					}
				}
			}
			printf("  %8d -> %zu address(es)%s\n", want, hits.size(), hits.size() <= 12 ? ":" : "");
			if (hits.size() <= 12) {
				for (uintptr_t a : hits) printf("      %s (abs 0x%llx)\n", describe_addr(a).c_str(), (unsigned long long)a);
			}
			for (uintptr_t a : hits) out << std::hex << a << "\n";
			perValue[wi] = hits;
		}

		// A player's minerals and gas live in the same record, so the right pair
		// of addresses is close together. Across thousands of coincidental hits
		// for each value individually, two of them sitting within a few dozen
		// bytes of each other is a much rarer event - usually decisive on its own.
		printf("\n  value pairs found close together (likely the same player record):\n");
		size_t pairs = 0;
		for (size_t i = 0; i < wanted.size(); i++) {
			for (size_t j = 0; j < wanted.size(); j++) {
				if (i == j) continue;
				for (uintptr_t a : perValue[i]) {
					for (uintptr_t b : perValue[j]) {
						long long delta = (long long)b - (long long)a;
						if (delta <= 0 || delta > 256) continue;
						printf("    %d at %s  +%lld->  %d    (abs 0x%llx)\n",
							wanted[i], describe_addr(a).c_str(), delta, wanted[j], (unsigned long long)a);
						if (++pairs >= 40) { printf("    ...stopping at 40\n"); i = j = wanted.size(); break; }
					}
					if (pairs >= 40) break;
				}
			}
		}
		if (!pairs) printf("    none within 256 bytes\n");
		printf("\nwrote candidates to %s\n", outPath.c_str());
		return 0;
	}
	// exactb/recheckb: same as exact/recheck but at single-byte granularity
	// (unaligned), for small packed fields - e.g. a per-player color index -
	// that an int32-aligned scan would walk straight past.
	if (cmd == "exactb" || cmd == "recheckb") {
		bool recheck = cmd == "recheckb";
		int argi = 2;
		std::vector<uintptr_t> prior;
		if (recheck) {
			if (argc < 4) { fprintf(stderr, "bwfind: recheckb needs <candidates.txt> <out.txt> <val>...\n"); return 1; }
			std::ifstream in(argv[argi++]);
			uintptr_t a;
			while (in >> std::hex >> a) prior.push_back(a);
			printf("loaded %zu prior candidates\n", prior.size());
		}
		if (argc < argi + 2) { fprintf(stderr, "bwfind: needs <out.txt> <value>...\n"); return 1; }
		std::string outPath = argv[argi++];
		std::vector<int> wanted;
		for (int i = argi; i < argc; i++) {
			if (std::string(argv[i]) == "--all") continue;
			wanted.push_back(atoi(argv[i]));
		}
		printf("searching for (byte):");
		for (int w : wanted) printf(" %d", w);
		printf("\n\n");

		std::ofstream out(outPath);
		std::vector<std::vector<uintptr_t>> perValue(wanted.size());
		for (size_t wi = 0; wi < wanted.size(); wi++) {
			uint8_t want = (uint8_t)wanted[wi];
			std::vector<uintptr_t> hits;
			if (recheck) {
				for (uintptr_t a : prior) {
					uint8_t v = 0;
					SIZE_T got = 0;
					if (ReadProcessMemory(proc, (LPCVOID)a, &v, 1, &got) && got == 1 && v == want) hits.push_back(a);
				}
			} else {
				snapshot(proc, regions);
				for (size_t ri = 0; ri < regions.size(); ri++) {
					const auto& buf = regions[ri].data;
					for (size_t off = 0; off < buf.size(); off++) {
						if (buf[off] == want) hits.push_back(regions[ri].base + off);
					}
				}
			}
			printf("  %8d -> %zu address(es)\n", (int)want, hits.size());
			for (uintptr_t a : hits) out << std::hex << a << "\n";
			perValue[wi] = hits;
		}
		printf("\nwrote candidates to %s\n", outPath.c_str());
		return 0;
	}
	// xref: find code that references a target address via x64 RIP-relative
	// addressing (the normal way compiled code touches a global/static
	// variable). Purely a read of the executable's code bytes - no debugger, no
	// thread suspension, no execution control, nothing that can affect the
	// running game. For a RIP-relative operand, the encoded 4-byte displacement
	// satisfies target == (address right after the displacement) + disp, so a
	// hit is found by searching for the raw bytes of (target - pos - 4) at each
	// position pos, then checking that pos is preceded by a byte pattern that
	// looks like a real instruction (a ModRM byte selecting RIP-relative mode:
	// top two bits 00, low three bits 101) rather than a coincidental value
	// inside some unrelated data blob.
	// codebytes: raw hex dump of code bytes at an address, for hand disassembly.
	// Read-only, same as everything else here.
	if (cmd == "codebytes") {
		if (argc < 3) { fprintf(stderr, "bwfind: codebytes needs <addr-hex> [n]\n"); return 1; }
		uintptr_t addr = (uintptr_t)strtoull(argv[2], nullptr, 16);
		int n = argc > 3 ? atoi(argv[3]) : 128;
		std::vector<uint8_t> buf(n);
		SIZE_T got = 0;
		if (!ReadProcessMemory(proc, (LPCVOID)addr, buf.data(), n, &got)) {
			fprintf(stderr, "bwfind: read failed at 0x%llx (%lu)\n", (unsigned long long)addr, GetLastError());
			return 1;
		}
		for (int i = 0; i < n; i += 16) {
			printf("  %s +0x%03x:", describe_addr(addr + i).c_str(), i);
			for (int j = i; j < i + 16 && j < n; j++) printf(" %02x", buf[j]);
			printf("\n");
		}
		return 0;
	}
	if (cmd == "xref") {
		if (argc < 3) { fprintf(stderr, "bwfind: xref needs <target-addr-hex> [range-bytes] [--all]\n"); return 1; }
		uintptr_t target = (uintptr_t)strtoull(argv[2], nullptr, 16);
		size_t range = (argc > 3 && std::string(argv[3]) != "--all") ? (size_t)strtoull(argv[3], nullptr, 0) : 1;
		auto code = module_executable_sections(proc, moduleBase);
		size_t codeBytes = 0;
		for (auto& r : code) codeBytes += r.size;
		printf("scanning %zu executable section(s) (%.1f MB) for RIP-relative references to 0x%llx\n",
			code.size(), codeBytes / 1048576.0, (unsigned long long)target);
		snapshot(proc, code);
		int found = 0;
		for (auto& r : code) {
			const auto& buf = r.data;
			for (size_t pos = 0; pos + 4 <= buf.size(); pos++) {
				// Two possible instruction shapes: displacement is the last four
				// bytes (most instructions), or one more immediate byte follows the
				// displacement (e.g. MOV r/m8, imm8; CMP r/m8, imm8).
				if (pos < 1) continue;
				uint8_t modrm = buf[pos - 1];
				if ((modrm & 0xC7) != 0x05) continue; // not RIP-relative addressing
				for (int trailingImm = 0; trailingImm <= 1; trailingImm++) {
					uintptr_t instrEnd = r.base + pos + 4 + trailingImm;
					int32_t disp = read_i32(buf, pos);
					uintptr_t computedTarget = instrEnd + (intptr_t)disp;
					if (computedTarget < target || computedTarget >= target + range) continue;
					size_t ctxStart = (pos >= 9) ? pos - 9 : 0;
					printf("  disp@%s (abs 0x%llx) -> target 0x%llx (+0x%llx) : bytes:",
						describe_addr(r.base + pos).c_str(), (unsigned long long)(r.base + pos),
						(unsigned long long)computedTarget, (unsigned long long)(computedTarget - target));
					for (size_t k = ctxStart; k < pos + 4 + (size_t)trailingImm + 2 && k < buf.size(); k++) {
						if (k == ctxStart + (pos - ctxStart)) printf(" |"); // mark ModRM/disp boundary
						printf(" %02x", buf[k]);
					}
					printf("\n");
					if (++found >= 100) { printf("  ...stopping at 100\n"); goto xref_done; }
				}
			}
		}
	xref_done:
		if (!found) printf("  no references found\n");
		return 0;
	}
	// ptr: find 64-bit pointers to a target address.
	//
	// The resource arrays live on the heap, so their address changes every launch
	// and can't be hardcoded. What can be hardcoded is a pointer to them held at a
	// fixed module offset - so this searches for anything holding the target
	// address, or an address slightly below it (a pointer to the start of the
	// enclosing structure, with the arrays at some offset inside).
	if (cmd == "ptr") {
		if (argc < 3) { fprintf(stderr, "bwfind: ptr needs <target-addr-hex> [--all]\n"); return 1; }
		uint64_t target = strtoull(argv[2], nullptr, 16);
		const uint64_t kBack = 0x2000; // also accept pointers to just before the target
		printf("searching for pointers to 0x%llx (or up to 0x%llx bytes before it)\n\n",
			(unsigned long long)target, (unsigned long long)kBack);
		snapshot(proc, regions);
		size_t found = 0;
		for (size_t ri = 0; ri < regions.size(); ri++) {
			const auto& buf = regions[ri].data;
			for (size_t off = 0; off + 8 <= buf.size(); off += 8) {
				uint64_t v;
				memcpy(&v, buf.data() + off, 8);
				if (v > target || v + kBack < target) continue;
				uintptr_t at = regions[ri].base + off;
				printf("  %-24s abs 0x%llx  ->  0x%llx  (target is +0x%llx inside)\n",
					describe_addr(at).c_str(), (unsigned long long)at,
					(unsigned long long)v, (unsigned long long)(target - v));
				if (++found >= 40) { printf("  ...stopping at 40\n"); return 0; }
			}
		}
		if (!found) printf("  none found%s\n", regions.size() < 5 ? " - try --all" : "");
		return 0;
	}
	// unitlist: read the unit array directly, using the layout established in
	// OFFSET_DISCOVERY.md. Given any address that sits on the array's 488-byte
	// lattice, walk outwards and print every populated record. This is the actual
	// live read the overlay will do, in miniature - if this output matches what
	// the game is showing, the layout is right.
	if (cmd == "unitlist") {
		if (argc < 3) { fprintf(stderr, "bwfind: unitlist needs <a-record-addr-hex> [slots-each-way]\n"); return 1; }
		uintptr_t anchor = (uintptr_t)strtoull(argv[2], nullptr, 16);
		int reach = argc >= 4 && isdigit((unsigned char)argv[3][0]) ? atoi(argv[3]) : 2000;
		const size_t kUnitSize = 488;
		printf("walking the 488-byte lattice around 0x%llx\n\n", (unsigned long long)anchor);
		printf("  %-14s %5s %5s %6s %6s %7s   %s\n", "address", "owner", "type", "x", "y", "hp", "note");

		int live = 0;
		std::map<int, int> perOwner;
		for (int k = -reach; k <= reach; k++) {
			uintptr_t rec = anchor + (intptr_t)k * (intptr_t)kUnitSize;
			uint8_t buf[488];
			SIZE_T got = 0;
			if (!ReadProcessMemory(proc, (LPCVOID)rec, buf, sizeof(buf), &got) || got != sizeof(buf)) continue;
			int32_t hp, owner, type;
			int16_t x, y;
			memcpy(&hp, buf + 0x10, 4);
			memcpy(&owner, buf + 0x68, 1); owner &= 0xff; // owner is a byte at +0x68 (verified: 1 for DragOn, 3 for Artosis)
			memcpy(&type, buf + 0x8c, 4);
			memcpy(&x, buf + 0x20, 2);
			memcpy(&y, buf + 0x22, 2);
			if (type < 0 || type > 227) continue;
			if (owner < 0 || owner > 11) continue;
			if (hp <= 0 || hp > 30000 * 256) continue;
			if (x <= 0 || y <= 0 || x > 8192 || y > 8192) continue;
			live++;
			perOwner[owner]++;
			if (live <= 40) {
				printf("  0x%llx %5d %5d %6d %6d %7.0f\n",
					(unsigned long long)rec, owner, type, x, y, hp / 256.0);
			}
		}
		printf("\n  %d populated records\n", live);
		for (auto& [o, n] : perOwner) printf("    owner %d: %d units\n", o, n);
		return 0;
	}
	// unitwalk: enumerate units by following the linked list, not by assuming a
	// contiguous array.
	//
	// Walking a 488-byte lattice only found 18 of the units actually in the game,
	// so the records are not one flat array - they are individually allocated
	// objects that the allocator often places 488 apart, which is what made the
	// stride look real. Every record starts with prev/next pointers though, which
	// is how BW itself iterates units, so following those finds all of them
	// wherever they live.
	if (cmd == "unitwalk") {
		if (argc < 3) { fprintf(stderr, "bwfind: unitwalk needs <a-record-addr-hex>\n"); return 1; }
		uintptr_t start = (uintptr_t)strtoull(argv[2], nullptr, 16);
		auto readRec = [&](uintptr_t a, uint8_t* buf) {
			SIZE_T got = 0;
			return ReadProcessMemory(proc, (LPCVOID)a, buf, 488, &got) && got == 488;
		};
		uint8_t buf[488];

		// Rewind to the head of the list first.
		uintptr_t cur = start;
		std::unordered_set<uintptr_t> guard;
		for (int i = 0; i < 5000 && readRec(cur, buf); i++) {
			uintptr_t prev;
			memcpy(&prev, buf + 0x00, 8);
			if (!prev || !guard.insert(prev).second) break;
			uint8_t probe[488];
			if (!readRec(prev, probe)) break;
			cur = prev;
		}
		printf("list head appears to be 0x%llx\n\n", (unsigned long long)cur);
		printf("  %-16s %5s %5s %6s %6s %8s %8s\n", "address", "owner", "type", "x", "y", "hp", "shields");

		std::unordered_set<uintptr_t> seen;
		std::map<int, int> perOwner;
		std::map<int, int> perType;
		int n = 0;
		while (cur && seen.insert(cur).second && n < 3000) {
			if (!readRec(cur, buf)) break;
			int32_t hp, owner, type, sh;
			int16_t x, y;
			memcpy(&hp, buf + 0x10, 4);
			memcpy(&owner, buf + 0x68, 1); owner &= 0xff; // owner is a byte at +0x68 (verified: 1 for DragOn, 3 for Artosis)
			memcpy(&type, buf + 0x8c, 4);
			memcpy(&sh, buf + 0x88, 4);
			memcpy(&x, buf + 0x20, 2);
			memcpy(&y, buf + 0x22, 2);
			if (type >= 0 && type <= 227 && owner >= 0 && owner <= 11) {
				n++;
				perOwner[owner]++;
				perType[type]++;
				if (n <= 3000) {
					printf("  0x%llx %5d %5d %6d %6d %8.0f %8.0f\n",
						(unsigned long long)cur, owner, type, x, y, hp / 256.0, sh / 256.0);
				}
			}
			uintptr_t next;
			memcpy(&next, buf + 0x08, 8);
			cur = next;
		}
		printf("\n  walked %zu records, %d looked like units\n", seen.size(), n);
		for (auto& [o, c] : perOwner) printf("    owner %d: %d\n", o, c);
		printf("  most common types:");
		std::vector<std::pair<int, int>> types(perType.begin(), perType.end());
		std::sort(types.begin(), types.end(), [](auto& a, auto& b) { return a.second > b.second; });
		for (size_t i = 0; i < types.size() && i < 8; i++) printf("  %d x%d", types[i].first, types[i].second);
		printf("\n");
		return 0;
	}
	// diff: byte-level comparison of two unit records.
	//
	// Every field found so far came from comparing two records, but comparing
	// different unit TYPES tangles type differences up with state differences -
	// a Robotics Support Bay differs from a Gateway in dozens of ways that have
	// nothing to do with researching. The useful comparison is same type, different
	// state: two Gateways where one is training, or one building photographed
	// before and after it finishes. This prints exactly the bytes that differ, so
	// there is nothing to eyeball.
	if (cmd == "diff") {
		if (argc < 4) { fprintf(stderr, "bwfind: diff needs <addr-a-hex> <addr-b-hex>\n"); return 1; }
		uintptr_t a = (uintptr_t)strtoull(argv[2], nullptr, 16);
		uintptr_t b = (uintptr_t)strtoull(argv[3], nullptr, 16);
		uint8_t bufA[488], bufB[488];
		SIZE_T got = 0;
		if (!ReadProcessMemory(proc, (LPCVOID)a, bufA, 488, &got) || got != 488 ||
			!ReadProcessMemory(proc, (LPCVOID)b, bufB, 488, &got) || got != 488) {
			fprintf(stderr, "bwfind: read failed\n");
			return 1;
		}
		printf("diff 0x%llx vs 0x%llx (488 bytes)\n\n", (unsigned long long)a, (unsigned long long)b);
		printf("  %-8s %6s %6s   %s\n", "offset", "A", "B", "note");
		int n = 0;
		for (int off = 0; off < 488; off++) {
			if (bufA[off] == bufB[off]) continue;
			// Pointers differ for every unit and are pure noise here, so label the
			// known pointer slots rather than listing eight useless bytes each.
			const char* note = "";
			if (off < 0x10 || (off >= 0x18 && off < 0x20) || (off >= 0x90 && off < 0xa0)) note = "(pointer - ignore)";
			printf("  +0x%03x   %6u %6u   %s\n", off, bufA[off], bufB[off], note);
			if (++n >= 80) { printf("  ...stopping at 80 differing bytes\n"); break; }
		}
		if (!n) printf("  identical\n");
		return 0;
	}
	// overlay: the production reader. Emits one JSON line per tick in the contract
	// the overlay consumes (LIVE_PRODUCTION_PLAN.md section 4), read entirely from
	// the game's memory.
	//
	// Health is reported rather than assumed. Supply is reconciled every tick
	// against the game's own arrays, and `healthy` only goes false after several
	// CONSECUTIVE failures - a measured ~14% of ticks disagree transiently while
	// units are dying or spawning, so hiding on a single failure would flicker the
	// overlay off during every fight.
	if (cmd == "overlay") {
		if (argc < 5) {
			fprintf(stderr, "bwfind: overlay needs <unit-costs.csv> <upgrade-costs.csv> <resource-base-hex> [--tick-ms n]\n");
			return 1;
		}
		int supplyReq[256] = {}, buildTime[256] = {}, isBuilding[256] = {}, isWorker[256] = {};
		{
			std::ifstream f(argv[2]);
			std::string line;
			while (std::getline(f, line)) {
				if (line.empty() || !isdigit((unsigned char)line[0])) continue;
				std::stringstream ss(line); std::string c; std::vector<int> v;
				while (std::getline(ss, c, ',')) v.push_back(atoi(c.c_str()));
				if (v.size() >= 8 && v[0] >= 0 && v[0] < 256) {
					supplyReq[v[0]] = v[1]; buildTime[v[0]] = v[3];
					isBuilding[v[0]] = v[6]; isWorker[v[0]] = v[7];
				}
			}
		}
		int upTimeBase[64] = {}, upTimeFactor[64] = {}, techTime[64] = {}, upIcon[64] = {}, techIcon[64] = {};
		{
			std::ifstream f(argv[3]);
			std::string line;
			while (std::getline(f, line)) {
				if (line.rfind("upgrade,", 0) != 0 && line.rfind("tech,", 0) != 0) continue;
				std::stringstream ss(line); std::string kind, a, b, c, d;
				std::getline(ss, kind, ','); std::getline(ss, a, ','); std::getline(ss, b, ','); std::getline(ss, c, ','); std::getline(ss, d, ',');
				int id = atoi(a.c_str());
				if (id < 0 || id >= 64) continue;
				if (kind == "upgrade") { upTimeBase[id] = atoi(b.c_str()); upTimeFactor[id] = atoi(c.c_str()); upIcon[id] = atoi(d.c_str()); }
				else { techTime[id] = atoi(b.c_str()); techIcon[id] = atoi(d.c_str()); }
			}
		}
		// "auto" (the default) discovers the resource base at runtime. It is heap
		// allocated, so it changes every time StarCraft restarts - a hardcoded value
		// works until the game is relaunched and then silently reads nothing, which
		// is exactly what happened the first time this met a real live game.
		// The resource arrays turn out to be module-relative after all, at
		// module+0xecdfd0 - 0x1b0 before the supply block, part of the same
		// contiguous player-data region. Earlier discovery kept landing on a heap
		// copy because the scan walks heap regions first.
		//
		// Seed with the module address and let the existing validation fall back to
		// a scan if it ever fails, so a wrong constant degrades to slow rather than
		// broken.
		bool autoResBase = std::string(argv[4]) == "auto";
		uintptr_t resBase = autoResBase ? (g_moduleBase + 0xecdfd0) : (uintptr_t)strtoull(argv[4], nullptr, 16);
		int tickMs = 100;
		for (int i = 5; i < argc; i++)
			if (std::string(argv[i]) == "--tick-ms" && i + 1 < argc) tickMs = atoi(argv[i + 1]);

		uintptr_t supplyBase = g_moduleBase + 0xece180;
		uintptr_t frameAddr = g_moduleBase + 0xdd60a8;
		uintptr_t visHeadPtr = g_moduleBase + 0xe77fc8;
		// Player names: BW's classic 36-byte player struct, with the name inside it.
		// Found by searching memory for a known in-game name and measuring the gap
		// between the two players (0x24). A live game has no replay file to read
		// names from, so they have to come from memory like everything else.
		uintptr_t nameBase = g_moduleBase + 0x109591c;
		const int kPlayerStride = 36;

		auto rd = [&](uintptr_t a, void* d, size_t n) {
			SIZE_T got = 0;
			return ReadProcessMemory(proc, (LPCVOID)a, d, n, &got) && got == n;
		};

		struct Rec {
			int owner, type, remaining, upgrade, tech, level, researchTime, queueActive;
			bool completed, isBld;
			uintptr_t addr;
			int queued[5];
		};
		std::vector<Rec> recs;
		std::unordered_set<uintptr_t> seenAddr;

		auto walk = [&](uintptr_t from) {
			uint8_t b[488];
			uintptr_t cur = from;
			std::unordered_set<uintptr_t> local;
			while (cur && local.insert(cur).second && recs.size() < 3000) {
				if (!rd(cur, b, 488)) break;
				uint16_t type, remaining, rtime;
				memcpy(&type, b + 0x8c, 2);
				memcpy(&remaining, b + 0xf0, 2);
				memcpy(&rtime, b + 0x112, 2);
				uint8_t owner = b[0x68];
				if (type <= 227 && owner <= 11 && seenAddr.insert(cur).second) {
					Rec r{};
					r.owner = owner; r.type = type; r.remaining = remaining;
					r.completed = (b[0x140] & 1) != 0;
					r.isBld = isBuilding[type] != 0;
					r.addr = cur;
					r.tech = (b[0x114] <= 43) ? b[0x114] : -1;      // 44 = none
					r.upgrade = (b[0x115] <= 60) ? b[0x115] : -1;   // 61 = none
					r.level = b[0x119];
					r.researchTime = (rtime == 0xffff) ? -1 : rtime;
					int slot = b[0xe8] & 0x7;
					r.queueActive = -1;
					for (int s = 0; s < 5; s++) {
						uint16_t e; memcpy(&e, b + 0xdc + s * 2, 2);
						r.queued[s] = (e <= 227) ? (int)e : -1;
					}
					if (slot < 5) r.queueActive = r.queued[slot];
					recs.push_back(r);
				}
				memcpy(&cur, b + 0x08, 8);
			}
		};

		// Finds the resource block by its shape rather than a remembered address.
		// The layout is minerals[12], gas[12], gasGathered[12], mineralsGathered[12]
		// at +0x00/+0x30/+0x60/+0x90, and the giveaway is what the EMPTY slots hold:
		// exactly 50 minerals (players keep their starting minerals) with zero gas
		// and zero gathered. Ten slots matching that pattern around two live ones is
		// not something that occurs by accident.
		auto findResourceBase = [&](const std::vector<int>& activeSlots) -> uintptr_t {
			auto heap = heap_regions(proc);
			std::vector<uint8_t> data;
			std::vector<uintptr_t> candidates;
			bool active[12] = {};
			for (int s : activeSlots) if (s >= 0 && s < 12) active[s] = true;
			for (auto& r : heap) {
				data.resize(r.size);
				SIZE_T got = 0;
				if (!ReadProcessMemory(proc, (LPCVOID)r.base, data.data(), r.size, &got) || got != r.size) continue;
				for (size_t off = 0; off + 0xc0 <= data.size(); off += 4) {
					const int32_t* m = (const int32_t*)(data.data() + off);
					const int32_t* g = (const int32_t*)(data.data() + off + 0x30);
					const int32_t* gg = (const int32_t*)(data.data() + off + 0x60);
					const int32_t* mg = (const int32_t*)(data.data() + off + 0x90);
					// Relationships that hold in any game, rather than the "empty slots
					// contain exactly 50 minerals" convention seen in replays - that
					// one does not survive a live lobby with an observer slot, and
					// requiring it made discovery fail on the first real game.
					//   - a slot with no player has gathered nothing
					//   - a slot with a player has gathered something, and cannot be
					//     holding more than it ever gathered
					bool ok = true;
					int liveSeen = 0;
					for (int s = 0; s < 12 && ok; s++) {
						if (m[s] < 0 || m[s] > 10000000 || g[s] < 0 || g[s] > 10000000) ok = false;
						else if (gg[s] < 0 || mg[s] < 0 || gg[s] > 10000000 || mg[s] > 10000000) ok = false;
						else if (s == 11) continue;               // neutral owns the map's resources
						else if (!active[s]) { if (gg[s] || mg[s]) ok = false; }
						else if (mg[s] <= 0 || m[s] > mg[s] || g[s] > gg[s]) ok = false;
						else liveSeen++;
					}
					// One live slot is enough: by the end of a game the loser has no
					// units left, and requiring two meant discovery stopped working
					// exactly when a game was being decided.
					if (ok && liveSeen >= 1) candidates.push_back(r.base + off);
				}
			}

			// Static checks alone are not enough: a window of zeros satisfies
			// "current <= gathered" trivially, and the first attempt latched onto
			// exactly that and reported 0 minerals for both players all game. The
			// real arrays MOVE - workers deliver constantly - so require the
			// cumulative totals to actually increase before accepting a candidate.
			fprintf(stderr, "[overlay] %zu resource-array candidates; watching for change\n", candidates.size());
			// Two conditions, because "gathered increases" alone is satisfied by a
			// window shifted back by 0x30 - its +0x90 lands on gas gathered, which
			// also only climbs, while its +0x00 lands on zeros. That is precisely
			// what the first version locked onto, reporting 0 minerals all game. So
			// also require the CURRENT minerals to be a real, non-zero figure.
			std::vector<int32_t> before(candidates.size() * 12);
			for (size_t i = 0; i < candidates.size(); i++) rd(candidates[i] + 0x90, &before[i * 12], 48);
			std::this_thread::sleep_for(std::chrono::milliseconds(1200));
			for (size_t i = 0; i < candidates.size(); i++) {
				int32_t after[12], cur[12];
				if (!rd(candidates[i] + 0x90, after, 48)) continue;
				if (!rd(candidates[i] + 0x00, cur, 48)) continue;
				bool gathersMore = false, holdsMinerals = false;
				for (int s : activeSlots) {
					if (s < 0 || s >= 12) continue;
					if (after[s] > before[i * 12 + s]) gathersMore = true;
					if (cur[s] > 0) holdsMinerals = true;
				}
				if (gathersMore && holdsMinerals) return candidates[i];
			}
			return 0;
		};

		printf("{\"schema\":1,\"status\":\"waiting for a game\"}\n");
		int consecutiveBad = 0;
		bool announced = false;
		uint64_t lastSignature = 0;
		int stillTicks = 0;
		for (;;) {
			// Game detection is based on whether the unit lists hold units, NOT on the
			// frame counter. The counter at module+0xdd60a8 was found by watching a
			// replay and reads -1 whenever one is not playing - which appears to
			// include live games, where it would otherwise gate the reader off
			// permanently. The unit lists are module-relative and populated in any
			// game, so they are the reliable signal; the frame is used for the clock
			// and the torn-read check when it happens to be available.
			int32_t frame = 0;
			rd(frameAddr, &frame, 4);
			bool haveFrame = frame >= 0;
			// Retry a torn walk a couple of times, then accept it. Discarding every
			// tick that spanned a frame boundary is fine at ~250 units but starves
			// the feed entirely in a big team game: the walk does one read per unit,
			// and with up to 1700 units it can easily exceed a 42ms frame, so a
			// strict check would reject every tick and the overlay would never
			// update. A walk spanning one frame is a few pixels of staleness, which
			// no viewer can see; a feed that never updates is obvious.
			int32_t frameAfter = 0;
			bool clean = false;
			for (int attempt = 0; attempt < 3 && !clean; attempt++) {
				uint64_t vh = 0, hh = 0;
				rd(visHeadPtr, &vh, 8);
				rd(visHeadPtr + 0x20, &hh, 8);
				recs.clear(); seenAddr.clear();
				if (vh > 0x10000) walk((uintptr_t)vh);
				if (hh > 0x10000) walk((uintptr_t)hh);
				rd(frameAddr, &frameAfter, 4);
				clean = !haveFrame || (frameAfter == frame);
				if (!clean) frame = frameAfter; // re-baseline and try once more
			}

			// No units in either list means no game is loaded.
			int playerUnits = 0;
			for (auto& r : recs) if (r.owner != 11) playerUnits++;
			if (playerUnits < 2) {
				printf("{\"schema\":1,\"status\":\"no game\",\"healthy\":false}\n");
				announced = false;
				stillTicks = 0;
				std::this_thread::sleep_for(std::chrono::milliseconds(500));
				continue;
			}

			// A finished game leaves its units in memory, so "units exist" stays true
			// at the score screen and the overlay would sit there showing the final
			// state until a new game loaded. A game that is actually running never
			// stops changing - workers deliver constantly and build timers tick - so
			// a state that is completely static means the game is over (or paused,
			// which for a broadcast overlay is the same thing: stop showing it).
			uint64_t signature = (uint64_t)playerUnits * 1000003u;
			for (auto& r : recs) signature += (uint64_t)r.remaining * 31 + r.type;
			if (signature == lastSignature) stillTicks++; else stillTicks = 0;
			lastSignature = signature;
			if (stillTicks > (4000 / (tickMs > 0 ? tickMs : 100))) {   // ~4 seconds unchanged
				printf("{\"schema\":1,\"status\":\"game over\",\"healthy\":false}\n");
				announced = false;
				std::this_thread::sleep_for(std::chrono::milliseconds(500));
				continue;
			}

			// One line per game describing what was actually found, so a failure in
			// the field says which step broke instead of just showing an empty
			// overlay. Goes to stderr, which the dashboard surfaces in its log.
			if (!announced) {
				announced = true;
				uint64_t vh = 0, hh = 0;
				rd(visHeadPtr, &vh, 8);
				rd(visHeadPtr + 0x20, &hh, 8);
				int owners[12] = {};
				for (auto& r : recs) if (r.owner < 12) owners[r.owner]++;
				fprintf(stderr, "[overlay] game at frame %d | visible head 0x%llx | hidden head 0x%llx | %zu units\n",
					frame, (unsigned long long)vh, (unsigned long long)hh, recs.size());
				fprintf(stderr, "[overlay] units per slot:");
				for (int s = 0; s < 12; s++) if (owners[s]) fprintf(stderr, " slot%d=%d", s, owners[s]);
				fprintf(stderr, "\n");
			}

			// Discovery needs to know which slots are in play, which comes from the
			// unit walk above - so it happens here rather than at startup. Redone
			// whenever the base stops looking valid, which covers a new game being
			// loaded without restarting the scanner.
			bool baseLooksValid = false;
			if (resBase) {
				int32_t probe[12];
				if (rd(resBase, probe, 48)) {
					baseLooksValid = true;
					for (int s = 0; s < 12; s++) if (probe[s] < 0 || probe[s] > 1000000) baseLooksValid = false;
				}
			}
			if (!baseLooksValid && autoResBase) {
				std::vector<int> activeSlots;
				bool seen[12] = {};
				for (auto& r : recs) if (r.owner < 12 && !seen[r.owner]) { seen[r.owner] = true; if (r.owner != 11) activeSlots.push_back(r.owner); }
				if (!activeSlots.empty()) {
					uintptr_t found = findResourceBase(activeSlots);
					if (found) {
						resBase = found;
						fprintf(stderr, "[overlay] resource base found at 0x%llx\n", (unsigned long long)found);
					}
				}
				if (!resBase) {
					printf("{\"schema\":1,\"status\":\"locating resource arrays\",\"healthy\":false}\n");
					std::this_thread::sleep_for(std::chrono::milliseconds(1000));
					continue;
				}
			}

			int32_t minerals[12], gas[12];
			int32_t supUsed[3][12] = {}, supProv[3][12] = {};
			rd(resBase + 0x00, minerals, 48);
			rd(resBase + 0x30, gas, 48);
			for (int r = 0; r < 3; r++) {
				rd(supplyBase + r * 0x90 + 0x00, supProv[r], 48);
				rd(supplyBase + r * 0x90 + 0x30, supUsed[r], 48);
			}

			// Judge the health check by SIZE of disagreement, not exact equality.
			// A live game has no usable frame counter, so a walk that spans the game
			// mutating cannot be detected and discarded the way it can in a replay -
			// units get created and destroyed mid-walk and the totals come out a
			// couple of supply off. Demanding exactness meant those normal artifacts
			// accumulated and tripped the gate every few seconds, fading the overlay
			// in and out. Losing the structure entirely looks completely different:
			// computed collapses to zero against a real total.
			int computed[12] = {};
			for (auto& r : recs) computed[r.owner] += supplyReq[r.type];
			int worstDrift = 0, largestSupply = 0;
			for (int s = 0; s < 12; s++) {
				int actual = supUsed[0][s] + supUsed[1][s] + supUsed[2][s];
				if (!actual && !computed[s]) continue;
				worstDrift = std::max(worstDrift, abs(actual - computed[s]));
				largestSupply = std::max(largestSupply, actual);
			}
			// Proportional, because churn scales with the size of the game: more units
			// means more of them changing during a walk. A fixed threshold that suited
			// the opening tripped repeatedly later on. A lost structure does not scale
			// this way - computed collapses toward zero, so the drift approaches the
			// player's entire supply and blows past any proportional bound.
			bool ok = worstDrift <= 12 + largestSupply / 8;
			// A walk that spanned a frame boundary will disagree on supply for
			// uninteresting reasons, so it must not count toward the health gate.
			if (clean) consecutiveBad = ok ? 0 : consecutiveBad + 1;
			bool healthy = consecutiveBad < 10;

			int secs = haveFrame ? (int)(frame * 42.0 / 1000.0) : 0;
			printf("{\"schema\":1,\"frame\":%d,\"clock\":\"%d:%02d\",\"source\":\"memory\",\"healthy\":%s,\"supplyDrift\":%d,\"players\":[",
				frame, secs / 60, secs % 60, healthy ? "true" : "false", worstDrift);

			bool firstPlayer = true;
			for (int slot = 0; slot < 12; slot++) {
				int used = supUsed[0][slot] + supUsed[1][slot] + supUsed[2][slot];
				int prov = supProv[0][slot] + supProv[1][slot] + supProv[2][slot];
				bool any = false;
				for (auto& r : recs) if (r.owner == slot) { any = true; break; }
				if (!any || slot == 11) continue;
				if (!firstPlayer) printf(",");
				firstPlayer = false;

				int workers = 0;
				double army = 0;
				for (auto& r : recs) {
					if (r.owner != slot || !r.completed) continue;
					if (isWorker[r.type]) workers++;
					else if (!r.isBld) army += supplyReq[r.type] / 2.0;
				}
				// supply is stored doubled, and the game caps the DISPLAYED maximum
				// at 200 even when more has been built
				char nameRaw[26] = {};
				rd(nameBase + (uintptr_t)slot * kPlayerStride, nameRaw, 25);
				nameRaw[25] = 0;
				// race and team sit immediately before the name in the player struct.
				// Established on a 2v2: the byte at name-1 split exactly 2-2 across the
				// four slots, which is what a team assignment does and very little else
				// does, and name-2 read 0 (zerg) for both players whose names say so.
				uint8_t raceByte = 0, teamByte = 0;
				rd(nameBase + (uintptr_t)slot * kPlayerStride - 2, &raceByte, 1);
				rd(nameBase + (uintptr_t)slot * kPlayerStride - 1, &teamByte, 1);
				printf("{\"slot\":%d,\"race\":%u,\"team\":%u,\"name\":\"", slot, raceByte, teamByte);
				for (unsigned char* p = (unsigned char*)nameRaw; *p; ++p) {
					// Names can be any bytes at all, including Korean text, so escape
					// what would break the JSON and pass the rest through.
					if (*p == '"' || *p == '\\') printf("\\%c", *p);
					else if (*p < 0x20) printf("\\u%04x", *p);
					else putchar(*p);
				}
				printf("\",\"minerals\":%d,\"gas\":%d,\"supplyUsed\":%.0f,\"supplyMax\":%.0f,\"workers\":%d,\"armySupply\":%.0f,\"production\":[",
					minerals[slot], gas[slot], used / 2.0,
					std::min(prov / 2.0, 200.0), workers, army);

				bool firstItem = true;
				// `icon` is the cmdicons index the overlay loads. Units use their type
				// id directly (verified: cmdicons 64 is the Probe); upgrades and techs
				// carry their own index in the .dat files.
				auto item = [&](const char* kind, int id, int remaining, int total, int producer, int level, int icon) {
					if (!firstItem) printf(",");
					firstItem = false;
					double p = total > 0 ? 1.0 - (double)remaining / (double)total : 0.0;
					p = std::max(0.0, std::min(1.0, p));
					printf("{\"kind\":\"%s\",\"id\":%d,\"icon\":%d,\"progress\":%.4f,\"remainingFrames\":%d,\"totalFrames\":%d,\"producer\":%d",
						kind, id, icon, p, remaining, total, producer);
					if (level) printf(",\"level\":%d", level);
					printf("}");
				};
				for (auto& r : recs) {
					if (r.owner != slot) continue;
					int producer = (int)(r.addr & 0x7fffffff);
					if (!r.completed) {
						// A Zerg egg or cocoon is a unit type with no build time of its
						// own; what matters is what is hatching, which sits in the queue
						// field. "Egg" tells a caster nothing, and it was reporting four
						// of them with a 1-frame total.
						int shown = r.type;
						if (!r.isBld && r.queueActive >= 0 && buildTime[r.type] <= 1) shown = r.queueActive;
						int total = buildTime[shown] > 1 ? buildTime[shown] : r.remaining;
						item(isBuilding[shown] ? "building" : "unit", shown, r.remaining, total, producer, 0, shown);
					} else if (r.isBld) {
						// ONLY buildings. +0x112..+0x119 is BW's building union; on a
						// worker or a fighting unit those same bytes hold unrelated
						// data, which read as "upgrade 0 (Terran Infantry Armor),
						// level 64" - every unit in the game reporting a nearly
						// finished armour upgrade, with the type id landing in the
						// level field.
						if (r.upgrade >= 0 && r.researchTime >= 0) {
							int lvl = (r.level >= 1 && r.level <= 3) ? r.level : 1;
							int total = upTimeBase[r.upgrade] + upTimeFactor[r.upgrade] * (lvl - 1);
							item("upgrade", r.upgrade, r.researchTime, total, producer, lvl, upIcon[r.upgrade]);
						} else if (r.tech >= 0 && r.researchTime >= 0) {
							item("tech", r.tech, r.researchTime, techTime[r.tech], producer, 0, techIcon[r.tech]);
						}
					}
				}
				printf("],\"queued\":[");
				bool firstQ = true;
				for (auto& r : recs) {
					// Build queues are part of the same building union, so the same
					// restriction applies.
					if (r.owner != slot || !r.completed || !r.isBld) continue;
					for (int s = 0; s < 5; s++) {
						if (r.queued[s] < 0 || r.queued[s] == r.queueActive) continue;
						if (!firstQ) printf(",");
						firstQ = false;
						printf("{\"kind\":\"unit\",\"id\":%d,\"icon\":%d,\"producer\":%d}", r.queued[s], r.queued[s], (int)(r.addr & 0x7fffffff));
					}
				}
				printf("]}");
			}
			printf("]}\n");
			std::this_thread::sleep_for(std::chrono::milliseconds(tickMs));
		}
		return 0;
	}

	// log: the actual live reader, run as a verification harness.
	//
	// Samples the game continuously and writes one JSON line per tick, while
	// checking the invariants from LIVE_PRODUCTION_PLAN.md section 7b. The
	// important one is supply reconciliation: sum the supply cost of every unit
	// found by walking the list, and compare against the game's own supply arrays,
	// which live in a completely unrelated place in memory (the module, not the
	// heap). If the walk misses units, misreads a type or mis-attributes an owner,
	// the two stop matching immediately.
	//
	// That same check doubles as anchor discovery: a candidate unit list is only
	// accepted if the supply it produces matches, which means the reader cannot
	// silently latch onto the wrong structure.
	if (cmd == "log") {
		if (argc < 5) {
			fprintf(stderr, "bwfind: log needs <unit-costs.csv> <resource-base-hex> <unit-anchor-hex> [out.jsonl]\n");
			return 1;
		}
		// per-type supply cost and build time, generated from units.dat by
		// `bwlive --dump-unit-costs`
		int supplyReq[256] = {}, buildTime[256] = {}, isBuilding[256] = {};
		{
			std::ifstream f(argv[2]);
			if (!f) { fprintf(stderr, "bwfind: cannot open %s\n", argv[2]); return 1; }
			std::string line;
			while (std::getline(f, line)) {
				if (line.empty() || !isdigit((unsigned char)line[0])) continue;
				std::stringstream ss(line);
				std::string cell;
				std::vector<int> v;
				while (std::getline(ss, cell, ',')) v.push_back(atoi(cell.c_str()));
				if (v.size() >= 7 && v[0] >= 0 && v[0] < 256) {
					supplyReq[v[0]] = v[1];
					buildTime[v[0]] = v[3];
					isBuilding[v[0]] = v[6];
				}
			}
		}
		uintptr_t resBase = (uintptr_t)strtoull(argv[3], nullptr, 16);
		uintptr_t anchor = (uintptr_t)strtoull(argv[4], nullptr, 16);
		const char* outPath = argc >= 6 ? argv[5] : "bwlog.jsonl";
		uintptr_t supplyBase = g_moduleBase + 0xece180;
		uintptr_t frameAddr = g_moduleBase + 0xdd60a8;

		auto rd = [&](uintptr_t a, void* dst, size_t n) {
			SIZE_T got = 0;
			return ReadProcessMemory(proc, (LPCVOID)a, dst, n, &got) && got == n;
		};

		// activeQueue is the type currently being trained by this building, taken from
		// the queue slot that +0xe8 points at. It matters for supply reconciliation:
		// BW reserves supply as soon as training starts, but the unit being trained is
		// NOT in the list this walk covers (it lives in BW's hidden-unit list), so
		// without adding it back the totals come up short by exactly the units in
		// production - measured as 8 half-supply for a Protoss and 6 for a Terran.
		struct UnitInfo { int owner, type; bool completed; int remaining; int activeQueue; uintptr_t addr; };
		// Walks the whole list from `from`, returning every unit found.
		auto walkUnits = [&](uintptr_t from, std::vector<UnitInfo>& out, std::vector<std::array<int, 5>>& queues,
		                     std::vector<int>& queueOwners, bool clear = true) {
			if (clear) { out.clear(); queues.clear(); queueOwners.clear(); }
			uint8_t buf[488];
			uintptr_t cur = from;
			std::unordered_set<uintptr_t> guard;
			// rewind to the head
			for (int i = 0; i < 4000 && rd(cur, buf, 488); i++) {
				uintptr_t prev;
				memcpy(&prev, buf + 0x00, 8);
				if (!prev || !guard.insert(prev).second) break;
				uint8_t probe[488];
				if (!rd(prev, probe, 488)) break;
				cur = prev;
			}
			std::unordered_set<uintptr_t> seen;
			while (cur && seen.insert(cur).second && out.size() < 3000) {
				if (!rd(cur, buf, 488)) break;
				int32_t hp; uint8_t owner; uint16_t type, remaining; uint8_t flags;
				memcpy(&hp, buf + 0x10, 4);
				owner = buf[0x68];
				memcpy(&type, buf + 0x8c, 2);
				memcpy(&remaining, buf + 0xf0, 2);
				flags = buf[0x140];
				if (type <= 227 && owner <= 11) {
					std::array<int, 5> q{};
					bool anyQueued = false;
					for (int s = 0; s < 5; s++) {
						uint16_t e;
						memcpy(&e, buf + 0xdc + s * 2, 2);
						// 228 is "None"; anything above that is garbage, not a unit
						// type. Records read out of a live game routinely contain
						// junk - a free slot mid-reuse, a torn read - so every value
						// used as an index has to be bounded. Not doing so here
						// indexed a 256-entry table with 12800 and crashed.
						q[s] = (e <= 227) ? (int)e : -1;
						if (q[s] >= 0) anyQueued = true;
					}
					int activeSlot = buf[0xe8] & 0x7;
					int activeQueue = (activeSlot < 5) ? q[activeSlot] : -1;
					out.push_back({ owner, type, (flags & 1) != 0, remaining, activeQueue, cur });
					if (anyQueued) { queues.push_back(q); queueOwners.push_back(owner); }
				}
				uintptr_t next;
				memcpy(&next, buf + 0x08, 8);
				cur = next;
			}
		};

		std::vector<UnitInfo> units;
		std::vector<std::array<int, 5>> queues;
		std::vector<int> queueOwners;

		// Validate the anchor before trusting anything: walk it and check the supply
		// it implies against the game's arrays.
		int lastSupplyError = 0;
		auto supplyMatches = [&](std::string& detail) {
			int32_t supUsed[3][12] = {};
			for (int r = 0; r < 3; r++) rd(supplyBase + r * 0x90 + 0x30, supUsed[r], 48);
			// Count every unit, not only completed ones: BW reserves supply the moment
			// a unit starts being built, and buildings have a supply cost of 0 anyway
			// so including incomplete ones cannot inflate the total.
			// Count units from both the visible and hidden lists. Units in production
			// are real incomplete units in the hidden list, and BW reserves their
			// supply, so they must be counted - but NOT also via the producing
			// building's build queue, or Terran double-counts. Terran previously
			// reconciled exactly using queue entries alone precisely because its
			// in-production units were being counted once; adding the hidden list
			// without removing the queue term would have broken the case that worked.
			// Deduplicate by record address before summing. The visible and hidden
			// lists are walked separately and overlap - a unit reachable from both
			// heads gets counted twice otherwise, which showed up as computing 10
			// supply against the game's 8 at a frame where each player had exactly
			// four workers.
			int computed[12] = {};
			std::unordered_set<uintptr_t> counted;
			for (auto& u : units) {
				if (!counted.insert(u.addr).second) continue;
				computed[u.owner] += supplyReq[u.type];
			}
			bool ok = true;
			char tmp[256];
			lastSupplyError = 0;
			for (int slot = 0; slot < 12; slot++) {
				int actual = supUsed[0][slot] + supUsed[1][slot] + supUsed[2][slot];
				if (actual == 0 && computed[slot] == 0) continue;
				snprintf(tmp, sizeof(tmp), " slot%d computed=%d game=%d", slot, computed[slot], actual);
				detail += tmp;
				lastSupplyError += abs(computed[slot] - actual);
				if (computed[slot] != actual) ok = false;
			}
			return ok;
		};

		// Wait for a game before touching anything else. The list-head globals hold
		// stale or null pointers in the lobby, so reading them early would fail the
		// anchor check for no reason. Waiting here also means the logger can be
		// started first and will catch the game from its opening frames.
		printf("waiting for a game to start (frame counter reads -1 until then)...\n");
		for (;;) {
			int32_t f = 0;
			if (rd(frameAddr, &f, 4) && f > 8) {
				printf("game detected at frame %d\n\n", f);
				break;
			}
			std::this_thread::sleep_for(std::chrono::milliseconds(200));
		}

		// The visible unit list's head is held in a module global, so the anchor can
		// be read directly instead of scanned for out of the heap - instant, and it
		// cannot go stale when a new game loads.
		if (!anchor) {
			uint64_t head = 0;
			if (rd(g_moduleBase + 0xe77fc8, &head, 8) && head > 0x10000) {
				anchor = (uintptr_t)head;
				printf("unit list head from module+0xe77fc8: 0x%llx\n", (unsigned long long)anchor);
			}
		}
		// Allows a run to proceed with a known, recorded discrepancy. Default 0: the
		// gate exists so wrong data never reaches a broadcast, but for a diagnostic
		// run a bounded, logged drift is more useful than refusing outright.
		int maxDrift = 0;
		for (int i = 6; i < argc; i++) {
			if (std::string(argv[i]) == "--max-supply-drift" && i + 1 < argc) maxDrift = atoi(argv[i + 1]);
		}

		// The hidden list, holding units currently in production. Its head sits 0x20
		// past the visible list's head in the same block of globals.
		uintptr_t hiddenHead = 0;
		{
			uint64_t h = 0;
			if (rd(g_moduleBase + 0xe77fc8 + 0x20, &h, 8) && h > 0x10000) {
				hiddenHead = (uintptr_t)h;
				printf("hidden list head from module+0xe77fe8: 0x%llx\n", (unsigned long long)hiddenHead);
			}
		}

		std::string detail;
		bool anchorOk = false;
		if (anchor) {
			// Retry across frames rather than judging on the first one. At frame 11
			// the game is still creating starting units, and a snapshot taken
			// mid-initialisation can disagree for reasons that have nothing to do
			// with the offsets being wrong.
			for (int attempt = 0; attempt < 40; attempt++) {
				walkUnits(anchor, units, queues, queueOwners);
				if (hiddenHead) walkUnits(hiddenHead, units, queues, queueOwners, false);
				detail.clear();
				if (supplyMatches(detail)) { anchorOk = true; break; }
				std::this_thread::sleep_for(std::chrono::milliseconds(400));
			}
			if (!anchorOk) {
				// Name the units we think each player has, so a persistent mismatch
				// says WHICH unit is spurious rather than just by how much.
				printf("persistent mismatch - what the walk believes each player owns:\n");
				std::map<int, std::map<int, int>> perSlot; // slot -> type -> count
				std::unordered_set<uintptr_t> seenAddr;
				for (auto& u : units) {
					if (!seenAddr.insert(u.addr).second) continue;
					if (supplyReq[u.type]) perSlot[u.owner][u.type]++;
				}
				for (auto& [slot, types] : perSlot) {
					printf("  slot %d:", slot);
					for (auto& [t, c] : types) printf("  type%d x%d (%d each)", t, c, supplyReq[t]);
					printf("\n");
				}
			}
			if (!anchorOk && lastSupplyError <= maxDrift) {
				printf("anchor check: %zu units,%s -> drift %d, within --max-supply-drift %d\n",
					units.size(), detail.c_str(), lastSupplyError, maxDrift);
				anchorOk = true;
			} else {
				printf("anchor check: %zu units,%s -> %s\n", units.size(), detail.c_str(),
					anchorOk ? "MATCH" : "MISMATCH");
			}
		}

		// Auto-discovery. Unit records are heap-allocated and move whenever a new
		// game loads, so a hardcoded anchor goes stale - as it just did. Find a
		// plausible record by signature, then walk from it and keep it only if the
		// supply it produces matches the game's arrays. That makes discovery
		// self-validating: a wrong guess cannot be accepted.
		if (!anchorOk) {
			printf("searching for a unit-list anchor...\n");
			auto heap = heap_regions(proc);
			std::vector<uintptr_t> candidates;
			uint8_t buf[488];
			// Take a few candidates from EVERY region rather than filling a global cap
			// from the first ones: heap regions are walked from low addresses up, and
			// the unit pool sits high, so a global cap never reaches it.
			for (auto& r : heap) {
				size_t fromThisRegion = 0;
				std::vector<uint8_t> data(r.size);
				SIZE_T got = 0;
				if (!ReadProcessMemory(proc, (LPCVOID)r.base, data.data(), r.size, &got) || got != r.size) continue;
				for (size_t off = 0; off + 488 <= data.size(); off += 8) {
					if (fromThisRegion >= 4) break;
					const uint8_t* p = data.data() + off;
					uint16_t type; int32_t hp; int16_t x, y;
					memcpy(&type, p + 0x8c, 2);
					memcpy(&hp, p + 0x10, 4);
					memcpy(&x, p + 0x20, 2);
					memcpy(&y, p + 0x22, 2);
					uint8_t owner = p[0x68];
					if (type > 227 || owner > 11) continue;
					if (hp <= 0 || hp > 30000 * 256) continue;
					if (x <= 0 || y <= 0 || x > 8192 || y > 8192) continue;
					if (!(p[0x140] & 1)) continue;      // completed units only
					uintptr_t prev, next;
					memcpy(&prev, p + 0x00, 8);
					memcpy(&next, p + 0x08, 8);
					if (!prev || !next) continue;        // must be linked
					candidates.push_back(r.base + off);
					fromThisRegion++;
				}
			}
			printf("  %zu candidate records; validating against the supply arrays\n", candidates.size());
			// Rank by how far off the supply is, not by unit count - a runaway walk
			// that hits the 3000 cap has the most "units" and is the worst candidate.
			size_t bestUnits = 0;
			int bestErr = INT32_MAX;
			std::string bestDetail;
			uintptr_t bestAddr = 0;
			for (size_t i = 0; i < candidates.size(); i++) {
				walkUnits(candidates[i], units, queues, queueOwners);
				if (units.size() < 8 || units.size() >= 3000) continue;
				detail.clear();
				bool match = supplyMatches(detail);
				if (lastSupplyError < bestErr) {
					bestErr = lastSupplyError; bestUnits = units.size();
					bestDetail = detail; bestAddr = candidates[i];
				}
				if (match) {
					anchor = candidates[i];
					anchorOk = true;
					printf("  anchor 0x%llx accepted: %zu units,%s\n",
						(unsigned long long)anchor, units.size(), detail.c_str());
					break;
				}
			}
			if (!anchorOk && bestAddr) {
				printf("  closest was 0x%llx with %zu units:%s\n",
					(unsigned long long)bestAddr, bestUnits, bestDetail.c_str());
			}
			(void)buf;
		}
		if (!anchorOk) {
			printf("  no anchor produced a supply figure matching the game. Refusing to log\n"
			       "  rather than record data that is already known to be wrong.\n");
			return 1;
		}

		std::ofstream out(outPath);
		printf("logging to %s - Ctrl-C to stop\n\n", outPath);
		int lastFrame = -1, ticks = 0, violations = 0;
		int32_t peakGathered[12] = {}, peakMined[12] = {};

		// Production tally, for comparison against SC:R's post-game score screen
		// (groundtruth/scorescreen-dewalt-vs-wolfix.md). Counting completions rather
		// than births: a record counts once when its completed flag is seen to turn
		// on, or when a completed unit appears at an address that previously held
		// something else. Slot reuse after a death is therefore counted correctly -
		// it genuinely is a new unit.
		std::unordered_map<uintptr_t, std::pair<int, bool>> prevUnits; // addr -> (type, completed)
		int producedUnits[12] = {}, producedBuildings[12] = {};
		bool firstTick = true;
		int initialUnits[12] = {};
		while (true) {
			int32_t frame = 0;
			if (!rd(frameAddr, &frame, 4)) break;
			if (frame == -1) { // game ended or none loaded
				if (ticks) { printf("\ngame ended at frame %d\n", lastFrame); break; }
				std::this_thread::sleep_for(std::chrono::milliseconds(500));
				continue;
			}
			if (frame == lastFrame) { std::this_thread::sleep_for(std::chrono::milliseconds(60)); continue; }

			int32_t minerals[12], gas[12], gathered[12];
			rd(resBase + 0x00, minerals, 48);
			rd(resBase + 0x30, gas, 48);
			rd(resBase + 0x60, gathered, 48);
			// Re-read both list heads every tick. They are globals BW rewrites as
			// units are created and destroyed, so a head cached at startup goes stale
			// within seconds - which is what produced 859 supply violations in 998
			// ticks after an anchor check that matched perfectly.
			{
				uint64_t vh = 0, hh = 0;
				if (rd(g_moduleBase + 0xe77fc8, &vh, 8) && vh > 0x10000) anchor = (uintptr_t)vh;
				if (rd(g_moduleBase + 0xe77fc8 + 0x20, &hh, 8) && hh > 0x10000) hiddenHead = (uintptr_t)hh;
				else hiddenHead = 0;
			}
			walkUnits(anchor, units, queues, queueOwners);
			if (hiddenHead) walkUnits(hiddenHead, units, queues, queueOwners, false);
			int32_t frameAfter = 0;
			rd(frameAddr, &frameAfter, 4);
			if (frameAfter != frame) continue; // torn read, retry

			std::string d;
			bool ok = supplyMatches(d);
			if (!ok) violations++;
			for (int i = 0; i < 12; i++) if (gathered[i] > peakGathered[i]) peakGathered[i] = gathered[i];
			{
				int32_t mined[12];
				if (rd(resBase + 0x90, mined, 48))
					for (int i = 0; i < 12; i++) if (mined[i] > peakMined[i]) peakMined[i] = mined[i];
			}

			// Count only a genuine incomplete -> complete transition at the same
			// address and type. Counting "appeared and is complete" instead
			// over-counted by an order of magnitude, because a unit that drops out of
			// a momentarily-broken walk and returns looks new every time. Every real
			// unit takes more than a second to build, so it cannot be created and
			// completed inside one tick and be missed by this.
			std::unordered_map<uintptr_t, std::pair<int, bool>> nowUnits;
			for (auto& u : units) {
				auto it = prevUnits.find(u.addr);
				bool wasIncompleteSameType = it != prevUnits.end() && it->second.first == u.type && !it->second.second;
				nowUnits[u.addr] = { u.type, u.completed };
				if (firstTick) { if (u.completed) initialUnits[u.owner]++; continue; }
				if (u.completed && wasIncompleteSameType) {
					if (isBuilding[u.type]) producedBuildings[u.owner]++;
					else producedUnits[u.owner]++;
				}
			}
			prevUnits.swap(nowUnits);
			firstTick = false;

			out << "{\"frame\":" << frame << ",\"units\":" << units.size()
			    << ",\"supplyOk\":" << (ok ? "true" : "false") << ",\"players\":[";
			bool first = true;
			for (int slot = 0; slot < 12; slot++) {
				if (!minerals[slot] && !gathered[slot]) continue;
				if (!first) out << ",";
				first = false;
				int prod = 0;
				for (size_t qi = 0; qi < queues.size(); qi++) if (queueOwners[qi] == slot)
					for (int s = 0; s < 5; s++) if (queues[qi][s] >= 0) prod++;
				int building = 0;
				for (auto& u : units) if (u.owner == slot && !u.completed && isBuilding[u.type]) building++;
				out << "{\"slot\":" << slot << ",\"minerals\":" << minerals[slot]
				    << ",\"gas\":" << gas[slot] << ",\"gathered\":" << gathered[slot]
				    << ",\"queued\":" << prod << ",\"underConstruction\":" << building << "}";
			}
			out << "]}\n";
			lastFrame = frame;
			if (++ticks % 200 == 0) {
				printf("  frame %6d  units %3zu  supply-violations %d\n", frame, units.size(), violations);
				out.flush();
			}
		}
		out.close();
		printf("\n=== summary ===\n  ticks logged: %d\n  supply reconciliation failures: %d\n", ticks, violations);
		printf("\n  compare these against SC:R's post-game score screen:\n");
		printf("    %-6s %10s %10s %10s %10s %10s\n", "slot", "minerals", "gas", "unitsProd", "bldgsBuilt", "atStart");
		for (int i = 0; i < 12; i++) {
			if (!peakGathered[i] && !peakMined[i] && !producedUnits[i]) continue;
			printf("    %-6d %10d %10d %10d %10d %10d\n", i, peakMined[i], peakGathered[i],
				producedUnits[i], producedBuildings[i], initialUnits[i]);
		}
		printf("\n  'atStart' is what already existed when logging began - if logging did not\n"
		       "  start at frame 0 the produced counts are low by roughly that much.\n");
		return 0;
	}
	// lists: find BW's unit-list heads.
	//
	// Two problems have the same answer. Units in production are missing from the
	// list we walk (supply reconciliation comes up short by exactly their supply),
	// because BW keeps several lists - visible, hidden, revealers - and a unit
	// inside a building lives in the hidden one. Separately, the anchor for the
	// visible list is currently found by scanning the heap, which is slow and
	// goes stale whenever a game loads.
	//
	// BW holds each list's head in a global. So: walk to the head of the list we
	// already have, find what points at it, and the neighbouring pointers are the
	// other heads. If those globals live in the module they are at fixed offsets,
	// which removes the heap scan entirely.
	if (cmd == "lists") {
		if (argc < 3) { fprintf(stderr, "bwfind: lists needs <a-unit-record-addr-hex>\n"); return 1; }
		uintptr_t start = (uintptr_t)strtoull(argv[2], nullptr, 16);
		uint8_t buf[488];
		auto rd = [&](uintptr_t a, void* d, size_t n) {
			SIZE_T got = 0;
			return ReadProcessMemory(proc, (LPCVOID)a, d, n, &got) && got == n;
		};

		// Rewind to the head of whichever list this unit is on.
		uintptr_t head = start;
		std::unordered_set<uintptr_t> guard;
		while (rd(head, buf, 488)) {
			uintptr_t prev;
			memcpy(&prev, buf + 0x00, 8);
			if (!prev || !guard.insert(prev).second || !rd(prev, buf, 488)) break;
			head = prev;
		}
		printf("list head: 0x%llx\n\n", (unsigned long long)head);

		// Describes a list: how many units, and crucially how many are incomplete,
		// since units in production are exactly the incomplete ones we are missing.
		auto describe = [&](uintptr_t from, int& total, int& incomplete, std::map<int, int>& types) {
			total = 0; incomplete = 0; types.clear();
			std::unordered_set<uintptr_t> seen;
			uintptr_t cur = from;
			uint8_t b[488];
			while (cur && seen.insert(cur).second && total < 3000) {
				if (!rd(cur, b, 488)) break;
				uint16_t type;
				memcpy(&type, b + 0x8c, 2);
				uint8_t owner = b[0x68];
				if (type <= 227 && owner <= 11) {
					total++;
					types[type]++;
					if (!(b[0x140] & 1)) incomplete++;
				}
				memcpy(&cur, b + 0x08, 8);
			}
		};

		printf("searching for globals pointing at that head...\n");
		snapshot(proc, regions);
		std::vector<uintptr_t> holders;
		for (size_t ri = 0; ri < regions.size(); ri++) {
			const auto& d = regions[ri].data;
			for (size_t off = 0; off + 8 <= d.size(); off += 8) {
				uint64_t v;
				memcpy(&v, d.data() + off, 8);
				if (v == (uint64_t)head) holders.push_back(regions[ri].base + off);
			}
		}
		printf("  %zu location(s) hold it\n\n", holders.size());

		for (uintptr_t h : holders) {
			printf("=== %s (abs 0x%llx) and its neighbours ===\n", describe_addr(h).c_str(), (unsigned long long)h);
			for (int delta = -0x40; delta <= 0x40; delta += 8) {
				uintptr_t slot = h + delta;
				uint64_t p = 0;
				if (!rd(slot, &p, 8) || p < 0x10000) continue;
				int total = 0, incomplete = 0;
				std::map<int, int> types;
				describe(p, total, incomplete, types);
				if (total < 1) continue;
				printf("  %+4d  -> 0x%llx  %4d units, %3d incomplete", delta, (unsigned long long)p, total, incomplete);
				if (incomplete && total < 200) {
					printf("   types:");
					int shown = 0;
					for (auto& [t, c] : types) { printf(" %d x%d", t, c); if (++shown >= 6) break; }
				}
				printf("%s\n", delta == 0 ? "   <- the list we already walk" : "");
			}
			printf("\n");
		}
		printf("A list that is mostly INCOMPLETE units is the hidden list - that is where\n"
		       "units in production live, and what the supply shortfall is made of.\n");
		return 0;
	}
	// str: find an ASCII string. Used to locate the player-name array - the overlay
	// should label rows with in-game names, and for a live game there is no replay
	// file to read them from, so they have to come out of memory like everything
	// else.
	if (cmd == "str") {
		if (argc < 3) { fprintf(stderr, "bwfind: str needs <text> [--all]\n"); return 1; }
		std::string needle = argv[2];
		printf("searching for \"%s\"\n\n", needle.c_str());
		snapshot(proc, regions);
		int found = 0;
		for (size_t ri = 0; ri < regions.size(); ri++) {
			const auto& d = regions[ri].data;
			if (d.size() < needle.size()) continue;
			for (size_t off = 0; off + needle.size() <= d.size(); off++) {
				if (memcmp(d.data() + off, needle.data(), needle.size()) != 0) continue;
				uintptr_t at = regions[ri].base + off;
				// Print a little context: a name array shows its neighbours here.
				printf("  %-24s abs 0x%llx  ", describe_addr(at).c_str(), (unsigned long long)at);
				size_t from = off > 40 ? off - 40 : 0;
				for (size_t k = from; k < off + needle.size() + 40 && k < d.size(); k++) {
					unsigned char c = d[k];
					putchar((c >= 32 && c < 127) ? c : '.');
				}
				printf("\n");
				if (++found >= 25) { printf("  ...stopping at 25\n"); return 0; }
			}
		}
		if (!found) printf("  not found%s\n", regions.size() < 5 ? " - try --all" : "");
		return 0;
	}
	if (cmd == "resources") return cmd_resources(proc, std::move(regions));
	if (cmd == "track") {
		if (argc < 4) { fprintf(stderr, "bwfind: track needs <frame-counter-addr-hex> <groundtruth.csv>\n"); return 1; }
		uintptr_t addr = (uintptr_t)strtoull(argv[2], nullptr, 16);
		return cmd_track(proc, std::move(regions), addr, argv[3]);
	}
	if (cmd == "units") {
		if (argc < 3) { fprintf(stderr, "bwfind: units needs <units.csv>\n"); return 1; }
		return cmd_units(proc, std::move(regions), argv[2]);
	}
	fprintf(stderr, "bwfind: unknown command '%s'\n", cmd.c_str());
	return 1;
}
