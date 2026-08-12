# Vendored code notice

The headers in this directory are copied, unmodified, from:

    https://github.com/OpenBW/openbw
    commit 8265ec449b903e0752060a00ed5f930a3656bf00 (2026-07-16)

OpenBW is a free/open-source reimplementation of the StarCraft: Brood War
simulation engine. As of the commit above, the `OpenBW/openbw` repository
(distinct from the LGPLv3-licensed `OpenBW/bwapi` wrapper) has no LICENSE
file - i.e. no explicit license grant.

Usage here is scoped to internal/private use only: this code is used to
locally simulate the player's own already-finished ladder replays in order
to compute post-game statistics, and is not redistributed as source or
binary. It is kept in this clearly separated `native/vendor/openbw/`
directory, untouched from upstream, specifically so it can be swapped out
or excluded if this project is ever open-sourced or distributed.

Only the header-only simulation core is vendored (no `ui/`, no `deps/asio`,
no networking/sync code) - this project only replays a finished command log
headlessly and reads back player resource/supply state; it does not render,
network-sync, or run interactive games.

Our own replay-container decompression code (native/src/, bw-companion/src/)
is separate, original code and is not derived from OpenBW.

## Deviation from upstream

This vendored tree is kept byte-identical with the copy in the `bw-companion`
project, so patches only ever have to be written once and can be re-synced with
a plain file copy. As a result the notes below occasionally refer to tooling
that lives on that side and is not part of this standalone reader - `bwlive.exe`
(live-game simulator), its `--tag-probe` mode, and `native/analyzeTags.mjs`.
The patches themselves are in the vendored headers here and apply equally to
`bwstats.exe`.

`actions.h` has one deliberate patch on top of the vendored commit above: added
handlers for action ids 0x60-0x65 (RIGHT_CLICK_EXT/TARGETED_ORDER_EXT/
UNLOAD_EXT/SELECT_EXT/SELECTION_ADD_EXT/SELECTION_REMOVE_EXT), the "extended"
variants StarCraft: Remastered's client always emits instead of the classic
16-bit-unit-id versions of these same commands that OpenBW already implements.
Without this, OpenBW cannot get past the first few actions of any modern SC:R
replay (right-clicking and selecting units are the most common actions in any
game).

The wire format for each unit reference in these commands is wider (4 bytes
instead of 2), which looks like a widened unit id - but is not simply OpenBW's
classic packed (11-bit index, 5-bit generation) id widened to 32 bits. The
actual relationship (see `kExtUnitTagOffset` and `get_unit_by_ext_tag` in
actions.h): the tag is a flat 0-based index into OpenBW's unit table plus a
constant offset, with no generation component at all. This was derived
empirically (recording every SELECT_EXT tag alongside a full dump of OpenBW's
live unit table at the same frame, cross-checked against both players, exact
match on every unit) against one real replay file, not from documentation -
it should be re-validated against replays from other game versions/limit
configurations before being fully trusted.

`bwgame.h` has one additional small patch: the map (.chk) loader's `read_chunks`
calls marked the `"STR "` (string table) chunk as required in every code path.
Maps saved with Remastered's modern map editor only include `"STRx"` (an
extended/Unicode string table format this vendored OpenBW commit doesn't parse
at all) and omit the classic `"STR "` chunk entirely, so any such map failed
to load with `map is missing required chunk 'STR '`. Changed all five
`{"STR ", true}` occurrences to `{"STR ", false}`. This is safe: `get_map_string`
(the only accessor for the parsed string table) is already bounds-checked and
returns a placeholder string for any index when the table is empty, so the
simulation runs correctly - it just loses display-only text (map name,
scenario description, force names, trigger text) that this project's stats
computation never reads. No STRx parser has been added.

Also in `bwgame.h`: `load_map_data`'s map-version dispatch only recognized
CHK versions 59, 63, and 205, erroring `unsupported map version %d` on
anything else. A real replay's map used version 206 (presumably one more
incremental format revision since this OpenBW commit was written). Extended
the `version == 205` branch to also accept `206`, on the assumption that a
+1 version bump is a minor/additive change reusing the same chunk set - this
worked correctly against that replay (full game simulated, economy numbers
track correctly), but hasn't been checked against the actual byte-level
differences (if any) between the two versions, so treat this as a pragmatic
fix validated against one file, not a confirmed understanding of what changed
in version 206.

The same dispatch has since been extended a second time, at the other end of the
version range: ladder games played on `.scm`-format maps (as opposed to the
`.scx` maps that make up nearly every modern ladder map pool) carry CHK version
64, which also fell through to `unsupported map version 64` - silently costing
this project every match played on such a map, since the companion app treats a
stats-computation failure as "skip this replay". Found on two real ladder games
played on Aiolos 1.0b (`(3)aiolos_1.0b.scm`) on 2026-08-10, both of which the
match tracker recorded nothing for while every other game that day went through.
Version 64 is now accepted by the `59 || 63` branch rather than the `205 || 206`
one, because a dump of that map's chunk table shows the full legacy chunk set
(`UNIS`/`UPGS`/`UPGR`/`PTEC`/`TECS`) present alongside the Brood War `*x`
chunks - exactly the shape the `59 || 63` branch expects, with the `*x` chunks
listed there as optional and still applied when present. The `205 || 206` branch
would also happen to work for this particular map, but it marks `COLR` as
required, which a pre-Remastered version-64 map has no reason to contain.
Validated on both Aiolos replays (full simulation, plausible economy numbers,
win/loss agreeing with the ladder's own record on cwal.gg).

`actions.h` has a second patch, found during a 125-replay validation pass
against a real tournament (IPSL Winter 2025-26): the single-argument
`read_action(reader_T&& r)` overload (the entry point that resolves a
command's `player_id` byte to a player slot before dispatching) errored out
with `execute_action: player id 128 not found` on every Finals-round replay,
which all had a caster/observer in the lobby - pool-stage 1v1s with no
observers never hit it. Root-caused by sequence-dumping the command stream
alongside an independent JS parser up to the crash point (byte-identical) and
finding both parsers agreed the next command was `player_id=128, action_id=92`
(CHAT) at the exact same frame - confirming this is a real observer/caster
chat message tagged with an out-of-band player_id that doesn't appear in the
header's occupied-slot table, not a stream desync. Chat has no effect on
simulated game state, so when the player_id lookup fails and the action is
CHAT (id 92, fixed 81-byte payload), the handler now skips exactly those
bytes and continues instead of aborting the simulation. Any other action type
from an unrecognized sender is still a hard error, since there's no generic
way to know how many bytes to skip for an arbitrary action from a sender with
no slot.

`actions.h` has a third patch, this one purely diagnostic and with no effect on
simulated game state: `action_state` gained two counters (`ext_tag_lookups`,
`ext_tag_failures`) which `get_unit_by_ext_tag` increments, and which
`bwlive.cpp` reports in its JSON output. They exist because the
`kExtUnitTagOffset` caveat above turns out to matter a great deal more than the
original 14-data-point derivation suggested, and it fails invisibly.

Measured on a real 39-minute tournament replay (IPSL Winter 2025-26, Ro16
Losers Artosis vs DragOn g3), the share of extended-command unit tags that
resolve to no live unit climbs steadily through the game - roughly 34% of
lookups failed by the ~5 minute mark and ~94% of lookups in each interval were
failing by the end. Every one of those is a selection that silently selects
nothing, so the command acting on that selection (train, build, morph, upgrade,
research) does nothing at all. The visible result is a simulation whose economy
is accurate for roughly the first 5-8 minutes and then progressively diverges:
on that replay the winning player's simulated mineral bank climbs to 19,726
with supply pinned at 92/92, which is not a state a real game reaches. A short
3-minute ladder replay with almost no unit deaths still shows 15-20% of lookups
failing.

The pattern is consistent with the constant offset being an artifact of both
engines happening to allocate unit-table slots in the same order at game start:
it holds while allocation is purely sequential and breaks permanently once
units start dying and slots get recycled in an order OpenBW does not reproduce.
The counters do not fix any of this - they make it observable, so a consumer
can refuse to display state it cannot trust rather than rendering it anyway.

**Resolution of the above.** The `kExtUnitTagOffset` reading was wrong, and
`get_unit_by_ext_tag` has been rewritten. The tell was that `9893 = (1 << 13) |
1701`: the tag is a packed value - a 13-bit slot number with a generation counter
above it - and every unit in the original 14-sample derivation happened to be
generation 1, which made "subtract 8192 + 1701" and "strip the generation, then
subtract 1701" indistinguishable. They diverge the moment any slot is recycled,
which is why accuracy fell away as games went on.

The decoder now masks the low 13 bits and subtracts 1701. Supporting evidence:
slot numbers occupy a 1700-wide window starting at 1701, matching the size of
BW's unit table; scoring offsets 1700 and 1702 alongside 1701 gives a sharp peak
at 1701 (1570 correctly-owned resolutions against 1026 and 1012), so it is not
curve-fitting; and across all 125 IPSL Winter 2025-26 replays (352,427 tags) it
resolves 78.2% of tags to a live unit owned by the issuing player against 60.0%
for the old constant - **better on 125 replays out of 125, worse on none**.

Effect on simulated economy, measured on the 39-minute Artosis vs DragOn g3
replay that originally exposed the problem: supply used to pin at 83/83 from
minute 14 to the end of the game, and now climbs to 200/262 - BW's supply cap,
which is what a real 39-minute game looks like. Minerals at the 10 minute mark
went from 1,875 to 411. Win detection is unchanged at 124/125 against the
tournament's published bracket, still disagreeing only on the one replay
previously investigated and attributed to a misfiled file or an admin ruling.

This is an improvement, not a complete fix. Resolution still starts around 66-89%
early in a game and decays into single digits by the end of a long one, because
OpenBW's unit-slot allocation order drifts out of step with the real client's.
That drift is self-reinforcing: an unresolved tag drops a command, dropping a
command changes which units get created, and that pushes the slot numbering
further out of step. Closing it means matching the client's allocation and
recycling order exactly, which is engine work rather than arithmetic. The
`ext_tag_failures` counter and the `--tag-probe` candidate scorer in bwlive.exe
exist to measure any future attempt at that.
