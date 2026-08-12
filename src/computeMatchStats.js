import { spawn } from 'node:child_process';
import { decodeReplayContainer } from './replayContainer.js';
import { findLeaveGameEvents, findChatEvents, countActionsByPlayerId } from './commandStream.js';
import { gradeMatch, extractMetrics } from './gradeMatch.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FRAME_TO_MS = 42;

function runBwstats({ bwstatsPath, installPath, headerPath, commandsPath, mapPath, sampleIntervalFrames }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bwstatsPath, [installPath, headerPath, commandsPath, mapPath, String(sampleIntervalFrames)]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`bwstats exited with code ${code}: ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}

export function parseBwstatsOutput(stdout) {
  const players = new Map(); // slot -> { slot, race, name }
  // { frame, player, minerals, gas, supplyUsed, supplyAvailable } plus, from the
  // extended bwstats.exe, { workers, bases, mineralsGathered, gasGathered, unitScore }
  const samples = [];
  const victoryState = new Map(); // slot -> state
  const buildingCount = new Map(); // slot -> count of buildings alive at final simulated frame

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const parts = line.split(',');
    if (parts[0] === 'player') {
      const [, slot, race, name] = parts;
      players.set(+slot, { slot: +slot, race: +race, name: name ?? '' });
    } else if (parts[0] === 'victory_state') {
      const [, slot, state] = parts;
      victoryState.set(+slot, +state);
    } else if (parts[0] === 'building_count') {
      const [, slot, count] = parts;
      buildingCount.set(+slot, +count);
    } else if (parts[0] === 'frame') {
      // header row for the CSV block, ignore
    } else if (parts.length >= 6) {
      // Six columns is the original output; the five that follow were appended later
      // for the graded overlay (see gradeMatch.js). Accepting both widths means a
      // stats run from an older bwstats.exe still parses - it just yields undefined
      // for the new fields, which the grader detects and declines to grade on.
      const [frame, player, minerals, gas, supplyUsed, supplyAvailable,
        workers, bases, mineralsGathered, gasGathered, unitScore] = parts.map(Number);
      samples.push({
        frame, player, minerals, gas, supplyUsed, supplyAvailable,
        workers: parts.length > 6 ? workers : undefined,
        bases: parts.length > 7 ? bases : undefined,
        mineralsGathered: parts.length > 8 ? mineralsGathered : undefined,
        gasGathered: parts.length > 9 ? gasGathered : undefined,
        unitScore: parts.length > 10 ? unitScore : undefined,
      });
    }
  }
  return { players, samples, victoryState, buildingCount };
}

/**
 * Computes supply-blocked-seconds and time-weighted average unspent minerals/gas for one
 * player from evenly-spaced samples. Assumes samples for this player are in increasing
 * frame order (true as long as bwstats.exe's own output order is preserved).
 *
 * Also tracks the longest *contiguous* supply-blocked streak (distinct from the total
 * sum above - a game can have the same total blocked time as one long stretch or many
 * short ones, and only the former is really a "moment") and the single-sample peak
 * unspent minerals/gas (distinct from the average) - both feed computeKeyMoment's
 * macro-fallback framing below.
 */
export function computePlayerEconomyStats(playerSamples, sampleIntervalFrames) {
  const sampleSeconds = (sampleIntervalFrames * FRAME_TO_MS) / 1000;
  let supplyBlockedSeconds = 0;
  let mineralsSum = 0;
  let gasSum = 0;

  let longestBlockedStreakSamples = 0;
  let longestBlockedStreakStartFrame = null;
  let currentStreakSamples = 0;
  let currentStreakStartFrame = null;

  let peakUnspentMinerals = 0;
  let peakUnspentMineralsFrame = 0;
  let peakUnspentGas = 0;
  let peakUnspentGasFrame = 0;

  for (const s of playerSamples) {
    if (s.supplyUsed >= s.supplyAvailable) {
      supplyBlockedSeconds += sampleSeconds;
      if (currentStreakSamples === 0) currentStreakStartFrame = s.frame;
      currentStreakSamples++;
      if (currentStreakSamples > longestBlockedStreakSamples) {
        longestBlockedStreakSamples = currentStreakSamples;
        longestBlockedStreakStartFrame = currentStreakStartFrame;
      }
    } else {
      currentStreakSamples = 0;
      currentStreakStartFrame = null;
    }
    mineralsSum += s.minerals;
    gasSum += s.gas;
    if (s.minerals > peakUnspentMinerals) { peakUnspentMinerals = s.minerals; peakUnspentMineralsFrame = s.frame; }
    if (s.gas > peakUnspentGas) { peakUnspentGas = s.gas; peakUnspentGasFrame = s.frame; }
  }
  const n = playerSamples.length || 1;
  return {
    supplyBlockedSeconds,
    avgUnspentMinerals: mineralsSum / n,
    avgUnspentGas: gasSum / n,
    longestSupplyBlockedStreakSeconds: longestBlockedStreakSamples * sampleSeconds,
    longestSupplyBlockedStreakStartSeconds: longestBlockedStreakStartFrame != null ? (longestBlockedStreakStartFrame * FRAME_TO_MS) / 1000 : null,
    peakUnspentMinerals,
    peakUnspentMineralsTimeSeconds: (peakUnspentMineralsFrame * FRAME_TO_MS) / 1000,
    peakUnspentGas,
    peakUnspentGasTimeSeconds: (peakUnspentGasFrame * FRAME_TO_MS) / 1000,
  };
}

function formatClock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const MIN_SUPPLY_DIP = 6; // filters routine worker/harass losses out of "the" fight - tunable
const MIN_SUPPLY_BLOCK_STREAK_SECONDS = 10; // below this, not worth calling out - tunable
const MIN_PEAK_FLOAT_MINERALS = 500; // below this, not worth calling out - tunable

/**
 * Finds a player's single worst "peak-to-trough" supply_used drop across the game:
 * tracks the running high-water mark of supply_used seen so far, and at each sample
 * measures how far below that recent peak the player currently is. The deepest such
 * dip is a good proxy for "the fight where this player lost the most army," and is far
 * more robust than comparing a fixed time window's start-vs-end net delta - during an
 * active macro game, ongoing production offsets combat losses within seconds, so a
 * fixed-window net delta barely moves even after a real fight (confirmed empirically:
 * a first version using exactly that approach never fired once across 14 real ladder
 * replays, including two 20+ minute games with clear late-game combat). Peak-to-trough
 * isn't fooled by the recovery because it measures the drop itself, not what happens
 * after it.
 */
function findWorstSupplyDip(sortedSamples) {
  let runningMax = -Infinity;
  let worstDip = 0;
  let worstDipFrame = null;
  for (const s of sortedSamples) {
    if (s.supplyUsed > runningMax) runningMax = s.supplyUsed;
    const dip = runningMax - s.supplyUsed;
    if (dip > worstDip) {
      worstDip = dip;
      worstDipFrame = s.frame;
    }
  }
  return { worstDip, worstDipFrame };
}

/**
 * Picks one adaptive "key moment" to highlight for the post-match overlay: the biggest
 * lopsided fight (a swing in supply lost between the two players within a short rolling
 * window) if one occurred, otherwise a macro-focused note (worst supply-block streak, or
 * peak floating resources) about the self-recorded player specifically. Only meaningful
 * with exactly 2 players and a resolved `selfSlot` (see opts.selfPlayerNames on
 * computeMatchStats below) - the "you"/"they" framing doesn't make sense without knowing
 * which player is the viewer.
 *
 * This is inherently a heuristic, not precise analysis - there's no unit-kill or
 * unit-value tracking, only aggregate supply_used, so a fight where both sides trade
 * cheap units for expensive ones would look identical to one that traded evenly. The
 * thresholds above are tuned by eye against real replays, not derived formally - expect
 * to retune them once more games have gone through this.
 */
function computeKeyMoment(samples, players, selfSlot, selfEcon) {
  if (selfSlot == null || players.size !== 2) return null;
  const opponentSlot = [...players.keys()].find(s => s !== selfSlot);
  if (opponentSlot == null) return null;

  const mySamples = samples.filter(s => s.player === selfSlot).sort((a, b) => a.frame - b.frame);
  const theirSamples = samples.filter(s => s.player === opponentSlot).sort((a, b) => a.frame - b.frame);
  const myDip = findWorstSupplyDip(mySamples);
  const theirDip = findWorstSupplyDip(theirSamples);

  if (myDip.worstDip >= MIN_SUPPLY_DIP || theirDip.worstDip >= MIN_SUPPLY_DIP) {
    // Whichever side took the bigger single hit is the more notable fight - doesn't
    // require the two dips to line up in time (a lopsided fight only shows up as a big
    // dip for the losing side anyway, since the winning side's production isn't
    // interrupted).
    if (myDip.worstDip >= theirDip.worstDip) {
      const timeSeconds = (myDip.worstDipFrame * FRAME_TO_MS) / 1000;
      const t = formatClock(timeSeconds);
      return { type: 'fight', text: `Rough fight around ${t} - you dropped ${Math.round(myDip.worstDip)} supply`, timeSeconds };
    }
    const timeSeconds = (theirDip.worstDipFrame * FRAME_TO_MS) / 1000;
    const t = formatClock(timeSeconds);
    return { type: 'fight', text: `Big fight around ${t} - they dropped ${Math.round(theirDip.worstDip)} supply`, timeSeconds };
  }

  if (selfEcon.longestSupplyBlockedStreakSeconds >= MIN_SUPPLY_BLOCK_STREAK_SECONDS) {
    const t = formatClock(selfEcon.longestSupplyBlockedStreakStartSeconds ?? 0);
    return {
      type: 'macro',
      text: `Supply blocked for ${Math.round(selfEcon.longestSupplyBlockedStreakSeconds)}s starting at ${t}`,
      timeSeconds: selfEcon.longestSupplyBlockedStreakStartSeconds ?? 0,
    };
  }
  if (selfEcon.peakUnspentMinerals >= MIN_PEAK_FLOAT_MINERALS) {
    const t = formatClock(selfEcon.peakUnspentMineralsTimeSeconds);
    return {
      type: 'macro',
      text: `Floated ${Math.round(selfEcon.peakUnspentMinerals)} minerals around ${t}`,
      timeSeconds: selfEcon.peakUnspentMineralsTimeSeconds,
    };
  }
  return null;
}

/**
 * Determines the winner using whichever signal is available, in order of trust:
 *  1. Engine-computed victory_state (3 = victory, 2 = defeated/left) - reflects the
 *     map's own trigger system having explicitly fired victory/defeat.
 *  2. Direct building-elimination check (buildingCount) - a player with zero
 *     buildings remaining at the final simulated frame is eliminated under BW's
 *     standard melee win condition. Catches cases where the recording ends before
 *     the trigger system gets around to firing (checked ~once every several frames,
 *     not instantly) but the actual game state already shows a clear loser.
 *  3. "Leave Game" command order - first player to leave is treated as the loser.
 *     The command stream's playerId is NOT the 0-based slot index (it must be
 *     resolved against the header's per-slot player_id field, same as OpenBW itself
 *     does internally) - get this wrong and it silently attributes leaves to an
 *     empty slot instead of a real player. Once fixed, validated against 35 real
 *     tournament replays: on the 26 where victory_state also resolved, leave-order
 *     agreed with it on all 26 (0 disagreements) - strong cross-validation that both
 *     signals are correct, not just individually plausible.
 *  4. Chat concession ("gg") - lowest-confidence tier, only reached when none of the
 *     above fired. Ladder replays saved from StarCraft: Remastered's AutoSave folder
 *     commonly end on an ungraceful disconnect (alt-F4, crash, or a real network drop)
 *     with no formal Leave Game command at all - the recording just stops mid-action
 *     for both players within a second or two of each other. When that happens, the
 *     first player to type a "gg"-type message is treated as the loser, matching
 *     normal community etiquette (the losing player concedes first). Cross-checked
 *     against a game with a known outcome (victory_state) where the confirmed loser's
 *     "gg" matched this signal, and against a real replay where the in-game chat log's
 *     visible sender attribution matched this signal exactly once the chat payload was
 *     decoded correctly (see findChatEvents in commandStream.js for the byte-layout
 *     details - CHAT's sender is the payload's own first byte, not the usual outer
 *     command envelope's playerId). This is inherently weaker than the other tiers:
 *     someone can type "gg" while winning, or after the outcome is already effectively
 *     decided but before actually losing, so treat results from this tier as a
 *     best-effort guess, not a confirmed outcome.
 *  5. Self-recorder abandonment - lowest-confidence tier, only used when the caller
 *     identifies which player recorded this replay themselves (`selfSlot`, resolved
 *     from `opts.selfPlayerNames` - see computeMatchStats) AND every tier above,
 *     including chat concession, still found nothing. A replay recorded by your own
 *     client can only contain frames your client actually received - the instant you
 *     leave a game (menu, alt-F4, or otherwise), your own recording hard-stops right
 *     there, with no guarantee the Leave Game command (or a "gg") made it in before
 *     that cutoff. So when nothing else explains an abrupt stop in a replay you know
 *     you recorded yourself, the abrupt stop *is* the signal: you're the one who left,
 *     which on ladder is normally what the losing player does. This doesn't apply to
 *     replays recorded by someone else (an observer, a tournament caster, or your
 *     opponent) - there, an abrupt stop says nothing about which side left, since it
 *     wasn't your own connection that determined when the recording ends. Callers must
 *     only pass `selfPlayerNames` for replays they know were self-recorded (e.g. from
 *     StarCraft: Remastered's own AutoSave folder).
 * Returns { winnerSlot, loserSlot, method } or { method: 'unknown' } if nothing fired.
 */
function determineResult(players, victoryState, buildingCount, leaveEvents, slotByPlayerId, chatEvents, selfSlot) {
  const victors = [...victoryState.entries()].filter(([, s]) => s === 3).map(([slot]) => slot);
  const defeated = [...victoryState.entries()].filter(([, s]) => s === 2).map(([slot]) => slot);
  if (victors.length === 1) {
    const winnerSlot = victors[0];
    const loserSlot = [...players.keys()].find(s => s !== winnerSlot);
    return { winnerSlot, loserSlot, method: 'victory_state' };
  }
  if (defeated.length === 1 && players.size === 2) {
    const loserSlot = defeated[0];
    const winnerSlot = [...players.keys()].find(s => s !== loserSlot);
    return { winnerSlot, loserSlot, method: 'victory_state' };
  }
  if (players.size === 2) {
    const withZero = [...players.keys()].filter(s => buildingCount.get(s) === 0);
    const withSome = [...players.keys()].filter(s => (buildingCount.get(s) ?? 0) > 0);
    if (withZero.length === 1 && withSome.length === 1) {
      return { winnerSlot: withSome[0], loserSlot: withZero[0], method: 'building_elimination' };
    }
  }
  if (leaveEvents.length > 0) {
    const firstLeave = leaveEvents[0];
    const loserSlot = slotByPlayerId.get(firstLeave.playerId);
    const winnerSlot = [...players.keys()].find(s => s !== loserSlot);
    if (loserSlot != null && winnerSlot != null) {
      return { winnerSlot, loserSlot, method: 'leave_game_order' };
    }
  }
  if (chatEvents && chatEvents.length > 0) {
    const ggPattern = /\bgg\b/i;
    const firstGg = chatEvents.find(e => players.has(e.senderSlot) && ggPattern.test(e.text));
    if (firstGg) {
      const loserSlot = firstGg.senderSlot;
      const winnerSlot = [...players.keys()].find(s => s !== loserSlot);
      if (winnerSlot != null) {
        return { winnerSlot, loserSlot, method: 'chat_concession' };
      }
    }
  }
  if (selfSlot != null && players.has(selfSlot)) {
    const winnerSlot = [...players.keys()].find(s => s !== selfSlot);
    if (winnerSlot != null) {
      return { winnerSlot, loserSlot: selfSlot, method: 'self_recorder_left' };
    }
  }
  return { method: 'unknown' };
}

/**
 * Runs the full replay -> stats pipeline for a single .rep file.
 *
 * @param {object} opts
 * @param {string} opts.replayPath - path to the .rep file
 * @param {string} opts.installPath - StarCraft: Remastered install directory
 * @param {string} opts.bwstatsPath - path to the compiled bwstats.exe
 * @param {number} [opts.sampleIntervalFrames] - CSV sampling granularity (default 24 = ~1s)
 * @param {string} [opts.workDir] - scratch dir for the decoded header/commands/map buffers
 *   (defaults to a fresh os.tmpdir() subfolder, cleaned up afterward)
 * @param {string[]} [opts.selfPlayerNames] - in-game name(s) of whoever's own client
 *   recorded this replay (e.g. your ladder handle(s)). ONLY pass this for replays you
 *   know were self-recorded (StarCraft: Remastered's AutoSave folder, not a tournament/
 *   observer replay) - enables the lowest-confidence "self-recorder abandonment"
 *   fallback tier in determineResult. Matched case-insensitively, exact after trimming.
 */
export async function computeMatchStats(opts) {
  const {
    replayPath,
    installPath,
    bwstatsPath,
    sampleIntervalFrames = 24,
    selfPlayerNames,
  } = opts;

  const fileBuffer = fs.readFileSync(replayPath);
  const { header, commands, map } = decodeReplayContainer(fileBuffer);

  const workDir = opts.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bw-stats-'));
  const headerPath = path.join(workDir, 'header.bin');
  const commandsPath = path.join(workDir, 'commands.bin');
  const mapPath = path.join(workDir, 'map.bin');
  fs.writeFileSync(headerPath, header);
  fs.writeFileSync(commandsPath, commands);
  fs.writeFileSync(mapPath, map);

  try {
    const stdout = await runBwstats({ bwstatsPath, installPath, headerPath, commandsPath, mapPath, sampleIntervalFrames });
    const { players, samples, victoryState, buildingCount } = parseBwstatsOutput(stdout);

    const durationFrames = header.readUInt32LE(1);
    const durationSeconds = (durationFrames * FRAME_TO_MS) / 1000;
    // Map name lives at a fixed 26-byte field in the decompressed header (offset 97),
    // same layout independently confirmed against BW-Replay-Utilities' reverse-engineering
    // notes during development. UTF-8 encoded, not latin1 - confirmed against a real
    // replay of the Korean-named map "Fighting Spirit": decoding as latin1 produced
    // mojibake, decoding as utf8 produced the correct Korean title text. Strip the null
    // padding and any embedded BW color-code control characters (e.g. \x03, \x06) rather
    // than the raw bytes.
    const mapName = header.subarray(97, 97 + 26).toString('utf8').replace(/\0.*$/s, '')
      .replace(/[\x00-\x1f]/g, '');

    const leaveEvents = findLeaveGameEvents(commands);
    // Leave Game's `playerId` is the raw in-replay player id, NOT the 0-based slot -
    // OpenBW itself resolves this the same way (see replay.h's read_action: it looks
    // the raw byte up against action_st.player_id[], populated from this exact header
    // field, to find the owning slot). The 12-slot player block starts at a fixed
    // header offset (633-byte decompressed header, confirmed against both this
    // project's own header-field derivation and BW-Replay-Utilities' independent
    // reverse-engineering notes), 36 bytes per slot: 4 bytes unknown/"slot", then a
    // 4-byte player_id, then controller/race/force/name.
    // Only map the slots we already know are actually occupied (from bwstats.exe's
    // player list) - unused slots' player_id fields default to colliding values
    // (observed: 0), which would otherwise silently overwrite a real slot's entry
    // and misattribute every leave event to whichever empty slot is enumerated last.
    const PLAYER_BLOCK_OFFSET = 161;
    const PLAYER_SLOT_SIZE = 36;
    const slotByPlayerId = new Map();
    for (const slot of players.keys()) {
      const playerId = header.readUInt32LE(PLAYER_BLOCK_OFFSET + slot * PLAYER_SLOT_SIZE + 4);
      slotByPlayerId.set(playerId, slot);
    }

    const chatEvents = findChatEvents(commands);
    let selfSlot = null;
    if (selfPlayerNames && selfPlayerNames.length > 0) {
      const normalizedSelfNames = new Set(selfPlayerNames.map(n => n.trim().toLowerCase()));
      for (const [slot, info] of players) {
        if (normalizedSelfNames.has((info.name || '').trim().toLowerCase())) {
          selfSlot = slot;
          break;
        }
      }
    }
    const result = determineResult(players, victoryState, buildingCount, leaveEvents, slotByPlayerId, chatEvents, selfSlot);

    const perPlayer = {};
    for (const [slot, info] of players) {
      const playerSamples = samples.filter(s => s.player === slot);
      const econ = computePlayerEconomyStats(playerSamples, sampleIntervalFrames);
      perPlayer[slot] = {
        ...info,
        ...econ,
        result: result.method === 'unknown' ? 'unknown' : (slot === result.winnerSlot ? 'win' : 'loss'),
      };
    }

    const keyMoment = selfSlot != null ? computeKeyMoment(samples, players, selfSlot, perPlayer[selfSlot]) : null;

    // The graded report card for the advanced post-match overlay. Null for anything it
    // can't grade fairly (a game too short to have macro to judge, a non-1v1, an
    // unidentified self player, or samples from a bwstats.exe predating the extra
    // columns) - callers treat that as "show the plain stats instead".
    const gradeInputs = {
      samples,
      players,
      selfSlot,
      sampleIntervalFrames,
      actionsByPlayerId: countActionsByPlayerId(commands),
      slotByPlayerId,
    };
    const grades = gradeMatch({ ...gradeInputs, calibration: opts.calibration });

    return {
      durationSeconds,
      resultMethod: result.method,
      mapName,
      players: perPlayer,
      keyMoment,
      grades,
      // The raw, ungraded measurements. Training (src/trainer.js) collects these across a
      // batch of replays to build the calibration that `opts.calibration` later supplies;
      // normal reviews ignore the field.
      gradeMetrics: extractMetrics(gradeInputs),
    };
  } finally {
    if (!opts.workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}
