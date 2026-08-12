// bwstats: headless OpenBW-based replay simulator.
//
// Takes a pre-decompressed StarCraft: Remastered replay (header/commands/map sections,
// decompressed ahead of time in Node - see bw-companion/src/replayContainer.js, since
// OpenBW's own replay container reader only understands the older pre-Remastered format)
// and re-simulates it headlessly through OpenBW's engine, printing per-player resource/
// supply state at a fixed sampling interval so the caller can compute supply-blocked time
// and average unspent resources.
//
// Usage:
//   bwstats.exe <sc:r-install-dir> <header.bin> <commands.bin> <map.bin> <sample-interval-frames>
//
// Output (stdout, one line per sample, CSV):
//   frame,player,minerals,gas,supply_used,supply_available,workers,bases,minerals_gathered,gas_gathered,unit_score
//
// The trailing five columns were added for the graded post-match overlay (see
// gradeMatch.js). They are appended rather than inserted so a caller parsing the
// original six-column form still reads the same fields from the same positions.

#include <cstdio>
#include <cstdint>
#include <fstream>
#include <vector>
#include <string>

#include "pre_decoded_reader.h"
#include "casc_data_loader.h"
#include "replay.h"

using namespace bwgame;

static std::vector<uint8_t> read_file(const std::string& path) {
	std::ifstream f(path, std::ios::binary | std::ios::ate);
	if (!f) {
		fprintf(stderr, "bwstats: failed to open %s\n", path.c_str());
		exit(1);
	}
	auto size = f.tellg();
	f.seekg(0);
	std::vector<uint8_t> data((size_t)size);
	f.read((char*)data.data(), size);
	return data;
}

int main(int argc, char** argv) {
	if (argc < 6) {
		fprintf(stderr, "usage: %s <sc:r-install-dir> <header.bin> <commands.bin> <map.bin> <sample-interval-frames>\n", argv[0]);
		return 1;
	}
	std::string data_path = argv[1];
	auto header = read_file(argv[2]);
	auto commands = read_file(argv[3]);
	auto map = read_file(argv[4]);
	int sample_interval = atoi(argv[5]);
	if (sample_interval <= 0) sample_interval = 24;

	try {
		replay_player player;
		player.init(casc_data_loader(data_path));

		pre_decoded_reader reader(header, commands, map);
		player.load_replay(reader, true);

		state& st = player.st();

		for (size_t i = 0; i != 12; ++i) {
			if (st.players[i].controller == player_t::controller_occupied || st.players[i].controller == player_t::controller_computer_game) {
				printf("player,%zu,%d,%s\n", i, (int)st.players[i].race, player.replay_st.player_name[i].c_str());
			}
		}
		printf("frame,player,minerals,gas,supply_used,supply_available,workers,bases,minerals_gathered,gas_gathered,unit_score\n");

		while (!player.is_done()) {
			player.next_frame();
			if (st.current_frame % sample_interval == 0) {
				for (size_t i = 0; i != 12; ++i) {
					if (st.players[i].controller != player_t::controller_occupied && st.players[i].controller != player_t::controller_computer_game) continue;
					int race_index = (int)st.players[i].race;
					if (race_index < 0 || race_index > 2) continue;
					double supply_used = st.supply_used[i][race_index].raw_value / (double)(1 << fp1::fractional_bits);
					double supply_available = st.supply_available[i][race_index].raw_value / (double)(1 << fp1::fractional_bits);
					// Worker and base counts have no aggregate in the engine state, so they're
					// counted by walking this player's unit list. Only completed units count:
					// an SCV still being built, or a drone mid-morph, isn't mining yet, and
					// counting it would make worker-count-derived income look early by the
					// length of a build. Cheap enough to do per sample (a few hundred units,
					// once a second of game time).
					int workers = 0;
					int bases = 0;
					for (unit_t* u : ptr(st.player_units[i])) {
						if ((u->status_flags & unit_t::status_flag_completed) == 0) continue;
						if (u->unit_type->flags & unit_type_t::flag_worker) workers++;
						if (u->unit_type->flags & unit_type_t::flag_resource_depot) bases++;
					}
					// total_*_gathered are the engine's own lifetime harvest counters, which is
					// what makes real income (rather than a worker-count proxy) available to the
					// grader: the delta between two samples IS that interval's income.
					// unit_score is BW's build_score sum over living non-building units - a
					// value-weighted army size, so 10 supply of tanks outranks 10 of zerglings.
					printf("%d,%zu,%d,%d,%.2f,%.2f,%d,%d,%d,%d,%d\n", st.current_frame, i,
						st.current_minerals[i], st.current_gas[i], supply_used, supply_available,
						workers, bases, st.total_minerals_gathered[i], st.total_gas_gathered[i], st.unit_score[i]);
				}
			}
		}
		for (size_t i = 0; i != 12; ++i) {
			if (st.players[i].controller != player_t::controller_occupied && st.players[i].controller != player_t::controller_computer_game
				&& st.players[i].controller != player_t::controller_user_left && st.players[i].controller != player_t::controller_computer_defeated) continue;
			// victory_state: 0=undetermined, 1=dropped, 2=left/defeated, 3=victory (see bwgame.h execute_trigger_action)
			printf("victory_state,%zu,%d\n", i, st.players[i].victory_state);

			// Direct elimination check as a fallback/cross-check for when the map's
			// trigger system hasn't (yet, or ever, within the recorded frame range)
			// declared victory_state: count each player's remaining buildings at the
			// final simulated frame. A player with zero is eliminated under BW's
			// standard melee win condition, independent of whether the trigger
			// happened to fire before the replay recording ends.
			int building_count = 0;
			for (unit_t* u : ptr(st.player_units[i])) {
				if (u->unit_type->group_flags & GroupFlags::Building) building_count++;
			}
			printf("building_count,%zu,%d\n", i, building_count);
		}
		return 0;
	} catch (std::exception& e) {
		fprintf(stderr, "bwstats: error: %s\n", e.what());
		return 1;
	}
}
