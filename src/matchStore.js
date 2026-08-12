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
   * Turns one computeMatchStats() result into a row and stores it.
   *
   * `playerNames` identifies which player is the local one. When it matches nobody -
   * either because it is unset or because the player used an alias this run - the match
   * is still recorded, from the perspective of no one: result 'unknown' and no grades,
   * which the overlay already handles by falling back to its plain layout.
   */
  add(stats, { replayPath, playerNames }) {
    const players = Object.values(stats.players);
    const normalized = new Set(playerNames.map(n => n.toLowerCase()));
    const me = players.find(p => normalized.has((p.name || '').trim().toLowerCase())) ?? null;
    const opponent = me ? players.find(p => p.slot !== me.slot) ?? null : null;

    const row = {
      id: this.nextId++,
      replay_filename: path.basename(replayPath),
      reviewed_at: new Date().toISOString(),
      map_name: stats.mapName || null,
      duration_seconds: stats.durationSeconds ?? null,
      // 'unknown' rather than 'pending': the overlay skips anything still pending, and a
      // match we genuinely cannot attribute is finished, not in progress.
      result: me ? me.result : 'unknown',
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

    // Newest first, which is the order the overlay's `limit=1` relies on.
    this.rows.unshift(row);
    if (this.rows.length > MAX_ROWS) this.rows.length = MAX_ROWS;
    this.save();
    return row;
  }

  list(limit = 1) {
    return this.rows.slice(0, Math.max(1, limit));
  }
}
