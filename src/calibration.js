// Turns a batch of the user's own games into replacement anchor tables for the grader.
//
// The problem this solves: the shipped anchor tables in gradeMatch.js were tuned by eye
// against one player's replay history. They therefore encode that player's skill level, not
// anything universal. Handed to someone with 90 APM every game is an F on actions; handed to
// someone much stronger, nothing is ever below an A. Either way the grade stops carrying
// information, which is the whole point of it.
//
// The fix is to score a game against the player's *own* distribution. Feed in the metrics
// from a hundred of their games, take percentiles, and build anchor tables where their median
// game lands on a C and their best and worst land near the ends of the scale. A grade then
// means "compared with how you normally play", which is both more useful for improvement and
// the only thing that can be derived without a shared skill benchmark.
//
// Everything here is local arithmetic over the user's own replays. Nothing is uploaded and
// nothing is downloaded; there is no model beyond these tables.

import { PERSONAL_METRICS, DEFAULT_OVERALL_CENTER, gradeFromMetrics } from './gradeMatch.js';

/**
 * Below this many usable games the percentiles are noise - a handful of games cannot say
 * where someone's median lies, and calibrating on them would make grades worse than the
 * defaults rather than better. The UI reports the shortfall instead of writing a bad table.
 */
export const MIN_TRAINING_GAMES = 12;

/** How many replays to review by default. Enough to be stable, few enough to finish. */
export const DEFAULT_TRAINING_LIMIT = 100;

/**
 * The percentile sweep and the scores those percentiles map onto.
 *
 * Chosen against the letter bands in gradeMatch.js: the median lands at 55 (a C+/B- boundary
 * area, read as "a normal game for you"), the 5th percentile near an F and the 95th near an
 * A+. The spacing is deliberately not linear at the ends - the tails of a player's own
 * distribution are sparse, so stretching them keeps a genuinely exceptional game from being
 * scored the same as a merely good one.
 */
const SWEEP = [
  { p: 5, score: 6 },
  { p: 20, score: 30 },
  { p: 40, score: 47 },
  { p: 60, score: 62 },
  { p: 80, score: 82 },
  { p: 95, score: 97 },
];

/**
 * Linear-interpolated percentile over an unsorted list.
 *
 * Interpolating rather than picking the nearest sample matters at these sample sizes: with 20
 * games the 95th percentile falls between two observations, and rounding to one of them makes
 * the top anchor jump around between training runs on essentially the same data.
 */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/**
 * Forces a strictly increasing x sequence.
 *
 * scoreFromAnchors interpolates with (value - x1) / (x2 - x1), so two equal x values divide by
 * zero and poison every grade with NaN. Equal values are entirely realistic here: a player
 * who is never supply blocked has a 5th and 20th percentile of 0.0, and someone with a fixed
 * build has long runs of identical base counts.
 */
function strictlyIncreasing(points) {
  const out = [];
  for (const [x, score] of points) {
    if (!out.length) {
      out.push([x, score]);
      continue;
    }
    const prevX = out[out.length - 1][0];
    // A hair above the previous x, scaled so it stays meaningful for both 0-1 ratios and
    // four-figure mineral banks.
    const bumped = prevX + Math.max(Math.abs(prevX) * 1e-6, 1e-6);
    out.push([Math.max(x, bumped), score]);
  }
  return out;
}

/**
 * Builds one metric's anchor table from that metric's observed values.
 *
 * For a metric where less is better (unspent minerals, time supply blocked) the value axis
 * still has to ascend for the interpolator, so the scores descend instead: the 5th percentile
 * is their *best* game and takes the top score.
 */
function anchorsFromValues(values, higherIsBetter) {
  const points = SWEEP.map(({ p, score }) => [percentile(values, p), score]);
  if (points.some(([value]) => !Number.isFinite(value))) return null;

  if (higherIsBetter) return strictlyIncreasing(points);

  // Ascending value, descending score.
  const ascending = [...points].sort((a, b) => a[0] - b[0]);
  const scoresDescending = SWEEP.map(s => s.score).sort((a, b) => b - a);
  return strictlyIncreasing(ascending.map(([value], i) => [value, scoresDescending[i]]));
}

/**
 * Builds a calibration from the metrics of a batch of games.
 *
 * `games` is an array of the objects extractMetrics() returns. Games are skipped per-metric
 * rather than wholesale, because a replay can legitimately be missing APM (no resolvable
 * player id) while still having perfectly good economy numbers.
 *
 * Returns { calibration, report } - the report is what the UI shows: how many games were
 * usable, and which metrics could not be calibrated and are therefore still on the defaults.
 */
export function buildCalibration(games) {
  const usable = games.filter(Boolean);
  if (usable.length < MIN_TRAINING_GAMES) {
    return {
      calibration: null,
      report: {
        games: usable.length,
        enough: false,
        needed: MIN_TRAINING_GAMES,
        metrics: [],
        skipped: [],
      },
    };
  }

  const metrics = {};
  const calibrated = [];
  const skipped = [];

  for (const { key, label, higherIsBetter } of PERSONAL_METRICS) {
    const values = usable.map(g => g[key]).filter(v => Number.isFinite(v));
    // A metric needs its own quorum: APM missing from half the batch should not produce a
    // table built from six games while everything else used a hundred.
    if (values.length < MIN_TRAINING_GAMES) {
      skipped.push({ key, label, reason: `only ${values.length} of ${usable.length} games had this` });
      continue;
    }
    const anchors = anchorsFromValues(values, higherIsBetter);
    if (!anchors) {
      skipped.push({ key, label, reason: 'values were not usable' });
      continue;
    }
    metrics[key] = {
      anchors,
      samples: values.length,
      median: percentile(values, 50),
    };
    calibrated.push({ key, label, median: percentile(values, 50), samples: values.length });
  }

  if (!calibrated.length) {
    return {
      calibration: null,
      report: { games: usable.length, enough: false, needed: MIN_TRAINING_GAMES, metrics: [], skipped },
    };
  }

  // Second pass, and it has to be a second pass: the headline grade is a stretch about a centre
  // point, and where a median game lands depends on the anchors built above. Measuring the
  // centre from grades produced with the *old* anchors put it in the wrong place entirely - a
  // median game came out a D+ instead of a C, because the stretch was pushing away from a
  // centre 10 points above where the new anchors actually put it.
  //
  // So: re-grade every training game with the new tables, un-stretched, and take the median.
  // Centring on that value makes a median game score that value, which by construction of
  // SWEEP is a C.
  const withNewAnchors = { metrics };
  const weightedMeans = usable
    .map(g => {
      try {
        return gradeFromMetrics(g, withNewAnchors)?.weightedMean;
      } catch {
        return null;
      }
    })
    .filter(Number.isFinite);
  const center = weightedMeans.length >= MIN_TRAINING_GAMES
    ? percentile(weightedMeans, 50)
    : DEFAULT_OVERALL_CENTER;

  // Plain counts and a plain duration, alongside the ratio-based `metrics` above that
  // grading actually uses. workerRatio/baseRatio/supplyBlockedPct are duration-
  // normalized so a 6-minute and a 20-minute game can be graded fairly against each
  // other - useful for scoring, but "0.83" isn't an answer to "how many workers do I
  // usually have," so this is the same games' actual worker/base counts and actual
  // seconds blocked, median'd the same way.
  const median = (values) => {
    const finite = values.filter(Number.isFinite);
    return finite.length ? percentile(finite, 50) : null;
  };
  const absolute = {
    workers: { actual: median(usable.map(g => g.me.maxWorkers)), expected: median(usable.map(g => g.workerTarget)) },
    bases: { actual: median(usable.map(g => g.me.maxBases)), expected: median(usable.map(g => g.baseTarget)) },
    supplyBlockedSeconds: median(usable.map(g => g.me.supplyBlockedSeconds)),
  };

  return {
    calibration: {
      version: 1,
      trainedAt: new Date().toISOString(),
      games: usable.length,
      overallCenter: center,
      metrics,
      absolute,
    },
    report: {
      games: usable.length,
      enough: true,
      needed: MIN_TRAINING_GAMES,
      metrics: calibrated,
      skipped,
    },
  };
}
