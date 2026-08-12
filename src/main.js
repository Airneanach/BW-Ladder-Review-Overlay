// BW Ladder Review Overlay - entry point.
//
// Watches StarCraft: Remastered's LastReplay.rep, re-simulates each finished ladder game
// through the bundled OpenBW-based simulator, grades it, and serves the result as a
// browser overlay for OBS on 127.0.0.1.
//
// This replaces the Platinum Bot server the overlay page was originally written against:
// the page still fetches /api/bw/matches, but that endpoint is served from here, out of
// memory, with no account, no database and no network. See matchStore.js for the row
// shape and why it is reproduced verbatim.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sea from 'node:sea';
import { fileURLToPath } from 'node:url';

import { loadConfig, appDir } from './config.js';
import { watchLastReplay } from './watchLastReplay.js';
import { MatchStore } from './matchStore.js';
import { computeMatchStats } from './computeMatchStats.js';

const isSea = () => sea.isSea();

/**
 * The overlay page. Embedded in the SEA build; read off disk when running from source so
 * editing the page does not mean rebuilding the exe.
 */
function loadOverlayHtml() {
  if (isSea()) return Buffer.from(sea.getRawAsset('overlay.html'));
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.join(here, '..', 'web', 'bw-ladder-review-overlay.html'));
}

/**
 * The simulator is a separate native exe that has to exist as a file on disk to be
 * spawned, so under SEA it is unpacked next to the user's temp dir on first run.
 *
 * Written once and reused: the file is ~1.3MB and unpacking it per match would add
 * pointless I/O to every game. The size check catches a half-written file from an
 * interrupted previous run.
 */
function resolveBwstatsPath() {
  if (!isSea()) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.join(here, '..', 'native', 'bwstats.exe');
  }
  const bytes = Buffer.from(sea.getRawAsset('bwstats.exe'));
  const dir = path.join(os.tmpdir(), 'bw-ladder-review');
  const target = path.join(dir, 'bwstats.exe');
  try {
    if (!fs.existsSync(target) || fs.statSync(target).size !== bytes.length) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, bytes);
    }
  } catch (err) {
    throw new Error(`Could not unpack the simulator to ${target}: ${err.message}`);
  }
  return target;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function main() {
  const config = loadConfig();
  const store = new MatchStore({ persistPath: path.join(appDir(), 'match-history.json') });
  const overlayHtml = loadOverlayHtml();

  let bwstatsPath;
  try {
    bwstatsPath = resolveBwstatsPath();
  } catch (err) {
    console.error(`[fatal] ${err.message}`);
    process.exit(1);
  }

  // Reported on /health so the overlay - or a person looking at the console - can tell
  // "nothing has happened yet" apart from "something is misconfigured".
  const state = {
    reviewing: false,
    lastError: null,
    reviewed: store.rows.length,
  };

  async function review(replayPath) {
    if (state.reviewing) {
      // The simulator is CPU-bound and a game cannot end twice at once; if it somehow
      // does, finishing the first review matters more than racing the second.
      console.warn('[review] Already reviewing a replay, skipping this trigger.');
      return;
    }
    state.reviewing = true;
    const started = Date.now();
    console.log(`[review] New replay: ${path.basename(replayPath)}`);
    try {
      const stats = await computeMatchStats({
        replayPath,
        installPath: config.installPath,
        bwstatsPath,
        sampleIntervalFrames: config.sampleIntervalFrames,
        selfPlayerNames: config.playerNames,
      });
      const row = store.add(stats, { replayPath, playerNames: config.playerNames });
      state.reviewed = store.rows.length;
      state.lastError = null;

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const grade = stats.grades ? `${stats.grades.overallLetter} (${stats.grades.overallScore}/100)` : 'not graded';
      if (row.my_name) {
        console.log(
          `[review] ${row.result.toUpperCase()} as ${row.my_name} - ` +
          `${row.my_race?.[0]?.toUpperCase() ?? '?'}v${row.opponent_race?.[0]?.toUpperCase() ?? '?'} ` +
          `on ${row.map_name || 'unknown map'} - grade ${grade} - reviewed in ${seconds}s`
        );
      } else {
        // The single most likely misconfiguration, so say exactly how to fix it and
        // include the names actually found in the replay to copy from.
        const found = row.all_players.map(p => p.name).filter(Boolean).join(', ');
        console.warn(
          `[review] Reviewed in ${seconds}s, but none of the configured player names ` +
          `matched this game. Set your in-game name to get a win/loss and a grade:\n` +
          `         players in this replay: ${found}\n` +
          `         then either put {"playerNames": ["<your name>"]} in config.json ` +
          `beside the exe, or restart with --name "<your name>"`
        );
      }
    } catch (err) {
      state.lastError = err.message;
      console.error(`[review] Failed: ${err.message}`);
    } finally {
      state.reviewing = false;
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': overlayHtml.length,
        'Cache-Control': 'no-store',
      });
      res.end(overlayHtml);
      return;
    }

    // The endpoint the overlay polls. `account` is accepted and ignored - the page sends
    // it because the bot server was multi-user; this server only ever has one user.
    if (url.pathname === '/api/bw/matches') {
      const limit = Number(url.searchParams.get('limit') || 1);
      json(res, 200, { matches: store.list(Number.isFinite(limit) ? limit : 1) });
      return;
    }

    if (url.pathname === '/health') {
      const problems = [];
      if (!config.installPath) problems.push('StarCraft install folder not found - set starcraftInstallPath in config.json');
      if (!fs.existsSync(config.lastReplayPath)) problems.push(`waiting for ${config.lastReplayPath} to appear`);
      if (config.playerNames.length === 0) problems.push('no player name configured - matches will be recorded without a win/loss or grade');
      json(res, 200, {
        schema: 1,
        healthy: problems.length === 0,
        status: state.reviewing ? 'reviewing a replay' : problems.length ? 'ready, with warnings' : 'watching for your next game',
        problems,
        reviewed: state.reviewed,
        lastError: state.lastError,
        watching: config.lastReplayPath,
        installPath: config.installPath,
        playerNames: config.playerNames,
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[fatal] Port ${config.port} is already in use - another copy of this app is ` +
        `probably running. Close it, or start this one with --port <number>.`
      );
    } else {
      console.error(`[fatal] Server error: ${err.message}`);
    }
    process.exit(1);
  });

  // 127.0.0.1 explicitly, not 0.0.0.0: nothing here should be reachable from the network.
  server.listen(config.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${config.port}/`;
    console.log('BW Ladder Review Overlay');
    console.log('');
    console.log(`  Overlay URL   ${url}`);
    console.log('                Add it in OBS as a Browser source, 1920 x 1080.');
    console.log('');
    console.log(`  Watching      ${config.lastReplayPath}`);
    console.log(`  StarCraft     ${config.installPath ?? 'NOT FOUND - set starcraftInstallPath in config.json'}`);
    console.log(`  Player name   ${config.playerNames.join(', ') || 'not set - see the warning after your next game'}`);
    console.log('');
    console.log('Leave this window open while you play. Closing it stops the overlay.');
    if (!config.installPath) {
      console.warn('\n[warn] Without the StarCraft folder the simulator cannot read game data and every review will fail.');
    }
  });

  watchLastReplay(config.lastReplayPath, replayPath => { void review(replayPath); });

  // --once <file> reviews one replay and exits, without watching. Used by the smoke test
  // and handy for checking a past game.
  const onceArg = process.argv.slice(2).indexOf('--once');
  if (onceArg !== -1) {
    const file = process.argv.slice(2)[onceArg + 1];
    review(file).then(() => {
      console.log(JSON.stringify({ matches: store.list(1) }, null, 2));
      server.close();
      process.exit(state.lastError ? 1 : 0);
    });
  }
}

main();
