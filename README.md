# BW Ladder Review Overlay

Reviews your **StarCraft: Remastered** ladder games as you finish them and puts a graded
report card on stream.

When a game ends, this re-simulates the whole replay through
[OpenBW](https://github.com/OpenBW/openbw), reads the real game state back out — actual
harvested totals, worker and base counts, army value, supply-blocked time — grades it, and
serves the result as a browser overlay for OBS. A typical 15-minute game is reviewed in
about a second.

It ships as **one file**: `BWLadderReview.exe`. No Node, no install step.

## For casters — using it

1. Download **[`dist/BWLadderReview.exe`](dist/BWLadderReview.exe)** and put it in a folder
   of its own (it writes its match history beside itself).
2. Make a `config.json` next to it with your in-game name — see
   [config.example.json](config.example.json):
   ```json
   { "playerNames": ["YourInGameName"] }
   ```
3. Double-click the exe. It prints the overlay URL, `http://127.0.0.1:3712/`.
4. In OBS: **+ → Browser**, paste that URL, set the size to **1920 x 1080**.
5. Play. Each finished game pops its report card up for 15 seconds.

Leave the window open while you play; closing it stops the overlay. Start it before or
after StarCraft — it just watches for the replay file to change.

The exe is **unsigned**, so SmartScreen will warn on first run: **More info → Run anyway**.

### Why the name is the one thing you have to configure

The replay records in-game account names, and nothing on the machine reliably says which
of them is you — Remastered has no screen-name registry key, and picking the host or slot 0
is wrong as often as it's right. So it has to be told.

If you skip it, the app still works and still records the game — it just can't say whether
*you* won or grade *your* play. It prints the names it found in the replay so you can paste
the right one into `config.json`:

```
[review] Reviewed in 1.0s, but none of the configured player names matched this game.
         players in this replay: L9_XD, nOmZergWeedLord
```

## What the grades mean

The **inputs** are objective — real harvested totals, real worker/base counts, real army
value, real supply-blocked time, and effective APM from the command stream (raw APM minus
commands repeated unchanged within a second).

The **grading** is a judgement call. The anchor tables in
[`src/gradeMatch.js`](src/gradeMatch.js) are calibrated so the median game across the
project's own 149-replay history lands near a C, with the range spread across F to A. Each
is a short list of `(value, score)` points, so moving a boundary is a one-line edit. Retune
them to taste.

Three deliberate exclusions: samples at 200 supply don't count as supply-blocked (a maxed
player is blocked by definition, and grading that down punishes whoever built the best
army), the first two minutes don't count toward averages (every opening is identical), and
games under four minutes aren't graded at all — a 4-pool that wins at 3:30 with four drones
did have an F-grade economy, and saying so is true and useless. Ungraded games fall back to
the plain result banner.

## Overlay options

Append to the browser-source URL:

| Parameter | Default | Does |
| --- | --- | --- |
| `style` | `advanced` | `advanced` = graded report card, `simple` = result banner + three stats |
| `holdMs` | `15000` | How long the card stays on screen |
| `pollMs` | `4000` | How often the page checks for a new result |
| `listCount` | `2` | Graded categories listed per side (1–4) |
| `title` | — | Replaces the report card's heading |

## Endpoints

| Path | Serves |
| --- | --- |
| `/` | the overlay page |
| `/api/bw/matches?limit=N` | reviewed games, newest first |
| `/health` | config, warnings, and whether a review is in progress |

`/api/bw/matches` rows carry `result`, `my_race`, `opponent_race`, `map_name`,
`duration_seconds`, `supply_blocked_seconds`, `avg_unspent_minerals`/`_gas`,
`key_moment_text`, `grades_json` (the report card, as a JSON string) and `all_players`.
Point your own graphics at it if you don't want the bundled page.

## Command line

```
BWLadderReview.exe                          start watching
BWLadderReview.exe --name "YourName"        set the player name without a config.json
BWLadderReview.exe --once "path\to.rep"     review one replay, print the JSON, exit
BWLadderReview.exe --port 3798              serve on another port
BWLadderReview.exe --replay "path\LastReplay.rep"   watch a different file
BWLadderReview.exe --install "D:\StarCraft"         point at another install
```

## Building

Two stages: the native simulator, then the exe that embeds it.

```
native\build-stats.bat     # -> native\bwstats.exe   (needs MSVC; only when the C++ changes)
npm install
npm run build:exe          # -> dist\BWLadderReview.exe
```

`build-stats.bat` needs Visual Studio Build Tools with "Desktop development with C++" and
finds the x64 developer environment itself. `bwstats.exe` is committed, so `npm run
build:exe` works without MSVC as long as you haven't changed the C++.

To run from source without packaging:

```
npm start
npm run review -- "path\to\replay.rep"
```

**The exe is ~89 MB** because Node's runtime is inside it — that is the cost of a single
file with no install step. See [`build/build-exe.mjs`](build/build-exe.mjs) for the four
steps (bundle → SEA blob → copy node.exe → inject).

## Layout

```
src/main.js                 HTTP server, watcher wiring, console output
src/config.js               autodetects StarCraft, the replay path; reads config.json
src/watchLastReplay.js      fires once per finished game, dependency-free
src/matchStore.js           history + the row shape the overlay reads
src/computeMatchStats.js    orchestrates the whole pipeline for one replay
src/replayContainer.js      decodes SC:R's replay container format
src/commandStream.js        leave-game events, chat, APM from the command stream
src/gradeMatch.js           the report card - anchor tables live here
native/src/main.cpp         drives OpenBW frame by frame, prints CSV state
native/vendor/openbw/       vendored OpenBW (patched - see its NOTICE.md)
native/vendor/casclib/      vendored CascLib (MIT)
web/                        the overlay page, embedded into the exe at build time
build/build-exe.mjs         packages everything into the single exe
```

## How it works

```
LastReplay.rep changes
  -> replayContainer.js decodes the seRS container into header/commands/map
  -> bwstats.exe re-simulates the game through OpenBW, reading game data from
     your StarCraft install's CASC storage, printing per-second state as CSV
  -> computeMatchStats.js parses it, reconstructs the winner, computes economy stats
  -> gradeMatch.js turns the samples into a report card
  -> served on 127.0.0.1:3712 for the overlay page to pick up
```

Nothing is sent anywhere: the server binds `127.0.0.1` only. The simulator reads your
StarCraft installation's data files; the app never writes to the game.

Replays record only *commands*, never state — which is why knowing how many minerals you
had banked at 8:00 requires re-running the game rather than reading a field. Getting OpenBW
(built against classic 1.16.1) to replay a modern Remastered replay took solving several
undocumented compatibility gaps, and win/loss has to be reconstructed from four independent
signals because replays have no winner field. Both are written up in
[`native/vendor/openbw/NOTICE.md`](native/vendor/openbw/NOTICE.md) and the comments in
`computeMatchStats.js`.

## Licences

`native/vendor/openbw/` is vendored from a repository with **no LICENSE file** (so, all
rights reserved by default) — see its [NOTICE.md](native/vendor/openbw/NOTICE.md) for scope
of use. `native/vendor/casclib/` is MIT. Everything else here is original.

StarCraft is Blizzard Entertainment's. This tool ships no Blizzard data — it reads the
game's own files from your installation at runtime.
