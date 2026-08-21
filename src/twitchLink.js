// Local Twitch account link for this app's own broadcaster - Device Code Grant Flow,
// the OAuth flow Twitch built for exactly this situation: an app with no server and
// no way to hold a client secret safely once it's handed out to strangers.
//
// A public client's refresh token needs no client_secret to redeem, and only goes
// stale after 30 days of never being used - so once a streamer approves this once,
// the app keeps itself authenticated silently for as long as they open it at least
// once a month. Access tokens are still short-lived (4h) regardless; ensureFreshToken()
// renews one before it expires, so that's invisible day to day.
// See https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow
//
// `health` is deliberately the *only* thing any status UI is allowed to read, and it is
// never set from "a file exists" or "a toggle is on" - only from the result of a
// just-performed network call (validate, refresh, or a real Predictions API call made
// elsewhere - see predictions.js, which reports back into setHealth() after every one).

import fs from 'node:fs';
import path from 'node:path';

const CLIENT_ID = '26qv1nnb3ibwvbkvuso6fbpx2z71ya';
const SCOPE = 'channel:manage:predictions';
const DEVICE_ENDPOINT = 'https://id.twitch.tv/oauth2/device';
const TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token';
const VALIDATE_ENDPOINT = 'https://id.twitch.tv/oauth2/validate';

// Refresh this far ahead of the access token's real expiry, so a Predictions call can
// never race an about-to-expire token.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export class TwitchLink {
  /** @param {(health: object) => void} [onHealthChange] - fired every time setHealth() runs */
  constructor({ persistPath, onHealthChange = () => {} }) {
    this.persistPath = persistPath;
    this.onHealthChange = onHealthChange;
    this.link = this.load();
    this.health = { ok: false, checkedAt: null, message: 'Not checked yet.' };
    this._refreshing = null; // in-flight refresh promise, so concurrent callers dedupe onto one
    this._flow = null;       // { cancelled } for an in-progress link attempt
  }

  load() {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.persistPath, 'utf8').replace(/^﻿/, ''));
    } catch {
      return null;
    }
  }

  save() {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      if (this.link) fs.writeFileSync(this.persistPath, JSON.stringify(this.link, null, 2));
      else if (fs.existsSync(this.persistPath)) fs.rmSync(this.persistPath);
    } catch (err) {
      console.warn(`[twitchLink] Could not save the Twitch link: ${err.message}`);
    }
  }

  isLinked() {
    return !!this.link;
  }

  loginName() {
    return this.link?.login || null;
  }

  /** The one thing every status display reads. */
  getHealth() {
    return this.health;
  }

  setHealth(ok, message) {
    this.health = { ok, checkedAt: new Date().toISOString(), message };
    this.onHealthChange(this.health);
    return this.health;
  }

  unlink() {
    if (this._flow) this._flow.cancelled = true;
    this.link = null;
    this.save();
    this.setHealth(false, 'Not linked.');
  }

  cancelLinkFlow() {
    if (this._flow) this._flow.cancelled = true;
  }

  /**
   * Starts a Device Code Grant flow. `onCode` fires once with the code to show/open;
   * exactly one of `onDone`/`onError` fires once, terminating the flow.
   */
  startLinkFlow({ onCode, onDone, onError }) {
    if (this._flow) this._flow.cancelled = true; // superseded, not a failure for the old one
    const flow = { cancelled: false };
    this._flow = flow;

    (async () => {
      let device;
      try {
        const res = await fetch(DEVICE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: CLIENT_ID, scopes: SCOPE }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || `Twitch returned ${res.status} starting the link.`);
        device = data;
      } catch (err) {
        if (!flow.cancelled) onError(`Could not start linking Twitch: ${err.message}`);
        return;
      }
      if (flow.cancelled) return;

      onCode({ userCode: device.user_code, verificationUri: device.verification_uri });

      const deadline = Date.now() + (device.expires_in || 1800) * 1000;
      let intervalMs = Math.max(1, device.interval || 5) * 1000;

      while (!flow.cancelled) {
        if (Date.now() >= deadline) {
          onError('Linking timed out before it was approved - click Link Twitch to try again.');
          return;
        }
        await sleep(intervalMs);
        if (flow.cancelled) return;

        let res, data;
        try {
          res = await fetch(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: CLIENT_ID,
              device_code: device.device_code,
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }),
          });
          data = await res.json().catch(() => ({}));
        } catch {
          // A transient network blip mid-poll isn't a reason to give up on a
          // multi-minute window - just try again next interval.
          continue;
        }

        if (res.ok) {
          try {
            await this._finishLink(data);
          } catch (err) {
            if (!flow.cancelled) onError(`Linked, but couldn't confirm the account: ${err.message}`);
            return;
          }
          if (!flow.cancelled) onDone(this.link);
          return;
        }

        const message = String(data.message || '').toLowerCase();
        if (message.includes('authorization_pending')) continue;
        if (message.includes('slow_down')) { intervalMs += 5000; continue; }
        if (message.includes('expired')) { onError('Linking timed out before it was approved - click Link Twitch to try again.'); return; }
        if (message.includes('denied')) { onError('Twitch link was cancelled.'); return; }
        onError(`Twitch rejected the link attempt: ${data.message || 'unknown error'}`);
        return;
      }
    })();
  }

  async _finishLink(tokenData) {
    const validated = await validate(tokenData.access_token);
    this.link = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      clientId: CLIENT_ID,
      broadcasterId: validated.user_id,
      login: validated.login,
      obtainedAt: new Date().toISOString(),
      expiresAt: Date.now() + (tokenData.expires_in || 0) * 1000,
    };
    this.save();
    this.setHealth(true, `Connected as ${validated.login}.`);
  }

  /**
   * Refreshes the access token if it's near expiry. Every Predictions call goes
   * through this first. Concurrent callers dedupe onto one in-flight refresh, since
   * the refresh token is single-use - two simultaneous refreshes would have the
   * second one fail against an already-rotated token.
   */
  ensureFreshToken() {
    if (!this.link) return Promise.reject(new Error('Twitch is not linked - link it from the Twitch Predictions settings first.'));
    if (this.link.expiresAt - Date.now() > REFRESH_SKEW_MS) return Promise.resolve();
    if (!this._refreshing) {
      this._refreshing = this._doRefresh().finally(() => { this._refreshing = null; });
    }
    return this._refreshing;
  }

  async _doRefresh() {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // No client_secret: this app is registered as a public client, and DCF public
      // clients refresh without one.
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        refresh_token: this.link.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `refresh failed (${res.status})`);

    // Persisted immediately: the old refresh token is single-use and already dead the
    // moment this response arrived, so any delay here is a window where a crash could
    // strand the link on a now-dead token.
    this.link = {
      ...this.link,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || this.link.refreshToken,
      expiresAt: Date.now() + (data.expires_in || 0) * 1000,
    };
    this.save();
  }

  /**
   * The check every status display and the periodic health timer are built on.
   * Always a real round trip to Twitch, never inferred from anything cached.
   */
  async validateLink() {
    if (!this.link) return this.setHealth(false, 'Not linked.');
    try {
      await this.ensureFreshToken();
      const validated = await validate(this.link.accessToken);
      if (!(validated.scopes || []).includes(SCOPE)) {
        return this.setHealth(false, 'Twitch link is missing the predictions permission - relink to grant it.');
      }
      this.link.broadcasterId = validated.user_id;
      this.link.login = validated.login;
      return this.setHealth(true, `Connected as ${validated.login}.`);
    } catch (err) {
      return this.setHealth(false, `Twitch connection needs attention: ${err.message}`);
    }
  }

  /** Used by twitchPredictions.js. Callers must have awaited ensureFreshToken() first. */
  getCredentials() {
    if (!this.link) throw new Error('Twitch is not linked - link it from the Twitch Predictions settings first.');
    return { accessToken: this.link.accessToken, clientId: this.link.clientId, broadcasterId: this.link.broadcasterId };
  }
}

async function validate(accessToken) {
  const res = await fetch(VALIDATE_ENDPOINT, { headers: { Authorization: `OAuth ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `token validation failed (${res.status})`);
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
