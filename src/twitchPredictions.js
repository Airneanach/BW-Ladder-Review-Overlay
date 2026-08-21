// Twitch Helix Predictions API helper. Thin wrapper, no state of its own - every call
// takes a `TwitchLink` (src/twitchLink.js) and reads fresh credentials from it, which is
// also what keeps the access token refreshed transparently (ensureFreshToken() runs
// before every request).
//
// Twitch's real constraints on predictions (surfaced to the caller as thrown errors,
// not silently swallowed): broadcaster must be Affiliate/Partner with Channel Points
// enabled, 2-10 outcomes, prediction_window between 30 and 1800 seconds.

async function helixFetch(twitchLink, path, method, body) {
  await twitchLink.ensureFreshToken();
  const { accessToken, clientId } = twitchLink.getCredentials();
  const resp = await fetch(`https://api.twitch.tv/helix${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Client-Id': clientId,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const message = data?.message || `Helix request failed (${resp.status})`;
    throw new Error(`Twitch predictions API error: ${message}`);
  }
  return data;
}

/**
 * Opens a new Twitch Prediction.
 * @param {import('./twitchLink.js').TwitchLink} twitchLink
 * @param {object} opts
 * @param {string} opts.title - prediction title shown in chat
 * @param {[string, string]} opts.outcomeLabels - exactly two outcome labels (e.g. ['Win', 'Lose'])
 * @param {number} [opts.windowSeconds] - prediction window, clamped to Twitch's 30-1800s range
 * @returns {Promise<{id: string, outcomes: Array<{id: string, title: string}>}>}
 */
export async function createPrediction(twitchLink, { title, outcomeLabels, windowSeconds = 300 }) {
  if (!Array.isArray(outcomeLabels) || outcomeLabels.length !== 2) {
    throw new Error('createPrediction: outcomeLabels must be an array of exactly 2 labels');
  }
  const { broadcasterId } = twitchLink.getCredentials();
  const clampedWindow = Math.max(30, Math.min(1800, Math.round(windowSeconds)));

  const data = await helixFetch(twitchLink, '/predictions', 'POST', {
    broadcaster_id: broadcasterId,
    title: String(title).slice(0, 45),
    outcomes: outcomeLabels.map((label) => ({ title: String(label).slice(0, 25) })),
    prediction_window: clampedWindow,
  });

  const prediction = data.data?.[0];
  if (!prediction) throw new Error('createPrediction: Twitch returned no prediction data');
  return {
    id: prediction.id,
    outcomes: (prediction.outcomes || []).map((o) => ({ id: o.id, title: o.title })),
  };
}

/**
 * Locks a Prediction: viewers can no longer bet, but the outcome is not yet declared.
 * Twitch only accepts this from the ACTIVE state, so it throws if the prediction has
 * already locked itself (its window elapsed) or been resolved. Callers treat that as
 * a no-op rather than a failure.
 * @param {import('./twitchLink.js').TwitchLink} twitchLink
 * @param {string} predictionId
 */
export async function lockPrediction(twitchLink, predictionId) {
  const { broadcasterId } = twitchLink.getCredentials();
  await helixFetch(twitchLink, '/predictions', 'PATCH', {
    broadcaster_id: broadcasterId,
    id: predictionId,
    status: 'LOCKED',
  });
}

/**
 * Resolves a Prediction by declaring the winning outcome. Accepted by Twitch from
 * either ACTIVE or LOCKED, so a prediction that was never locked still resolves.
 * @param {import('./twitchLink.js').TwitchLink} twitchLink
 * @param {string} predictionId
 * @param {string} winningOutcomeId
 */
export async function resolvePrediction(twitchLink, predictionId, winningOutcomeId) {
  const { broadcasterId } = twitchLink.getCredentials();
  await helixFetch(twitchLink, '/predictions', 'PATCH', {
    broadcaster_id: broadcasterId,
    id: predictionId,
    status: 'RESOLVED',
    winning_outcome_id: winningOutcomeId,
  });
}

/**
 * Cancels an open Prediction (refunds points) - used when the match result couldn't be
 * determined, so viewers aren't left with a prediction that never resolves.
 * @param {import('./twitchLink.js').TwitchLink} twitchLink
 * @param {string} predictionId
 */
export async function cancelPrediction(twitchLink, predictionId) {
  const { broadcasterId } = twitchLink.getCredentials();
  await helixFetch(twitchLink, '/predictions', 'PATCH', {
    broadcaster_id: broadcasterId,
    id: predictionId,
    status: 'CANCELED',
  });
}
