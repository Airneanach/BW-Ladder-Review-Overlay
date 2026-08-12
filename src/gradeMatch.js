// Turns a simulated replay's per-second samples into a report card for one player:
// a letter grade per category plus an overall grade, for the "advanced" post-match
// overlay (web/bw-match-overlay.html?style=advanced).
//
// Everything here is derived from data the engine itself produced while re-simulating
// the game (see native/src/main.cpp) - real harvest totals, real worker/base counts,
// real army value - not from estimates off the command stream. The one exception is
// APM, which is a property of the input stream rather than of the game state, and comes
// from commandStream.js's countActionsByPlayerId.
//
// What is NOT objective is the grading: the anchor tables below are a judgement call
// about what a good ladder game looks like, tuned by eye against real replays from the
// AutoSave folder. They are meant to be retuned as more games go through them - each
// table is a small list of (value, score) points, so moving a grade boundary is a
// one-line edit, not a rewrite.
//
// Those defaults were tuned against ONE player's replay history, which makes them a poor
// fit for anyone else: a 100-APM player would sit at F for ever, and a much stronger one
// would never drop below A. So five of the tables can be replaced with ones derived from
// the user's own games - see src/calibration.js and the `calibration` argument below.
// Pass none and you get the defaults, unchanged.

const FRAME_TO_MS = 42;

// A game shorter than this is decided before any of these metrics mean anything - a
// 4-pool that wins at 3:30 with four drones genuinely did have an F-grade economy, and
// saying so is technically true and useless. Below this we report no grades at all and
// the overlay falls back to showing the plain stats. Four minutes is a deliberate
// compromise: it still drops a real share of ladder games (all-ins mostly), but going
// higher would start excluding short games that were decided by macro.
const MIN_GRADABLE_SECONDS = 240;

// Samples before this are excluded from the averages that a fixed opening would
// otherwise dominate (every game starts with 4 workers, no expansion, and an empty
// bank, no matter who is playing).
const WARMUP_SECONDS = 120;

/**
 * Linear interpolation across a table of (value, score) anchor points, clamped at both
 * ends. Anchors must be sorted by value ascending; scores may run either direction, so
 * the same helper covers "more is better" (income) and "less is better" (supply blocked).
 */
function scoreFromAnchors(value, anchors) {
  if (!Number.isFinite(value)) return null;
  if (value <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (value >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i - 1];
    const [x2, y2] = anchors[i];
    if (value <= x2) return y1 + ((value - x1) / (x2 - x1)) * (y2 - y1);
  }
  return last[1];
}

/**
 * The five tables personal calibration can replace, and which way each metric runs.
 *
 * `higherIsBetter` is what lets calibration build a replacement table from a percentile
 * sweep without knowing anything else about the metric: for income-like measures the low
 * percentiles are the bad games, for bank-and-blocked-time measures they are the good ones.
 *
 * These defaults are the tables tuned against this project's own replay history, so they are
 * what an uncalibrated install grades on.
 */
export const DEFAULT_PERSONAL_ANCHORS = {
  workerRatio: [[0.25, 2], [0.4, 25], [0.55, 48], [0.7, 68], [0.85, 86], [1.0, 100]],
  baseRatio: [[0.4, 2], [0.65, 28], [0.9, 52], [1.1, 72], [1.3, 90], [1.55, 100]],
  meanBank: [[150, 100], [300, 85], [500, 68], [800, 50], [1200, 30], [1900, 10], [2800, 0]],
  supplyBlockedPct: [[0, 100], [1.5, 92], [4, 76], [8, 56], [14, 36], [22, 14], [35, 0]],
  eapm: [[40, 0], [70, 22], [100, 42], [130, 58], [160, 72], [200, 86], [250, 100]],
};

export const PERSONAL_METRICS = [
  { key: 'workerRatio', label: 'Economy size', higherIsBetter: true },
  { key: 'baseRatio', label: 'Bases taken', higherIsBetter: true },
  { key: 'meanBank', label: 'Spending resources', higherIsBetter: false },
  { key: 'supplyBlockedPct', label: 'Time supply blocked', higherIsBetter: false },
  { key: 'eapm', label: 'Actions per minute', higherIsBetter: true },
];

// The headline grade is stretched about a centre point rather than reported raw - see the
// note where it is applied. Calibration can move the centre, because "the middle of this
// player's games" is exactly what it measures.
export const DEFAULT_OVERALL_CENTER = 55;
export const OVERALL_SPREAD = 1.6;

// Deliberately not the US school scale (where anything under 60 is an F). These scores
// come from anchor tables centred on "a decent ladder game", so the middle of the range
// is a C, and an F means genuinely bad rather than merely below average.
const LETTER_BANDS = [
  [95, 'A+'], [88, 'A'], [82, 'A-'],
  [76, 'B+'], [70, 'B'], [64, 'B-'],
  [58, 'C+'], [50, 'C'], [44, 'C-'],
  [37, 'D+'], [30, 'D'], [24, 'D-'],
];

export function letterForScore(score) {
  if (!Number.isFinite(score)) return null;
  for (const [min, letter] of LETTER_BANDS) if (score >= min) return letter;
  return 'F';
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Per-player aggregates over that player's samples. `samples` must be this player's
 * only, in ascending frame order.
 *
 * Two exclusions matter here. Samples at 200 supply available are dropped from the
 * supply-block and headroom measures: a maxed player is "supply blocked" every frame by
 * definition, and grading them down for it would punish exactly the player who did the
 * best job of building an army. And the first WARMUP_SECONDS are dropped from the
 * averages, since every game's opening is identical regardless of skill.
 */
function summarizePlayer(samples, sampleSeconds) {
  const afterWarmup = samples.filter(s => (s.frame * FRAME_TO_MS) / 1000 >= WARMUP_SECONDS);
  const usable = afterWarmup.length ? afterWarmup : samples;
  const notMaxed = usable.filter(s => s.supplyAvailable < 200);

  const blockedSamples = notMaxed.filter(s => s.supplyUsed >= s.supplyAvailable);
  const last = samples[samples.length - 1] || null;

  return {
    lastFrame: last ? last.frame : 0,
    playedSeconds: last ? (last.frame * FRAME_TO_MS) / 1000 : 0,
    // Share of the (non-maxed) game spent unable to build anything, which is the number
    // players actually feel, rather than the raw seconds.
    supplyBlockedPct: notMaxed.length ? (blockedSamples.length / notMaxed.length) * 100 : null,
    meanHeadroom: mean(notMaxed.map(s => s.supplyAvailable - s.supplyUsed)),
    meanBank: mean(usable.map(s => s.minerals + s.gas)),
    meanArmyScore: mean(usable.map(s => s.unitScore ?? 0)),
    maxWorkers: samples.reduce((m, s) => Math.max(m, s.workers ?? 0), 0),
    maxBases: samples.reduce((m, s) => Math.max(m, s.bases ?? 0), 0),
    totalGathered: last ? (last.mineralsGathered ?? 0) + (last.gasGathered ?? 0) : 0,
    sampleSeconds,
  };
}

/** Formats a ratio against the opponent the way a viewer reads it: "1.18x" / "0.74x". */
function formatRatio(r) {
  return `${r.toFixed(2)}x opponent`;
}

/**
 * The raw, ungraded measurements for one player in one game.
 *
 * Split out from the grading so that training (src/trainer.js) can collect the same numbers
 * over a batch of replays without also producing report cards it would throw away - and,
 * more importantly, so the numbers being calibrated are computed by exactly the same code
 * that later grades against them. Two implementations of "mean bank after the warmup" would
 * eventually disagree and silently skew every grade.
 *
 * Returns null on a game that cannot be graded at all (too short, not a 1v1, unknown self
 * player, or samples from a bwstats.exe predating the extra columns).
 */
export function extractMetrics({ samples, players, selfSlot, sampleIntervalFrames, actionsByPlayerId, slotByPlayerId }) {
  if (selfSlot == null || players.size !== 2) return null;
  const opponentSlot = [...players.keys()].find(s => s !== selfSlot);
  if (opponentSlot == null) return null;

  const sampleSeconds = (sampleIntervalFrames * FRAME_TO_MS) / 1000;
  const byFrame = (a, b) => a.frame - b.frame;
  const mine = samples.filter(s => s.player === selfSlot).sort(byFrame);
  const theirs = samples.filter(s => s.player === opponentSlot).sort(byFrame);
  if (!mine.length || !theirs.length) return null;

  const durationSeconds = (Math.max(mine[mine.length - 1].frame, theirs[theirs.length - 1].frame) * FRAME_TO_MS) / 1000;
  if (durationSeconds < MIN_GRADABLE_SECONDS) return null;
  // The columns the grader needs only exist in samples from the extended bwstats.exe. A
  // stats run from an older build parses fine but leaves them undefined, and grading that
  // would silently report zero workers and no income as if they were real.
  if (mine[0].workers == null || mine[0].mineralsGathered == null) return null;

  const me = summarizePlayer(mine, sampleSeconds);
  const them = summarizePlayer(theirs, sampleSeconds);
  const minutes = durationSeconds / 60;

  function apmFor(slot) {
    if (!actionsByPlayerId || !slotByPlayerId) return null;
    const playerId = [...slotByPlayerId.entries()].find(([, s]) => s === slot)?.[0];
    if (playerId == null) return null;
    const entry = actionsByPlayerId.get(playerId);
    if (!entry) return null;
    // Divide by how long this player was still issuing commands, not by the replay's full
    // length: someone who leaves at 8:00 of a 12:00 recording didn't spend four minutes
    // idle, they were gone.
    const activeMinutes = Math.max(((entry.lastActionFrame * FRAME_TO_MS) / 1000) / 60, 0.5);
    return { apm: entry.actions / activeMinutes, eapm: entry.effectiveActions / activeMinutes };
  }

  const myRates = apmFor(selfSlot);
  const theirRates = apmFor(opponentSlot);

  // Income is the engine's own lifetime harvest counter, so this is a true
  // resources-per-minute comparison rather than a worker-count proxy.
  const myIncomePerMin = me.totalGathered / Math.max(me.playedSeconds / 60, 0.5);
  const theirIncomePerMin = them.totalGathered / Math.max(them.playedSeconds / 60, 0.5);

  // Worker and base targets scale with game length: 28 workers is a strong economy at 6
  // minutes and a badly neglected one at 20. Both curves flatten out, because both things
  // stop in a real game - nobody is still expanding for the first time at 25 minutes, and
  // worker counts plateau once the bases are saturated.
  const workerTarget = Math.min(4 + 3 * minutes, 50);
  const baseTarget = Math.min(1 + minutes / 4.5, 5);

  return {
    durationSeconds,
    me,
    them,
    myRates,
    theirRates,
    myIncomePerMin,
    theirIncomePerMin,
    workerTarget,
    baseTarget,
    // The five values below are the ones personal calibration replaces the anchors for; the
    // ratios after them stay on an absolute scale (see the note by VS_OPPONENT_ANCHORS).
    workerRatio: me.maxWorkers / workerTarget,
    baseRatio: me.maxBases / baseTarget,
    meanBank: me.meanBank,
    supplyBlockedPct: me.supplyBlockedPct,
    eapm: myRates == null ? null : myRates.eapm,

    incomeRatio: theirIncomePerMin > 0 ? myIncomePerMin / theirIncomePerMin : null,
    armyRatio: them.meanArmyScore > 0 ? me.meanArmyScore / them.meanArmyScore : null,
    meanHeadroom: me.meanHeadroom,
  };
}

/**
 * Builds the graded report card. Returns null when the game can't be meaningfully
 * graded (too short, not a 1v1, unknown self player, or samples from an older
 * bwstats.exe that didn't emit the worker/harvest columns).
 *
 * @param {object} opts
 * @param {Array} opts.samples - every sample line for every player
 * @param {Map} opts.players - slot -> { slot, race, name }
 * @param {number} opts.selfSlot - the slot being graded
 * @param {number} opts.sampleIntervalFrames
 * @param {Map} [opts.actionsByPlayerId] - from countActionsByPlayerId (for APM)
 * @param {Map} [opts.slotByPlayerId] - resolves the above to slots
 * @param {object} [opts.calibration] - from src/calibration.js; replaces the personal
 *   anchor tables with ones derived from this user's own games. Omit for the defaults.
 */
export function gradeMatch({ samples, players, selfSlot, sampleIntervalFrames, actionsByPlayerId, slotByPlayerId, calibration }) {
  const m = extractMetrics({ samples, players, selfSlot, sampleIntervalFrames, actionsByPlayerId, slotByPlayerId });
  if (!m) return null;
  return gradeFromMetrics(m, calibration);
}

/**
 * Grades a game from its already-extracted metrics.
 *
 * Separate from gradeMatch so calibration can grade its own training games without re-reading
 * replays: building the personal anchors changes what a median game scores, so the headline
 * centre has to be measured *after* the new anchors exist (see buildCalibration).
 */
export function gradeFromMetrics(m, calibration) {
  const { me, them, myRates, theirRates, myIncomePerMin, theirIncomePerMin, workerTarget, baseTarget,
    incomeRatio, armyRatio } = m;

  // Head-to-head ratios are graded on an absolute scale - dead even against the
  // opponent is a B-, not a C, because matching a ladder opponent's economy or army is
  // a fine result and the number means the same thing regardless of who is playing.
  // Deliberately NOT personally calibrated for that reason.
  const VS_OPPONENT_ANCHORS = [[0.55, 8], [0.7, 28], [0.85, 45], [1.0, 62], [1.2, 85], [1.4, 100]];

  // `anchors` resolves to this user's calibrated table when there is one, and to the
  // shipped default otherwise. Graded on EAPM rather than APM: this project's own replays
  // run over 50% hotkey spam, which makes raw APM a measure of a nervous habit rather than
  // of how much the player got done. Both numbers are reported in `stats` either way.
  const anchors = key => calibration?.metrics?.[key]?.anchors ?? DEFAULT_PERSONAL_ANCHORS[key];

  const candidates = [
    {
      id: 'income_vs_opponent',
      label: 'Income vs opponent',
      weight: 1.2,
      score: incomeRatio == null ? null : scoreFromAnchors(incomeRatio, VS_OPPONENT_ANCHORS),
      detail: incomeRatio == null ? null : `${Math.round(myIncomePerMin)}/min · ${formatRatio(incomeRatio)}`,
    },
    {
      id: 'economy_size',
      label: 'Economy size',
      weight: 1.2,
      score: scoreFromAnchors(m.workerRatio, anchors('workerRatio')),
      detail: `${me.maxWorkers} workers peak (${Math.round(workerTarget)} expected)`,
    },
    {
      id: 'spending',
      label: 'Spending resources',
      weight: 1.0,
      score: m.meanBank == null ? null : scoreFromAnchors(m.meanBank, anchors('meanBank')),
      detail: m.meanBank == null ? null : `${Math.round(m.meanBank)} unspent on average`,
    },
    {
      id: 'supply_blocked',
      label: 'Time supply blocked',
      weight: 1.0,
      score: m.supplyBlockedPct == null ? null : scoreFromAnchors(m.supplyBlockedPct, anchors('supplyBlockedPct')),
      detail: m.supplyBlockedPct == null ? null : `${m.supplyBlockedPct.toFixed(1)}% of the game`,
    },
    {
      id: 'excess_supply',
      label: 'Excess supply',
      weight: 0.6,
      // Graded from both ends: too little headroom means production stalls the moment a
      // round of units finishes, too much means minerals sunk into supply that could
      // have been army. The score is whichever end is worse.
      //
      // Left absolute rather than personally calibrated: unlike the others this is not a
      // measure of how much a player does, it encodes a mechanical optimum that is the same
      // for everyone, so scoring it against a player's own habits would grade a consistently
      // supply-blocked player as if that were fine.
      score: m.meanHeadroom == null ? null : Math.min(
        scoreFromAnchors(m.meanHeadroom, [[1, 5], [4, 30], [7, 52], [11, 72], [15, 90], [20, 100]]),
        scoreFromAnchors(m.meanHeadroom, [[24, 100], [32, 80], [45, 55], [60, 30], [80, 10]]),
      ),
      detail: m.meanHeadroom == null ? null : `${m.meanHeadroom.toFixed(1)} spare supply on average`,
    },
    {
      id: 'army_vs_opponent',
      label: 'Army vs opponent',
      weight: 1.0,
      score: armyRatio == null ? null : scoreFromAnchors(armyRatio, VS_OPPONENT_ANCHORS),
      detail: armyRatio == null ? null : formatRatio(armyRatio),
    },
    {
      id: 'expansions',
      label: 'Bases taken',
      weight: 0.6,
      score: scoreFromAnchors(m.baseRatio, anchors('baseRatio')),
      detail: `${me.maxBases} base${me.maxBases === 1 ? '' : 's'} (${baseTarget.toFixed(1)} expected)`,
    },
    {
      id: 'apm',
      label: 'Actions per minute',
      weight: 0.8,
      score: m.eapm == null ? null : scoreFromAnchors(m.eapm, anchors('eapm')),
      detail: m.eapm == null ? null : `${Math.round(m.eapm)} effective APM`,
    },
  ];

  const categories = candidates
    .filter(c => c.score != null)
    .map(c => ({ ...c, score: Math.round(c.score), letter: letterForScore(c.score) }))
    .sort((a, b) => b.score - a.score);
  if (!categories.length) return null;

  const totalWeight = categories.reduce((sum, c) => sum + c.weight, 0);
  const weightedMean = categories.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight;
  // Averaging eight categories pulls hard toward the middle - across this project's
  // replay history the raw mean only ever ran about 31-79, so every game would be some
  // flavour of C and the headline grade would say nothing. The category grades stay as
  // they are; only the headline is stretched about the median game, so a genuinely good
  // or bad game reads as an A or an F instead of a C+ either way.
  // Calibrated installs centre this on the median of the player's own trained games, so
  // "their normal game" reads as a C for them too.
  const center = calibration?.overallCenter ?? DEFAULT_OVERALL_CENTER;
  const overallScore = Math.round(
    Math.max(0, Math.min(100, center + (weightedMean - center) * OVERALL_SPREAD)),
  );

  return {
    overallScore,
    overallLetter: letterForScore(overallScore),
    // The un-stretched weighted mean. Calibration takes the median of this across a player's
    // training games to decide where to centre the stretch for them.
    weightedMean,
    // So the overlay - and anyone reading the stored row later - can tell a grade produced
    // against this player's own history from one produced against the shipped defaults.
    calibratedOn: calibration ? { games: calibration.games, trainedAt: calibration.trainedAt } : null,
    // Sorted best-first, so an overlay showing "top 2 / bottom 2" just takes from
    // either end.
    categories: categories.map(({ id, label, score, letter, detail }) => ({ id, label, score, letter, detail })),
    stats: {
      apm: myRates == null ? null : Math.round(myRates.apm),
      eapm: myRates == null ? null : Math.round(myRates.eapm),
      opponentApm: theirRates == null ? null : Math.round(theirRates.apm),
      opponentEapm: theirRates == null ? null : Math.round(theirRates.eapm),
      incomePerMinute: Math.round(myIncomePerMin),
      opponentIncomePerMinute: Math.round(theirIncomePerMin),
      totalGathered: me.totalGathered,
      opponentTotalGathered: them.totalGathered,
      maxWorkers: me.maxWorkers,
      opponentMaxWorkers: them.maxWorkers,
      maxBases: me.maxBases,
      opponentMaxBases: them.maxBases,
      supplyBlockedPct: me.supplyBlockedPct == null ? null : Math.round(me.supplyBlockedPct * 10) / 10,
      meanUnspent: me.meanBank == null ? null : Math.round(me.meanBank),
      meanSpareSupply: me.meanHeadroom == null ? null : Math.round(me.meanHeadroom * 10) / 10,
    },
  };
}
