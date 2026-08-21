// Holds reviewed matches and converts them into the row shape the overlay page reads.
//
// The overlay was originally written against the Platinum Bot server, which served rows
// straight out of SQLite - so it expects snake_case columns and `grades_json` as a JSON
// *string*, not a nested object. That shape is reproduced exactly here rather than
// changing the page, so the page stays a drop-in copy of the one the bot serves and the
// two cannot drift apart.

import fs from 'node:fs';
import path from 'node:path';

// bwstats.exe reports race as an index, matching OpenBW's ordering. The overlay wants the
// lowercase name.
const RACE_NAMES = ['zerg', 'terran', 'protoss'];

// How many reviewed games to keep. The overlay only ever asks for the most recent, but
// keeping a short history makes /api/bw/matches useful for a scrollback panel or for
// checking what happened without re-running a replay.
const MAX_ROWS = 50;

/**
 * Which computeMatchStats() player is "me", and this match's result from their side.
 * Exported (not just used internally by `_buildFinishedFields`) because predictions.js
 * needs the same answer before the row exists, to decide which Twitch outcome id won -
 * duplicating this matching logic there would be exactly the kind of drift that made
 * the two eventually disagree about who the local player was.
 */
export function pickResult(stats, playerNames) {
  const players = Object.values(stats.players);
  const normalized = new Set(playerNames.map(n => n.toLowerCase()));
  const me = players.find(p => normalized.has((p.name || '').trim().toLowerCase())) ?? null;
  const opponent = me ? players.find(p => p.slot !== me.slot) ?? null : null;
  return { players, me, opponent, result: me ? me.result : 'unknown' };
}

export class MatchStore {
  constructor({ persistPath = null } = {}) {
    this.persistPath = persistPath;
    this.rows = [];
    this.nextId = 1;
    this.load();
  }

  load() {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      if (Array.isArray(saved.matches)) {
        this.rows = saved.matches;
        this.nextId = this.rows.reduce((max, r) => Math.max(max, r.id || 0), 0) + 1;
      }
    } catch (err) {
      console.warn(`[store] Could not read match history, starting empty: ${err.message}`);
    }
  }

  save() {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify({ matches: this.rows }, null, 2));
    } catch (err) {
      // Losing history is not worth taking the overlay down for.
      console.warn(`[store] Could not save match history: ${err.message}`);
    }
  }

  /**
   * Builds the "finished" half of a row from a computeMatchStats() result. Shared by
   * `add()` (a replay reviewed with no live prediction in flight) and `finishPending()`
   * (completing a row a live match-start already opened), so the two can never build
   * a differently-shaped row for what the overlay treats as the same kind of thing.
   *
   * `playerNames` identifies which player is the local one. When it matches nobody -
   * either because it is unset or because the player used an alias this run - the match
   * is still recorded, from the perspective of no one: result 'unknown' and no grades,
   * which the overlay already handles by falling back to its plain layout.
   */
  _buildFinishedFields(stats, { replayPath, playerNames }) {
    const { players, me, opponent, result } = pickResult(stats, playerNames);

    return {
      replay_filename: path.basename(replayPath),
      reviewed_at: new Date().toISOString(),
      map_name: stats.mapName || null,
      duration_seconds: stats.durationSeconds ?? null,
      // 'unknown' rather than 'pending': list() skips anything still pending, and a
      // match we genuinely cannot attribute is finished, not in progress.
      result,
      result_method: stats.resultMethod ?? null,
      my_name: me?.name ?? null,
      my_race: me ? RACE_NAMES[me.race] ?? null : null,
      opponent_name: opponent?.name ?? null,
      opponent_race: opponent ? RACE_NAMES[opponent.race] ?? null : null,
      supply_blocked_seconds: me?.supplyBlockedSeconds ?? null,
      avg_unspent_minerals: me?.avgUnspentMinerals ?? null,
      avg_unspent_gas: me?.avgUnspentGas ?? null,
      key_moment_type: stats.keyMoment?.type ?? null,
      key_moment_text: stats.keyMoment?.text ?? null,
      key_moment_time_seconds: stats.keyMoment?.timeSeconds ?? null,
      // Stringified to match what the bot's SQLite column held; the page JSON.parses it.
      grades_json: stats.grades ? JSON.stringify(stats.grades) : null,
      // Kept out of the overlay's way but useful for anyone pointing their own graphics
      // at this server: every player, not just the local one.
      all_players: players.map(p => ({
        slot: p.slot,
        name: p.name,
        race: RACE_NAMES[p.race] ?? null,
        result: p.result,
        supply_blocked_seconds: p.supplyBlockedSeconds ?? null,
        avg_unspent_minerals: p.avgUnspentMinerals ?? null,
        avg_unspent_gas: p.avgUnspentGas ?? null,
      })),
    };
  }

  /** Turns one computeMatchStats() result into a row and stores it. */
  add(stats, { replayPath, playerNames }) {
    const row = {
      id: this.nextId++,
      ...this._buildFinishedFields(stats, { replayPath, playerNames }),
    };

    // Newest first, which is the order the overlay's `limit=1` relies on.
    this.rows.unshift(row);
    if (this.rows.length > MAX_ROWS) this.rows.length = MAX_ROWS;
    this.save();
    return row;
  }

  /**
   * Opens a row the moment a live ladder match starts, before there's anything to
   * review yet - so a Twitch Prediction's outcome ids have somewhere durable to live
   * from the instant they're created. Persisting them here rather than holding them in
   * memory is deliberate: an in-memory-only version of this is exactly the bug that was
   * just fixed in the sibling bot's tracker (a restart between match-start and
   * match-end permanently stranded the prediction), and this app is meant to survive
   * being closed and reopened between games.
   */
  addPending({ myName, opponentName, twitchPredictionId, winOutcomeId, loseOutcomeId, predictionError }) {
    const row = {
      id: this.nextId++,
      result: 'pending',
      started_at: new Date().toISOString(),
      ended_at: null,
      my_name: myName ?? null,
      opponent_name: opponentName ?? null,
      twitch_prediction_id: twitchPredictionId ?? null,
      win_outcome_id: winOutcomeId ?? null,
      lose_outcome_id: loseOutcomeId ?? null,
      prediction_error: predictionError ?? null,
      replay_filename: null, reviewed_at: null, map_name: null, duration_seconds: null,
      result_method: null, my_race: null, opponent_race: null,
      supply_blocked_seconds: null, avg_unspent_minerals: null, avg_unspent_gas: null,
      key_moment_type: null, key_moment_text: null, key_moment_time_seconds: null,
      grades_json: null, all_players: [],
    };
    this.rows.unshift(row);
    if (this.rows.length > MAX_ROWS) this.rows.length = MAX_ROWS;
    this.save();
    return row;
  }

  /** Stamps a pending row the instant the live scanner reports the game over. */
  markGameOver(matchId) {
    const row = this.rows.find(r => r.id === matchId && r.result === 'pending');
    if (!row) return null;
    row.ended_at = new Date().toISOString();
    this.save();
    return row;
  }

  /**
   * Which pending row a just-finished replay belongs to. There's no channel carrying a
   * matchId from the live scanner down into the replay watcher - they're two
   * independent signals (memory reader vs. filesystem) - so this is always resolved by
   * position instead: games are played and their replays written one at a time, in
   * order, so an arriving replay belongs to the *oldest* still-pending row. A row the
   * scanner has already marked ended (`ended_at` set) is preferred over one still
   * nominally in progress, so a game actually being played right now can never be
   * closed out by the previous game's replay.
   */
  findPendingForFinish() {
    const pending = this.rows.filter(r => r.result === 'pending').reverse(); // oldest first
    return pending.find(r => r.ended_at) || pending[0] || null;
  }

  /** Completes a pending row in place with a finished match's stats. */
  finishPending(row, stats, { replayPath, playerNames }) {
    Object.assign(row, this._buildFinishedFields(stats, { replayPath, playerNames }));
    if (!row.ended_at) row.ended_at = row.reviewed_at;
    // Moves to "most recent" only now that it's actually finished, matching add()'s
    // ordering - a pending row sat at whatever position it was inserted at, which by
    // the time it finishes is no longer "most recent" if another game has since ended.
    const idx = this.rows.indexOf(row);
    if (idx > 0) {
      this.rows.splice(idx, 1);
      this.rows.unshift(row);
    }
    if (this.rows.length > MAX_ROWS) this.rows.length = MAX_ROWS;
    this.save();
    return row;
  }

  list(limit = 1) {
    return this.rows.filter(r => r.result !== 'pending').slice(0, Math.max(1, limit));
  }
}
