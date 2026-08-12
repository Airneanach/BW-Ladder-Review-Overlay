// Reviews a batch of the user's own replays to calibrate grading to how they actually play.
//
// Entirely local: it walks their replay folder, re-simulates each game with the same bundled
// simulator a normal review uses, and hands the measurements to src/calibration.js. Nothing
// leaves the machine and nothing is fetched.
//
// Speed is the reason for the cap. A game takes about a second to simulate, so a hundred
// replays is a minute or two - long enough to need a progress bar and a cancel button, short
// enough that nobody walks away. Past a hundred the percentiles barely move, so the extra
// wait buys nothing.

import fs from 'node:fs';
import path from 'node:path';

import { computeMatchStats } from './computeMatchStats.js';
import { buildCalibration, DEFAULT_TRAINING_LIMIT } from './calibration.js';

/**
 * Every .rep under a folder, newest first.
 *
 * Recursive because SC:R buries autosaved games in dated subfolders (Replays\AutoSave\20240106),
 * which is where most people's ladder history actually lives - a non-recursive scan of the
 * Replays folder finds almost nothing on a typical install.
 *
 * Newest first so that a capped run trains on recent play. Someone's games from three years ago
 * describe a player who no longer exists, and grading them against it would be worse than not
 * calibrating at all.
 */
export function findReplays(folder, { limit = Infinity } = {}) {
  const found = [];

  function walk(dir, depth) {
    // Depth-limited purely as a safety rail against a pathological tree or a symlink loop;
    // real replay folders are two or three levels deep.
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder, nothing useful to do
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.rep')) {
        try {
          found.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  }

  walk(folder, 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, limit).map(f => f.path);
}

/**
 * Reviews replays and builds a calibration.
 *
 * @param {object} opts
 * @param {string} opts.replayFolder
 * @param {string} opts.installPath
 * @param {string} opts.bwstatsPath
 * @param {string[]} opts.playerNames - only games one of these played in are used
 * @param {number} [opts.limit]
 * @param {number} [opts.sampleIntervalFrames]
 * @param {(progress: object) => void} [opts.onProgress]
 * @param {() => boolean} [opts.isCancelled] - polled between replays
 */
export async function trainCalibration(opts) {
  const {
    replayFolder,
    installPath,
    bwstatsPath,
    playerNames,
    limit = DEFAULT_TRAINING_LIMIT,
    sampleIntervalFrames = 24,
    onProgress = () => {},
    isCancelled = () => false,
  } = opts;

  if (!playerNames || playerNames.length === 0) {
    throw new Error('Add at least one in-game name first - training needs to know which player is you.');
  }
  if (!installPath) throw new Error('The StarCraft folder is not set, so replays cannot be simulated.');
  if (!replayFolder || !fs.existsSync(replayFolder)) throw new Error(`Replay folder not found: ${replayFolder}`);

  const files = findReplays(replayFolder, { limit });
  if (!files.length) throw new Error(`No .rep files found under ${replayFolder}`);

  const metrics = [];
  const counts = { total: files.length, reviewed: 0, used: 0, notMine: 0, tooShort: 0, failed: 0 };

  for (const [index, file] of files.entries()) {
    if (isCancelled()) break;

    onProgress({ ...counts, index, current: path.basename(file), done: false });
    try {
      const stats = await computeMatchStats({
        replayPath: file,
        installPath,
        bwstatsPath,
        sampleIntervalFrames,
        selfPlayerNames: playerNames,
      });
      counts.reviewed++;

      if (stats.gradeMetrics) {
        metrics.push(stats.gradeMetrics);
        counts.used++;
      } else {
        // extractMetrics returns null for three different reasons, and they are worth telling
        // apart in the summary: a folder full of team games or 3-minute all-ins is a different
        // problem for the user than a folder of someone else's replays.
        const mine = Object.values(stats.players).some(p =>
          playerNames.some(n => n.toLowerCase() === (p.name || '').trim().toLowerCase()));
        if (!mine) counts.notMine++;
        else counts.tooShort++;
      }
    } catch {
      // One unreadable or unsupported replay must not abandon the batch - a folder of a
      // hundred games will usually contain at least one oddity, and stopping there would make
      // training feel broken while being nothing of the sort.
      counts.failed++;
    }
  }

  const cancelled = isCancelled();
  const { calibration, report } = buildCalibration(metrics);
  onProgress({ ...counts, index: files.length, current: null, done: true });

  return { calibration, report: { ...report, counts, cancelled } };
}
