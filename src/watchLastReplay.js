// Watches LastReplay.rep for a finished write and fires once per game.
//
// The original companion used chokidar for this. This is a hand-rolled poll instead,
// for one concrete reason: the shipped build is a Node single-executable, which bundles
// one script and no node_modules, so every dependency dropped here is one less thing
// the build has to solve. The behaviour that actually mattered from chokidar was
// `awaitWriteFinish` - not firing while SC:R is still writing the file - which is a
// dozen lines of mtime/size comparison.

import fs from 'node:fs';

const POLL_MS = 1000;
// SC:R writes the replay in one go, but the write is not atomic and a large game's file
// takes a moment. Two consecutive identical (size, mtime) readings means the write has
// settled. Three seconds of stability is what chokidar was configured with here, and it
// never produced a truncated read.
const STABLE_POLLS = 3;

/**
 * Calls `onReplay(path)` once each time the file is rewritten and has stopped changing.
 *
 * Fires on first appearance too, so starting the app before StarCraft exists is fine.
 * Deliberately does NOT fire for the file that is already on disk at startup - that is
 * the previous session's game, and reviewing it on every launch would put a stale match
 * on stream.
 *
 * Returns a stop function.
 */
export function watchLastReplay(replayPath, onReplay) {
  // Seed from the file as it is now, so the game already sitting there is treated as
  // "already seen" rather than as a fresh result.
  let lastSeen = signature(replayPath);
  let pending = null;
  let stablePolls = 0;

  function signature(file) {
    try {
      const st = fs.statSync(file);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return null; // not there yet
    }
  }

  const timer = setInterval(() => {
    const sig = signature(replayPath);
    if (sig === null || sig === lastSeen) return;

    if (sig === pending) {
      // Unchanged since the last poll - count it toward the write having settled.
      if (++stablePolls >= STABLE_POLLS) {
        lastSeen = sig;
        pending = null;
        stablePolls = 0;
        onReplay(replayPath);
      }
      return;
    }
    // Still changing (or newly changed): restart the stability count.
    pending = sig;
    stablePolls = 0;
  }, POLL_MS);

  // Nothing here should keep the process alive on its own; the HTTP server does that.
  timer.unref?.();
  return () => clearInterval(timer);
}
