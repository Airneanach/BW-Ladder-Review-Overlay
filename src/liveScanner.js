// Spawns native/bwfind.exe in overlay mode and turns its ticks into match-start/
// game-over events via matchStartDetector.js, wiring those directly into a Predictions
// instance (src/predictions.js). Adapted from the sibling bot's liveProduction.js: the
// spawn/restart/parse logic is kept as-is, but its HTTP calls to a central bot server
// are replaced with direct in-process calls, since this app has no server to call.
//
// Deliberately not started with the app: it attaches to StarCraft.exe and reads its
// memory, which is new, more invasive capability than "watches a replay file" - so it
// only runs when the "Enable live match tracking" setting is explicitly on (see
// main.cjs), and its status is always the scanner's own real attach state (from
// bwfind.exe's status ticks), never just "the toggle is on."

import { spawn } from 'node:child_process';
import { createMatchStartDetector } from './matchStartDetector.js';

export class LiveScanner {
  /**
   * @param {string} bwfindPath
   * @param {string} unitCostsPath
   * @param {string} upgradeCostsPath
   * @param {import('./predictions.js').Predictions} predictions
   * @param {() => object} getSettings - read live, for myInGameNames (reuses `playerNames`
   *   from the "Your details" card rather than a separate field)
   * @param {(message: string, level?: string) => void} [log]
   * @param {(status: object) => void} [onStatusChange]
   */
  constructor({ bwfindPath, unitCostsPath, upgradeCostsPath, predictions, getSettings, log = () => {}, onStatusChange = () => {} }) {
    this.bwfindPath = bwfindPath;
    this.unitCostsPath = unitCostsPath;
    this.upgradeCostsPath = upgradeCostsPath;
    this.predictions = predictions;
    this.getSettings = getSettings;
    this.log = log;
    this.onStatusChange = onStatusChange;

    this.child = null;
    this.detector = null;
    this.restarts = 0;
    this.running = false;
    this.openMatchId = null;
    this.status = { schema: 1, status: 'stopped', healthy: false };
  }

  getStatus() {
    return this.status;
  }

  _setStatus(status) {
    this.status = status;
    this.onStatusChange(status);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.restarts = 0;

    this.detector = createMatchStartDetector({
      myInGameNames: this.getSettings().playerNames || [],
      log: (msg) => this.log(`[live] ${msg}`),
      onMatchStart: async ({ myName, opponentName }) => {
        try {
          const response = await this.predictions.handleMatchStart({ myName, opponentName });
          this.openMatchId = response?.matchId ?? null;
          this.log(response?.predictionId
            ? `[live] prediction ${response.predictionId} opened for match ${response.matchId}`
            : `[live] match ${response?.matchId} logged (no prediction: ${response?.predictionError || 'predictions off or not linked'})`);
        } catch (err) {
          this.log(`[live] match-start failed: ${err.message}`, 'bad');
        }
      },
      onGameEnd: async () => {
        const matchId = this.openMatchId;
        this.openMatchId = null;
        if (matchId == null) return;
        try {
          const result = await this.predictions.handleGameOver(matchId);
          this.log(`[live] match ${matchId} closed out, ${result.locked ? 'prediction locked' : result.error ? `prediction not locked (${result.error})` : 'no open prediction'}`);
        } catch (err) {
          this.log(`[live] game-over failed: ${err.message}`, 'bad');
        }
      },
    });

    this._spawnReader();
  }

  stop() {
    this.running = false;
    if (this.child) this.child.kill();
    this._setStatus({ schema: 1, status: 'stopped', healthy: false });
  }

  _spawnReader() {
    if (!this.running) return;
    if (this.restarts < 3) this.log('[live] launching scanner...');

    let child;
    try {
      child = spawn(this.bwfindPath, [
        'overlay', this.unitCostsPath, this.upgradeCostsPath, 'auto', '--tick-ms', '500',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this._setStatus({ schema: 1, status: `couldn't launch the scanner: ${err.message}`, healthy: false });
      this.log(`[live] couldn't launch bwfind.exe: ${err.message}`, 'bad');
      return;
    }
    this.child = child;

    let buf = '';
    let lastStderrLine = null;

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        // Non-JSON lines are the reader's attach banner and diagnostics.
        if (!line.startsWith('{')) { this.log(`[scanner] ${line}`); continue; }
        this.restarts = 0;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        this._setStatus(obj);
        this.detector.feed(obj);
      }
    });

    child.stderr.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        if (!line.trim() || line === lastStderrLine) continue;
        lastStderrLine = line;
        this.log(`[scanner] ${line}`, 'warn');
      }
    });

    child.on('error', (err) => {
      this._setStatus({ schema: 1, status: `couldn't launch the scanner: ${err.message}`, healthy: false });
      this.log(`[live] couldn't launch bwfind.exe: ${err.message}`, 'bad');
    });

    child.on('close', (code) => {
      this.child = null;
      if (!this.running) return;
      // "StarCraft is not running" is the ordinary case while waiting for a stream to
      // start, not a failure - logged once loudly and then quietly, same reasoning as
      // the sibling bot's scanner.
      if (this.restarts < 3) this.log(`[live] scanner exited (${code}) - retrying in 3s`, 'warn');
      else if (this.restarts === 3) this.log('[live] scanner still can\'t attach - retrying quietly until StarCraft is running', 'warn');
      this._setStatus({ schema: 1, status: `waiting for StarCraft (reader exited: ${code})`, healthy: false });
      this.restarts++;
      setTimeout(() => this._spawnReader(), 3000);
    });
  }
}
