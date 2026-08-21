// Decides when a live 1v1 ladder game has started and when it has ended, from the
// live scanner's own state feed (native/bwfind.exe overlay mode, republished by
// liveScanner.js). This is the trigger for opening a Twitch Prediction - the
// counterpart to watchLastReplay.js, which handles the stats half of a match off
// LastReplay.rep.
//
// Why a live memory-reading scanner and not the window title: a sibling project
// (the live production overlay in bw-companion) tried watching StarCraft:
// Remastered's window title for a menu -> match transition first. Observed
// against a real 13-game ladder session, the title never changed once - not on
// any of the game starts, not on any of the ends, only to "" when the game
// closed. There is no transition there to watch, so match-start would never fire
// and no prediction would ever open.
//
// bw-companion already solved live-game detection for its production overlay
// (native/bwfind.exe, a standalone memory reader - see its WHY_THIS_WAS_HARD.md
// and OFFSET_DISCOVERY.md for how), so this reuses that answer rather than
// inventing a second one.
//
// Nothing here infers anything from how much time has passed between games. Game
// start and game end are both observed events, so both are handled as events: the
// moment a game ends, the match it belongs to is closed out and the detector is
// primed again. Two games back to back with no gap at all is an ordinary case, not
// something to be defended against.

// How long a game has to keep running before a prediction is opened on it.
//
// This is the one deliberate wait in here, and it is not a debounce - it is the
// instant-leave window. A meaningful share of ladder opponents quit within the
// first seconds: on 2026-08-10 one of thirteen games lasted 4 seconds and another
// 8. Opening a prediction on those means chat betting on a match that is already
// over. Nothing is scheduled and nothing has to be cancelled - firing requires a
// tick that still qualifies, so a game that ends inside the hold never fires.
const DEFAULT_HOLD_MS = 5000;

// A torn memory walk can drop a unit - and so a whole player - out of one tick.
// That must not restart the hold, or a game that tears every few seconds would
// keep pushing its own prediction further away. A few consecutive failures is
// tearing; more than that is a real change in what is being played. Firing always
// requires a genuinely qualifying tick, so this only affects whether the clock
// restarts, never whether a bad tick can open a prediction.
const TORN_TICK_GRACE = 5;

// Not every line without `players` means there is no game. These three do: "no
// game" is emitted when the unit lists are empty, "game over" when the game state
// has stopped changing, and "waiting for a game" once at reader startup. They are
// the authoritative end-of-game signal this whole file is built on.
//
// "locating resource arrays" is the one that matters most here, and it means the
// opposite: the scanner only reaches it *after* finding units, so it is emitted
// while a game is running and its resource base has gone stale. Treating it as an
// ended game would close out a match mid-play and re-prime us to open a second
// prediction on it. Anything else (a dead reader, a stalled feed) is genuinely
// unknown and is ignored rather than guessed at - it neither ends a match nor
// cancels a hold in progress.
const END_OF_GAME_STATUSES = new Set(['no game', 'game over', 'waiting for a game']);

/**
 * Creates the match lifecycle state machine.
 *
 * `feed(state)` takes one parsed scanner line (either a `{status, healthy}` line
 * or a full `{frame, players: [...]}` tick) and calls:
 *
 *  - `onMatchStart({myName, opponentName, heldMs})` once a game has been a live
 *    1v1 this player is playing in continuously for `holdMs`;
 *  - `onGameEnd({heldMs})` the moment that game ends, but only if a match-start
 *    was fired for it - so the caller can close out the match (and with it the
 *    prediction) rather than leaving it open until the replay is parsed.
 *
 * The detector is primed for the next game on that same end-of-game signal, with
 * no cooldown: if another game starts a second later, it is treated as a new game.
 *
 * @param {object} opts
 * @param {string[]} opts.myInGameNames - the streamer's in-game name(s), matched
 *   case-insensitively after trimming, same convention as computeMatchStats.
 * @param {number} [opts.holdMs] - how long a game must survive before firing.
 * @param {(info: {myName: string, opponentName: string|null, heldMs: number}) => void} opts.onMatchStart
 * @param {(info: {heldMs: number}) => void} [opts.onGameEnd]
 * @param {(msg: string) => void} [opts.log]
 */
export function createMatchStartDetector({
  myInGameNames = [],
  holdMs = DEFAULT_HOLD_MS,
  onMatchStart,
  onGameEnd = () => {},
  log = () => {},
}) {
  const normalizedSelfNames = new Set(myInGameNames.map((n) => String(n).trim().toLowerCase()));

  let qualifyingSince = 0;   // when the current run of qualifying ticks began
  let failingTicks = 0;      // consecutive game ticks that failed the ladder test
  let firedAt = 0;           // when this game's match-start fired (0 = not fired)
  let inGame = false;        // have we seen a qualifying tick since the last end-of-game
  let loggedRejectionFor = null;

  /**
   * Is this tick a live 1v1 ladder game that we are playing in?
   *
   * Three separate things have to be true, and each excludes a different way of
   * being wrong:
   *
   *  - `frame < 0` excludes replays. The scanner reports the counter at
   *    module+0xdd60a8, which advances while a REPLAY plays and reads -1 the rest
   *    of the time, live games included (OFFSET_DISCOVERY.md, "Replay playback
   *    counter"). It is useless as a live-game clock, which is what it was
   *    originally mistaken for - but read the other way round it is exactly the
   *    signal needed here: a positive frame means a replay is playing, and
   *    watching your own replay would otherwise look identical to playing a game
   *    (same units in memory, same name in the player list).
   *  - exactly two players excludes team games, UMS lobbies and free-for-alls,
   *    where a win/lose prediction does not mean anything. (The scanner already
   *    drops neutral slot 11 from `players`.)
   *  - one of them being us excludes games we are only observing.
   */
  function isMyLadderGame(state) {
    if (!Array.isArray(state?.players)) return { ok: false, why: null }; // a status line, not a game tick
    if (!(state.frame < 0)) return { ok: false, why: 'a replay is playing (frame counter is running), not a live game' };
    if (state.players.length !== 2) return { ok: false, why: `${state.players.length} players in the game, not a 1v1` };
    const me = state.players.find((p) => normalizedSelfNames.has(String(p?.name || '').trim().toLowerCase()));
    if (!me) {
      const names = state.players.map((p) => p?.name).join(' vs ');
      return { ok: false, why: `none of myInGameNames are in this game (${names}) - observing, not playing` };
    }
    const opponent = state.players.find((p) => p.slot !== me.slot);
    return { ok: true, me, opponent };
  }

  return {
    feed(state) {
      if (!Array.isArray(state?.players)) {
        // Not an authoritative end-of-game signal: leave every bit of state as it is.
        if (!END_OF_GAME_STATUSES.has(state?.status)) return;
        if (!inGame) return; // already closed out; nothing to do but stay primed

        const heldMs = qualifyingSince ? Date.now() - qualifyingSince : 0;
        if (firedAt) {
          log(`game over - closing out the match so its prediction can be resolved. Primed for the next game.`);
          onGameEnd({ heldMs });
        } else if (qualifyingSince) {
          // The instant-leave case, reported rather than passed over in silence:
          // a game that was detected and then evaporated before it earned a
          // prediction, which is exactly what the hold is for.
          log(`game ended ${(heldMs / 1000).toFixed(1)}s in, before the ${(holdMs / 1000).toFixed(0)}s hold elapsed `
            + `- no prediction opened. Match-end still logs it normally once the replay is written.`);
        }

        // Primed again immediately. The next game can start a second from now.
        inGame = false;
        qualifyingSince = 0;
        failingTicks = 0;
        firedAt = 0;
        loggedRejectionFor = null;
        return;
      }

      const verdict = isMyLadderGame(state);
      if (!verdict.ok) {
        // Tolerate a few torn ticks without restarting the hold; past that, treat
        // it as a real change and start over.
        if (++failingTicks > TORN_TICK_GRACE) qualifyingSince = 0;
        // Say why exactly once per reason, so a game that is deliberately being
        // ignored is visible in the dashboard log instead of looking like a
        // failure of the trigger.
        if (verdict.why && loggedRejectionFor !== verdict.why) {
          loggedRejectionFor = verdict.why;
          log(`not opening a prediction: ${verdict.why}`);
        }
        return;
      }

      failingTicks = 0;
      inGame = true;
      if (firedAt) return; // this game already has its prediction

      const now = Date.now();
      if (!qualifyingSince) {
        qualifyingSince = now;
        log(`live ladder game detected (${verdict.me.name} vs ${verdict.opponent?.name || 'unknown'}) - `
          + `holding ${(holdMs / 1000).toFixed(0)}s in case they leave immediately`);
        return;
      }

      const heldMs = now - qualifyingSince;
      if (heldMs < holdMs) return;

      firedAt = now;
      loggedRejectionFor = null;
      onMatchStart({
        myName: verdict.me.name,
        opponentName: verdict.opponent?.name ?? null,
        heldMs,
      });
    },
  };
}
