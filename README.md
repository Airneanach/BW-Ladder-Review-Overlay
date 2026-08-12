# BW Ladder Review Overlay

Reviews your **StarCraft: Remastered** ladder games as you finish them and puts a graded
report card on stream.

When a game ends, this re-simulates the whole replay through
[OpenBW](https://github.com/OpenBW/openbw), reads the real game state back out — actual
harvested totals, worker and base counts, army value, supply-blocked time — grades it, and
serves the result as a browser overlay for OBS. A typical 15-minute game is reviewed in
about a second.

It is a desktop app: a window where you check your StarCraft folder, your replay file and
your in-game name(s), copy the overlay URL into OBS, and then leave it running while you
play.

## Using it

1. Start **BW Ladder Review Overlay**.
2. Add your in-game name(s) — one per account you play on. This is the only thing you have
   to fill in; the StarCraft folder and replay file are detected for you, with a green tick
   when they check out.
3. Copy the overlay URL and add it in OBS as a **Browser** source, **1920 × 1080**.
4. Play. Each finished game pops its report card up for 15 seconds.

Leave the window open while you play — closing it stops the overlay.

The overlay is blank until a game finishes, which is normal. **Review a past replay…** puts
a card on screen straight away so you can position it in OBS before you play.

### Why the name is the one thing you have to enter

Replays record the in-game account names that played, but nothing on your PC says which of
them is you — Remastered has no screen-name registry key, and picking the host or slot 0 is
wrong as often as it's right.

If you leave it empty the app still works and still records the game; it just can't say
whether *you* won or grade *your* play. It tells you the names it found in the replay so you
can add the right one:

```
Reviewed in 1.0s, but none of your in-game names matched this game.
Players in this replay: L9_XD, nOmZergWeedLord
```

### Where it keeps things

Settings, match history and a crash log live in
`%APPDATA%\bw-ladder-review-overlay\`. Nothing is written next to the exe, because the
portable build unpacks itself to a new temporary folder on every run.

## Train it on your own play

**Do this first — otherwise the grades describe someone else.**

The built-in grade boundaries were tuned by eye against one player's replay history, so out
of the box they measure you against *that* player. If your APM is 90 you would sit at F for
ever; if you are much stronger, nothing would ever drop below an A. Either way the grade
stops telling you anything.

Press **Train on my replays**. It reviews your past games — up to 100, newest first, about a
minute or two — and rebuilds the boundaries from your own numbers, so a normal game for you
becomes a C and your best become As. Then a grade means "compared with how you normally
play", which is the thing worth knowing.

It is entirely local. Your replays are simulated on your PC by the same bundled simulator a
normal review uses; nothing is uploaded, nothing is downloaded, and there is no model beyond
a small table of numbers in `%APPDATA%\bw-ladder-review-overlay\calibration.json`.

The card shows your median for each measure once trained — worth a glance, since those are
numbers you can check against your own sense of your play. **Reset to built-in** puts the
shipped grading back. Retrain every few weeks if you are improving, or your own past becomes
the thing holding your grades down.

Details worth knowing:

- **Newest first**, so a capped run reflects how you play now rather than three years ago.
- Games under four minutes, team games and games none of your names played in are skipped;
  the summary says how many of each.
- **At least 12 usable games** are needed. Below that the percentiles are noise and it
  declines to train rather than making grading worse.
- **Two measures stay absolute** and are deliberately *not* personalised: `Income vs
  opponent` and `Army vs opponent` are head-to-head, so matching your opponent means the
  same thing whoever is playing; and `Excess supply` encodes a mechanical optimum, so
  scoring it against your own habits would tell a chronically supply-blocked player that
  being supply-blocked is fine.

## What the grades mean

The **inputs** are objective — real harvested totals, real worker/base counts, real army
value, real supply-blocked time, and effective APM from the command stream (raw APM minus
commands repeated unchanged within a second).

The **grading** is a judgement call, and after training it is a judgement call about you.
The default anchor tables in [`src/gradeMatch.js`](src/gradeMatch.js) put the median game of
the project's own 149-replay history near a C; training replaces five of them from your own
distribution (see [`src/calibration.js`](src/calibration.js)). Each is a short list of
`(value, score)` points, so moving a boundary by hand is still a one-line edit.

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

The app serves these on `127.0.0.1` only — nothing is reachable from the network.

| Path | Serves |
| --- | --- |
| `/` | the overlay page |
| `/api/bw/matches?limit=N` | reviewed games, newest first |
| `/health` | config, warnings, and whether a review is in progress |

`/api/bw/matches` rows carry `result`, `my_race`, `opponent_race`, `map_name`,
`duration_seconds`, `supply_blocked_seconds`, `avg_unspent_minerals`/`_gas`,
`key_moment_text`, `grades_json` (the report card, as a JSON string) and `all_players`.
Point your own graphics at it if you don't want the bundled page.

## Building

Two stages: the native simulator, then the app.

```
native\build-stats.bat     # -> native\bwstats.exe   (needs MSVC; only when the C++ changes)
npm install
npm run dist               # -> dist\BWLadderReview.exe   (portable, single file, ~75 MB)
```

`build-stats.bat` needs Visual Studio Build Tools with "Desktop development with C++" and
finds the x64 developer environment itself. `bwstats.exe` is committed, so `npm run dist`
works without MSVC as long as you haven't changed the C++.

**`npm run dist` needs about 1 GB of free disk space.** It stages a ~270 MB unpacked build
and then has NSIS compress it, and when it runs out it fails with
`Error: can't write 67108864 bytes to output` — which looks like a config error but is not,
and it leaves a broken ~45 KB stub behind that will not run.

**No app icon yet**, so the build logs `default Electron icon is used` and the exe carries
Electron's. Drop a 256×256 `build/icon.ico` in and electron-builder will pick it up with no
config change.

To run it without packaging:

```
npm start                             the app, from source
npm run review -- "path\to\game.rep"  review one replay on the command line, print JSON
npm run serve                         watch and serve with no window (console only)
```

## Layout

```
main/main.cjs               Electron main: window, settings, drives the review server
main/preload.cjs            the renderer's only route out (contextIsolation)
renderer/                   the settings window
src/reviewServer.js         watch → simulate → grade → serve, with no opinion about the UI
src/trainer.js              scans the replay folder and reviews a batch, for training
src/calibration.js          turns those games into grade boundaries for this player
src/main.js                 console entry point, same engine without a window
src/config.js               config.json + argv, for the console entry only
src/detect.js               finds StarCraft and the replay file
src/watchLastReplay.js      fires once per finished game
src/matchStore.js           history + the row shape the overlay reads
src/computeMatchStats.js    runs the pipeline for one replay
src/replayContainer.js      decodes SC:R's replay container format
src/commandStream.js        leave-game events, chat, APM from the command stream
src/gradeMatch.js           the report card - anchor tables live here
native/src/main.cpp         drives OpenBW frame by frame, prints CSV state
native/vendor/openbw/       vendored OpenBW (patched - see its NOTICE.md)
native/vendor/casclib/      vendored CascLib (MIT)
web/                        the overlay page
```

The GUI and the console entry both drive `src/reviewServer.js`, so there is one
implementation of the pipeline rather than two that can drift.

## How it works

```
LastReplay.rep changes
  -> replayContainer.js decodes the seRS container into header/commands/map
  -> bwstats.exe re-simulates the game through OpenBW, reading game data from
     your StarCraft install's CASC storage, printing per-second state as CSV
  -> computeMatchStats.js parses it, reconstructs the winner, computes economy stats
  -> gradeMatch.js turns the samples into a report card
  -> served on 127.0.0.1 for the overlay page to pick up
```

Replays record only *commands*, never state — which is why knowing how many minerals you
had banked at 8:00 requires re-running the game rather than reading a field. Getting OpenBW
(built against classic 1.16.1) to replay a modern Remastered replay took solving several
undocumented compatibility gaps, and win/loss has to be reconstructed from four independent
signals because replays have no winner field. Both are written up in
[`native/vendor/openbw/NOTICE.md`](native/vendor/openbw/NOTICE.md) and the comments in
`computeMatchStats.js`.

## Notes for anyone hacking on it

**`ELECTRON_RUN_AS_NODE`.** If that variable is set in your shell, `electron.exe` runs as
plain Node: no window, no `app`, and an immediate silent exit, while
`electron --version` prints a *Node* version. Some editors (VS Code's extension host among
them) export it, so a terminal inherited from one will make the app look broken when it is
fine. `npm start` from a normal terminal is unaffected.

**Settings live in one place for both dev and packaged runs:**
`%APPDATA%\bw-ladder-review-overlay\`. Electron takes that from the package `name`, and
electron-builder's `productName` does not change it — so `npm start` and the packaged exe
share the same settings and match history, which is convenient but does mean a dev run can
leave state the packaged build then picks up.

**Only one copy can run at a time.** They all want the same port, so a forgotten `npm start`
will make the packaged exe report `Port 3712 is already in use` instead of serving. It says
so in its Activity log rather than failing silently.

**The packaged app's process name is the productName**, `BW Ladder Review Overlay` — *not*
`BWLadderReview`. `Get-Process BWLadderReview` matches nothing, so it is easy to leave an old
build running, holding the port, answering `/health` with stale data and making a fresh build
look broken. To be sure nothing is left over:

```powershell
Get-Process | Where-Object { $_.ProcessName -match 'BW Ladder Review|electron' } | Stop-Process -Force
```

## Licences

`native/vendor/openbw/` is vendored from a repository with **no LICENSE file** (so, all
rights reserved by default) — see its [NOTICE.md](native/vendor/openbw/NOTICE.md) for scope
of use. `native/vendor/casclib/` is MIT. Everything else here is original.

StarCraft is Blizzard Entertainment's. This tool ships no Blizzard data — it reads the
game's own files from your installation at runtime.
