// The review engine and overlay server, with no opinion about how it is being driven.
//
// Both front ends use this: the Electron GUI (main/main.js) and the console/CLI entry
// (src/main.js). Keeping it in one place is deliberate - the GUI was added after the CLI,
// and a second copy of "watch, simulate, grade, serve" is exactly the kind of thing that
// silently drifts until the two disagree about what a game scored.
//
// Everything it needs is passed in. It does not read config.json, does not autodetect
// anything, and does not know where its files live - callers own all of that, because the
// GUI keeps settings in Electron's userData while the CLI reads a config file.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { watchLastReplay } from './watchLastReplay.js';
import { MatchStore } from './matchStore.js';
import { computeMatchStats } from './computeMatchStats.js';

export class ReviewServer {
  /**
   * @param {object} opts
   * @param {Buffer} opts.overlayHtml  the overlay page, already read
   * @param {string} opts.bwstatsPath  path to the simulator exe
   * @param {string|null} opts.historyPath  where to persist reviewed games, or null for memory only
   * @param {(type: string, payload?: object) => void} [opts.onEvent]  progress for a UI
   * @param {import('./predictions.js').Predictions} [opts.predictions]  resolves a live
   *   Twitch Prediction against a finished replay, if one is open. Undefined for the CLI
   *   entry (src/main.js) - live scanning/predictions is GUI-only.
   */
  constructor({ overlayHtml, bwstatsPath, historyPath = null, onEvent = () => {}, predictions = null }) {
    this.overlayHtml = overlayHtml;
    this.bwstatsPath = bwstatsPath;
    this.onEvent = onEvent;
    this.predictions = predictions;
    this.store = new MatchStore({ persistPath: historyPath });

    // `calibration` is null until the user trains on their own replays; the grader falls back
    // to its shipped anchor tables when it is.
    this.config = { installPath: null, lastReplayPath: null, replayFolder: null, playerNames: [], sampleIntervalFrames: 24, calibration: null };
    this.reviewing = false;
    this.lastError = null;
    this.port = null;

    this.server = null;
    this.stopWatching = null;
  }

  /**
   * Replaces the running configuration. Safe to call while serving: the GUI calls it every
   * time the user edits a field, and only the watcher needs restarting, since the replay
   * path is the only setting the watcher captured.
   */
  setConfig(config) {
    const previousPath = this.config.lastReplayPath;
    this.config = { ...this.config, ...config };
    if (this.stopWatching && this.config.lastReplayPath !== previousPath) this.startWatching();
  }

  startWatching() {
    if (this.stopWatching) {
      this.stopWatching();
      this.stopWatching = null;
    }
    if (!this.config.lastReplayPath) return;
    this.stopWatching = watchLastReplay(this.config.lastReplayPath, replayPath => {
      void this.review(replayPath);
    });
  }

  /**
   * Reviews one replay. Used both by the watcher and directly, for reviewing a past game
   * without playing one - which is also the only way to see the overlay do anything before
   * your next match.
   */
  async review(replayPath) {
    if (this.reviewing) {
      this.onEvent('review:skipped', { replayPath });
      return null;
    }
    if (!this.config.installPath) {
      this.lastError = 'StarCraft folder is not set, so the replay cannot be simulated.';
      this.onEvent('review:error', { replayPath, message: this.lastError });
      return null;
    }

    this.reviewing = true;
    this.onEvent('review:start', { replayPath });
    const started = Date.now();
    try {
      const stats = await computeMatchStats({
        replayPath,
        installPath: this.config.installPath,
        bwstatsPath: this.bwstatsPath,
        sampleIntervalFrames: this.config.sampleIntervalFrames,
        selfPlayerNames: this.config.playerNames,
        calibration: this.config.calibration,
      });

      // If a live match-start already opened a pending row (and possibly a Twitch
      // Prediction) for this game, complete that row instead of inserting a fresh one.
      // Twitch failures here are caught and reported inside resolveForFinishedMatch
      // itself - they must never turn a good replay review into a review:error.
      let row = null;
      if (this.predictions) {
        try {
          row = await this.predictions.resolveForFinishedMatch(stats, { replayPath, playerNames: this.config.playerNames });
        } catch (err) {
          this.onEvent('predictions:error', { message: err.message });
        }
      }
      if (!row) row = this.store.add(stats, { replayPath, playerNames: this.config.playerNames });
      this.lastError = null;
      const elapsedSeconds = (Date.now() - started) / 1000;
      this.onEvent('review:done', { row, elapsedSeconds });
      return row;
    } catch (err) {
      this.lastError = err.message;
      this.onEvent('review:error', { replayPath, message: err.message });
      return null;
    } finally {
      this.reviewing = false;
    }
  }

  /** Problems worth showing a user, in the order they should fix them. */
  problems() {
    const out = [];
    if (!this.config.installPath) out.push('StarCraft folder not found - set it so replays can be simulated.');
    else if (!fs.existsSync(path.join(this.config.installPath, 'Data'))) {
      out.push('That StarCraft folder has no Data folder in it - it may be the wrong one.');
    }
    if (!this.config.lastReplayPath) out.push('Replay file not set.');
    else if (!fs.existsSync(this.config.lastReplayPath)) out.push(`Waiting for ${this.config.lastReplayPath} to appear.`);
    // The two are set independently (separate fields, separate "Browse..." buttons - the
    // folder only feeds the "train on my replays" scan, the file is what's actually
    // watched), so nothing stops them drifting apart. That's silent and easy to miss: the
    // watcher keeps "working" against a file that never gets written to again, and the
    // overlay just goes quiet with no error anywhere. Surfacing the mismatch here is the
    // cheapest way to catch it before a whole session's games go unrecorded.
    if (this.config.lastReplayPath && this.config.replayFolder
      && path.dirname(this.config.lastReplayPath) !== this.config.replayFolder) {
      out.push(
        `Replay file and replays folder point at different places (${this.config.lastReplayPath} vs `
        + `${this.config.replayFolder}) - games are watched at the file, not the folder, so if that `
        + `file has stopped updating, fix "Replay file" to match.`
      );
    }
    if (this.config.playerNames.length === 0) {
      out.push('No in-game name set - games will be recorded without a win/loss or a grade.');
    }
    return out;
  }

  status() {
    const problems = this.problems();
    return {
      schema: 1,
      healthy: problems.length === 0,
      status: this.reviewing ? 'reviewing a replay' : problems.length ? 'ready, with warnings' : 'watching for your next game',
      problems,
      reviewing: this.reviewing,
      reviewed: this.store.rows.length,
      lastError: this.lastError,
      port: this.port,
      watching: this.config.lastReplayPath,
      installPath: this.config.installPath,
      playerNames: this.config.playerNames,
      // Reported so it is visible whether grades are being produced against this player's own
      // games or the shipped defaults - the difference matters when reading a grade.
      calibration: this.config.calibration
        ? { games: this.config.calibration.games, trainedAt: this.config.calibration.trainedAt }
        : null,
    };
  }

  handleRequest(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': this.overlayHtml.length,
        'Cache-Control': 'no-store',
      });
      res.end(this.overlayHtml);
      return;
    }

    // What the overlay polls. `account` is accepted and ignored - the page sends it because
    // the bot server it was written against was multi-user; this one has a single user.
    if (url.pathname === '/api/bw/matches') {
      const limit = Number(url.searchParams.get('limit') || 1);
      this.json(res, 200, { matches: this.store.list(Number.isFinite(limit) ? limit : 1) });
      return;
    }

    if (url.pathname === '/health') {
      this.json(res, 200, this.status());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  }

  /**
   * Starts serving and watching.
   *
   * Rejects rather than exiting on failure - a GUI needs to show the error and let the user
   * pick another port, which the old console-only version could not do because it called
   * process.exit itself.
   */
  listen(port) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.once('error', err => {
        this.server = null;
        reject(err);
      });
      // 127.0.0.1 explicitly, not 0.0.0.0: none of this should be reachable from the network.
      this.server.listen(port, '127.0.0.1', () => {
        this.port = port;
        this.startWatching();
        this.onEvent('listening', { port });
        resolve(port);
      });
    });
  }

  async close() {
    if (this.stopWatching) {
      this.stopWatching();
      this.stopWatching = null;
    }
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
    this.port = null;
  }
}
