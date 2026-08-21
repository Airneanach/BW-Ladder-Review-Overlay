// Ties a live match's lifecycle to a Twitch Prediction: opens one when the live scanner
// (liveScanner.js, off matchStartDetector.js) reports a ladder game has started, locks
// it the instant the game ends, and resolves it once the replay is graded. Mirrors the
// sibling bot's broodwarTracker.js state machine, but against the local JSON MatchStore
// instead of SQLite, and for one broadcaster instead of many.
//
// Every Twitch call here is wrapped so failure degrades to "no prediction this game" -
// it must never stop a match from being tracked or a replay from being reviewed. Every
// real call also reports its outcome into twitchLink's health record (see twitchLink.js)
// so the settings UI's status line reflects what actually just happened on Twitch, not
// a guess.

import { createPrediction, lockPrediction, resolvePrediction, cancelPrediction } from './twitchPredictions.js';
import { pickResult } from './matchStore.js';

function applyTemplate(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => {
    if (vars[key]) return vars[key];
    if (key === 'opponent') return 'their opponent';
    return '';
  });
}

export class Predictions {
  /**
   * @param {import('./twitchLink.js').TwitchLink} twitchLink
   * @param {() => import('./matchStore.js').MatchStore} getStore - read live rather than
   *   captured once: the review server rebuilds its MatchStore on every restart (e.g. a
   *   port change), so a store reference taken at construction time would go stale.
   * @param {() => object} getSettings - read live, since toggles can change mid-session
   */
  constructor({ twitchLink, getStore, getSettings }) {
    this.twitchLink = twitchLink;
    this.getStore = getStore;
    this.getSettings = getSettings;
  }

  _reportOk(message) {
    this.twitchLink.setHealth(true, `Connected as ${this.twitchLink.loginName()}. ${message}`);
  }

  _reportFail(message) {
    this.twitchLink.setHealth(false, `Last prediction attempt failed: ${message}`);
  }

  /** Called from liveScanner.js's onMatchStart. Opens the prediction and a pending row. */
  async handleMatchStart({ myName, opponentName }) {
    const settings = this.getSettings();
    let predictionId = null, winOutcomeId = null, loseOutcomeId = null, predictionError = null;

    if (settings.twitchAutoPredictionsEnabled && this.twitchLink.isLinked()) {
      try {
        const title = applyTemplate(settings.predictionTitleTemplate, { opponent: opponentName });
        const prediction = await createPrediction(this.twitchLink, {
          title,
          outcomeLabels: [settings.predictionWinLabel || 'Win', settings.predictionLoseLabel || 'Lose'],
          windowSeconds: settings.predictionWindowSeconds || 300,
        });
        predictionId = prediction.id;
        winOutcomeId = prediction.outcomes?.[0]?.id ?? null;
        loseOutcomeId = prediction.outcomes?.[1]?.id ?? null;
        this._reportOk('Prediction opened for this game.');
      } catch (err) {
        predictionError = err.message;
        this._reportFail(err.message);
      }
    }

    const row = this.getStore().addPending({ myName, opponentName, twitchPredictionId: predictionId, winOutcomeId, loseOutcomeId, predictionError });
    return { matchId: row.id, predictionId, predictionError };
  }

  /**
   * Called from liveScanner.js's onGameEnd. Locking is best-effort: Twitch only accepts
   * it from ACTIVE, so a prediction whose window already elapsed reports an error here
   * that just means "already locked" - the desired state anyway, and not something that
   * should stop the match being marked over.
   */
  async handleGameOver(matchId) {
    const row = this.getStore().markGameOver(matchId);
    if (!row?.twitch_prediction_id) return { locked: false };
    try {
      await lockPrediction(this.twitchLink, row.twitch_prediction_id);
      this._reportOk('Prediction locked at game-over.');
      return { locked: true };
    } catch (err) {
      return { locked: false, error: err.message };
    }
  }

  /**
   * Called from reviewServer.js's review(), once a replay has been graded. Finds the
   * pending row this replay belongs to (see MatchStore.findPendingForFinish - there's
   * no direct channel carrying a matchId from the live scanner into the replay watcher,
   * they're two independent signals), resolves or cancels its prediction, and completes
   * the row. Returns null if there's no pending row (predictions never turned on, or a
   * replay reviewed without ever seeing a live match-start for it) - the caller falls
   * back to `store.add()` in that case.
   */
  async resolveForFinishedMatch(stats, { replayPath, playerNames }) {
    const row = this.getStore().findPendingForFinish();
    if (!row) return null;

    if (row.twitch_prediction_id) {
      try {
        if (!row.ended_at) {
          // The scanner never reported this game over - it wasn't running, or the lock
          // at game-over failed - so the prediction can still be ACTIVE and taking bets
          // on a match that's already finished. Close it before deciding it.
          try { await lockPrediction(this.twitchLink, row.twitch_prediction_id); } catch { /* already locked/resolved */ }
        }

        const { result } = pickResult(stats, playerNames);
        if (result === 'unknown') {
          await cancelPrediction(this.twitchLink, row.twitch_prediction_id);
        } else {
          const winningOutcomeId = result === 'win' ? row.win_outcome_id : row.lose_outcome_id;
          if (!winningOutcomeId) throw new Error('outcome id for this prediction was never recorded on the match row');
          await resolvePrediction(this.twitchLink, row.twitch_prediction_id, winningOutcomeId);
        }
        this._reportOk('Prediction resolved for the finished game.');
      } catch (err) {
        row.prediction_error = err.message;
        this._reportFail(err.message);
      }
    }

    return this.getStore().finishPending(row, stats, { replayPath, playerNames });
  }

  /**
   * Real create-then-cancel round trip against Twitch, so "will this actually work?"
   * has a positive, on-demand answer instead of only ever being found out during (or
   * after) a real ladder game.
   */
  async sendTestPrediction() {
    if (!this.twitchLink.isLinked()) throw new Error('Twitch is not linked yet.');
    const settings = this.getSettings();
    try {
      const prediction = await createPrediction(this.twitchLink, {
        title: 'Test prediction from BW Ladder Review',
        outcomeLabels: [settings.predictionWinLabel || 'Win', settings.predictionLoseLabel || 'Lose'],
        windowSeconds: 30,
      });
      await cancelPrediction(this.twitchLink, prediction.id);
      this._reportOk('Test prediction succeeded.');
    } catch (err) {
      this._reportFail(err.message);
      throw err;
    }
  }
}
