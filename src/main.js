// Console entry point - for running from source and for reviewing a replay from a script.
//
// The shipped app is the GUI (see main/main.js); this is the same engine without a window.
// Both drive src/reviewServer.js, so there is only one implementation of watch → simulate →
// grade → serve.
//
//   node src/main.js                        watch and serve
//   node src/main.js --once <replay.rep>    review one replay, print JSON, exit

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, appDir } from './config.js';
import { ReviewServer } from './reviewServer.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Blocks until the user presses a key, but only when this is a console the app owns.
 *
 * Double-clicked, the console window dies with the process, so an error printed on the way
 * out is visible for milliseconds - indistinguishable from "the exe does nothing", which is
 * how an early build was reported. `stdin.isTTY` is false when piped or redirected, where
 * blocking for input would hang instead of help.
 */
function waitForKeyIfInteractive() {
  if (!process.stdin.isTTY) return;
  console.log('\nPress Enter to close this window...');
  const buf = Buffer.alloc(1);
  for (;;) {
    try {
      fs.readSync(0, buf, 0, 1, null);
      return;
    } catch (err) {
      if (err.code === 'EAGAIN') continue;
      return;
    }
  }
}

function fatal(message) {
  console.error(`\n[fatal] ${message}`);
  waitForKeyIfInteractive();
  process.exit(1);
}

async function main() {
  const config = loadConfig();
  const server = new ReviewServer({
    overlayHtml: fs.readFileSync(path.join(here, '..', 'web', 'bw-ladder-review-overlay.html')),
    bwstatsPath: path.join(here, '..', 'native', 'bwstats.exe'),
    historyPath: path.join(appDir(), 'match-history.json'),
    onEvent: (type, payload) => {
      if (type === 'review:start') console.log(`[review] New replay: ${path.basename(payload.replayPath)}`);
      if (type === 'review:error') console.error(`[review] Failed: ${payload.message}`);
      if (type === 'review:skipped') console.warn('[review] Already reviewing a replay, skipping this trigger.');
      if (type === 'review:done') {
        const { row, elapsedSeconds } = payload;
        if (row.my_name) {
          console.log(
            `[review] ${row.result.toUpperCase()} as ${row.my_name} - ` +
            `${row.my_race?.[0]?.toUpperCase() ?? '?'}v${row.opponent_race?.[0]?.toUpperCase() ?? '?'} ` +
            `on ${row.map_name || 'unknown map'} - grade ${row.grades_json ? JSON.parse(row.grades_json).overallLetter : 'not graded'} ` +
            `- reviewed in ${elapsedSeconds.toFixed(1)}s`
          );
        } else {
          const found = row.all_players.map(p => p.name).filter(Boolean).join(', ');
          console.warn(
            `[review] Reviewed in ${elapsedSeconds.toFixed(1)}s, but none of the configured player names ` +
            `matched this game. Set your in-game name to get a win/loss and a grade:\n` +
            `         players in this replay: ${found}\n` +
            `         then either put {"playerNames": ["<your name>"]} in config.json, ` +
            `or restart with --name "<your name>"`
          );
        }
      }
    },
  });

  server.setConfig(config);

  const args = process.argv.slice(2);
  const onceIndex = args.indexOf('--once');
  if (onceIndex !== -1) {
    // No server for a one-shot review: it would just have to be torn down again.
    await server.review(args[onceIndex + 1]);
    console.log(JSON.stringify({ matches: server.store.list(1) }, null, 2));
    process.exit(server.lastError ? 1 : 0);
  }

  try {
    await server.listen(config.port);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      fatal(
        `Port ${config.port} is already in use.\n\n` +
        `         Almost always this means the overlay is already running. Close it, or\n` +
        `         start this one with --port ${config.port + 1}.`
      );
    }
    fatal(`Server error: ${err.message}`);
  }

  console.log('BW Ladder Review Overlay');
  console.log('');
  console.log(`  Overlay URL   http://127.0.0.1:${config.port}/`);
  console.log('                Add it in OBS as a Browser source, 1920 x 1080.');
  console.log('');
  console.log(`  Watching      ${config.lastReplayPath}`);
  console.log(`  StarCraft     ${config.installPath ?? 'NOT FOUND - set starcraftInstallPath in config.json'}`);
  console.log(`  Player name   ${config.playerNames.join(', ') || 'not set - see the warning after your next game'}`);
  console.log('');
  for (const problem of server.problems()) console.warn(`  [warn] ${problem}`);
  console.log('Leave this window open while you play. Closing it stops the overlay.');
}

// Any crash that escapes would otherwise close the console instantly, leaving a window that
// flashed and vanished with no way to report why.
process.on('uncaughtException', err => fatal(`Unexpected error: ${err?.stack || err?.message || err}`));
process.on('unhandledRejection', err => fatal(`Unexpected error: ${err?.stack || err?.message || err}`));

main().catch(err => fatal(`Could not start: ${err?.stack || err?.message || err}`));
