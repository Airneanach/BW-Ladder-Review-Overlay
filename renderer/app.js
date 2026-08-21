'use strict';

/* Renderer. Talks to the main process only through window.review (see main/preload.cjs). */

(function () {
  const el = (id) => document.getElementById(id);

  const statusPill = el('status-pill');
  const statusDot = el('status-dot');
  const statusText = el('status-text');
  const overlayUrl = el('overlay-url');
  const nameList = el('name-list');
  const newName = el('new-name');
  const nameError = el('name-error');
  const installPath = el('install-path');
  const replayPath = el('replay-path');
  const replayFolder = el('replay-folder');
  const installValidity = el('install-validity');
  const replayValidity = el('replay-validity');
  const folderValidity = el('folder-validity');
  const portInput = el('port');
  const reviewList = el('review-list');
  const reviewEmpty = el('review-empty');
  const logList = el('log');

  const liveScannerEnabled = el('live-scanner-enabled');
  const autoPredictionsEnabled = el('auto-predictions-enabled');
  const scannerStatusEl = el('scanner-status');
  const twitchStatusEl = el('twitch-status');
  const twitchLinkBtn = el('twitch-link-btn');
  const twitchCancelBtn = el('twitch-cancel-btn');
  const twitchCodeHint = el('twitch-code-hint');
  const predictionsReadiness = el('predictions-readiness');
  const predictionWinLabel = el('prediction-win-label');
  const predictionLoseLabel = el('prediction-lose-label');
  const predictionTitle = el('prediction-title');
  const predictionWindow = el('prediction-window');
  const sendTestPredictionBtn = el('send-test-prediction');

  const gradeModalBackdrop = el('grade-modal-backdrop');
  const gradeModalLetter = el('grade-modal-letter');
  const gradeModalTitle = el('grade-modal-title');
  const gradeModalSub = el('grade-modal-sub');
  const gradeModalKeymoment = el('grade-modal-keymoment');
  const gradeModalCategories = el('grade-modal-categories');
  const gradeModalEmpty = el('grade-modal-empty');

  let settings = {
    playerNames: [], installPath: '', lastReplayPath: '', port: 3712,
    liveScannerEnabled: false, twitchAutoPredictionsEnabled: false,
    predictionWinLabel: 'Win', predictionLoseLabel: 'Lose',
    predictionTitleTemplate: 'Will I beat {opponent}?', predictionWindowSeconds: 300,
  };
  // Twitch state is pushed from main - never inferred here from "the toggle is on" or
  // "a link was attempted once": every field on this object came from a real check
  // main.cjs just performed (see twitchLink.js's health record).
  let twitchState = { link: { ok: false, message: 'Checking…' }, linked: false, login: null, scanner: null };
  let linking = false;
  let pendingCode = null;

  // --- helpers -------------------------------------------------------------

  function clockOf(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function raceLetter(race) {
    return race ? race.charAt(0).toUpperCase() : '?';
  }

  /** Matches the overlay page's own grade-band palette (web/bw-ladder-review-overlay.html),
   *  so a grade reads the same colour whether you're looking at the app or the stream. */
  function gradeColor(letter) {
    const band = String(letter || '').charAt(0).toUpperCase();
    return `var(--grade-${'ABCDF'.includes(band) ? band.toLowerCase() : 'c'})`;
  }

  function formatClock(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /** Persists a change and takes the authoritative settings back from the main process. */
  async function save(patch) {
    const res = await window.review.saveSettings(patch);
    settings = res.settings;
    if (res.status) renderStatus(res.status);
    return res;
  }

  // --- names ---------------------------------------------------------------

  function renderNames() {
    nameList.innerHTML = '';
    for (const name of settings.playerNames) {
      const li = document.createElement('li');
      li.className = 'name-chip';

      const label = document.createElement('span');
      label.textContent = name;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button button-tiny';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${name}`);
      remove.addEventListener('click', async () => {
        await save({ playerNames: settings.playerNames.filter((n) => n !== name) });
        renderNames();
      });

      li.append(label, remove);
      nameList.append(li);
    }
  }

  async function addName() {
    const value = newName.value.trim();
    nameError.hidden = true;
    if (!value) return;
    // Case-insensitive, because that is how the matching against replay names works - allowing
    // two spellings of one name would just look like a bug later.
    if (settings.playerNames.some((n) => n.toLowerCase() === value.toLowerCase())) {
      nameError.textContent = `"${value}" is already in the list.`;
      nameError.hidden = false;
      return;
    }
    await save({ playerNames: [...settings.playerNames, value] });
    newName.value = '';
    renderNames();
  }

  el('add-name').addEventListener('click', addName);
  newName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void addName();
    }
  });

  // --- paths ---------------------------------------------------------------

  async function showValidity(kind, value, target) {
    const res = await window.review.validatePath(kind, value);
    target.textContent = res.message;
    target.classList.toggle('is-good', res.level === 'good');
    target.classList.toggle('is-wait', res.level === 'wait');
    target.classList.toggle('is-bad', res.level === 'bad');
  }

  /**
   * Both paths are re-checked on a timer, because the interesting case changes underneath us:
   * LastReplay.rep does not exist until the first game ends, and a one-shot check at startup
   * would leave "not there yet" on screen for the rest of the session.
   */
  function watchValidity() {
    setInterval(() => {
      void showValidity('install', settings.installPath, installValidity);
      void showValidity('replay', settings.lastReplayPath, replayValidity);
      void showValidity('folder', settings.replayFolder, folderValidity);
    }, 5000);
  }

  // Saved on blur rather than on every keystroke: typing a path a character at a time would
  // otherwise restart the watcher on every letter.
  installPath.addEventListener('blur', async () => {
    if (installPath.value === settings.installPath) return;
    await save({ installPath: installPath.value.trim() });
    await showValidity('install', settings.installPath, installValidity);
  });

  replayPath.addEventListener('blur', async () => {
    if (replayPath.value === settings.lastReplayPath) return;
    await save({ lastReplayPath: replayPath.value.trim() });
    await showValidity('replay', settings.lastReplayPath, replayValidity);
  });

  el('browse-install').addEventListener('click', async () => {
    const picked = await window.review.pickFolder('Where is StarCraft installed?', settings.installPath);
    if (!picked) return;
    installPath.value = picked;
    await save({ installPath: picked });
    await showValidity('install', picked, installValidity);
  });

  el('browse-replay').addEventListener('click', async () => {
    const picked = await window.review.pickReplay('Pick LastReplay.rep', settings.lastReplayPath);
    if (!picked) return;
    replayPath.value = picked;
    await save({ lastReplayPath: picked });
    await showValidity('replay', picked, replayValidity);
  });

  el('browse-folder').addEventListener('click', async () => {
    const picked = await window.review.pickFolder('Where are your replays?', settings.replayFolder);
    if (!picked) return;
    replayFolder.value = picked;
    await save({ replayFolder: picked });
    await showValidity('folder', picked, folderValidity);
  });

  replayFolder.addEventListener('blur', async () => {
    if (replayFolder.value === settings.replayFolder) return;
    await save({ replayFolder: replayFolder.value.trim() });
    await showValidity('folder', settings.replayFolder, folderValidity);
  });

  el('apply-port').addEventListener('click', async () => {
    const port = Number(portInput.value);
    if (!Number.isFinite(port) || port < 1 || port > 65535) return;
    await save({ port });
    overlayUrl.value = `http://127.0.0.1:${settings.port}/`;
  });

  // --- overlay url ---------------------------------------------------------

  el('copy-url').addEventListener('click', async () => {
    await window.review.copyOverlayUrl();
    const button = el('copy-url');
    const previous = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = previous; }, 1400);
  });

  el('open-url').addEventListener('click', () => window.review.openOverlay());

  // --- logo -> platinumesport.com -------------------------------------------

  function openPlatinumSite() {
    window.review.openExternal('platinumesport');
  }
  for (const id of ['masthead-logo', 'sidenav-logo']) {
    const logo = el(id);
    logo.addEventListener('click', openPlatinumSite);
    logo.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPlatinumSite();
      }
    });
  }

  // --- reviewing -----------------------------------------------------------

  el('review-once').addEventListener('click', async () => {
    const button = el('review-once');
    button.disabled = true;
    button.textContent = 'Reviewing…';
    try {
      await window.review.reviewOnce(null);
    } finally {
      button.disabled = false;
      button.textContent = 'Review a past replay…';
    }
  });

  function renderReviews(rows) {
    // Rebuilt wholesale rather than appended: it is at most ten rows, and the alternative is
    // keeping two orderings in step for no benefit.
    for (const row of Array.from(reviewList.children)) {
      if (row !== reviewEmpty) row.remove();
    }
    reviewEmpty.hidden = rows.length > 0;

    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'review-row';
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.addEventListener('click', () => openGradeModal(row));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openGradeModal(row);
        }
      });

      const grades = row.grades_json ? JSON.parse(row.grades_json) : null;
      const grade = document.createElement('div');
      grade.className = 'review-grade';
      grade.textContent = grades ? grades.overallLetter : '–';
      grade.title = grades ? `${grades.overallScore}/100` : 'Not graded';

      const body = document.createElement('div');
      body.className = 'review-body';

      const headline = document.createElement('div');
      headline.className = 'review-headline';
      const result = document.createElement('span');
      result.className = (row.result || 'unknown').toLowerCase();
      result.textContent = (row.result || 'unknown').toUpperCase();
      headline.append(result);
      headline.append(
        document.createTextNode(
          ` ${raceLetter(row.my_race)}v${raceLetter(row.opponent_race)}` +
          `${row.opponent_name ? ` vs ${row.opponent_name}` : ''}`
        )
      );

      const detail = document.createElement('div');
      detail.className = 'review-detail';
      const parts = [];
      if (row.map_name) parts.push(row.map_name);
      if (row.duration_seconds != null) parts.push(formatClock(row.duration_seconds));
      if (row.key_moment_text) parts.push(row.key_moment_text);
      detail.textContent = parts.join(' · ');

      body.append(headline, detail);
      li.append(grade, body);
      reviewList.append(li);
    }
  }

  // --- training ------------------------------------------------------------

  function formatCount(value) {
    return Number.isFinite(value) ? (Math.round(value * 10) / 10).toString() : '–';
  }

  function formatDuration(totalSeconds) {
    if (!Number.isFinite(totalSeconds)) return '–';
    const s = Math.max(0, Math.round(totalSeconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderTraining(state) {
    const running = state.running;
    el('train-start').hidden = running;
    el('train-cancel').hidden = !running;
    el('train-reset').hidden = running || !state.calibration;
    el('train-progress').hidden = !running;

    const badge = el('trained-badge');
    const metricsList = el('trained-metrics');
    const mediansHint = el('medians-hint');
    metricsList.innerHTML = '';

    if (state.calibration) {
      const when = new Date(state.calibration.trainedAt);
      badge.hidden = false;
      badge.textContent = `Trained on ${state.calibration.games} games`;
      badge.title = Number.isNaN(when.getTime()) ? '' : `Trained ${when.toLocaleString()}`;
      el('train-note').textContent = state.calibration.games
        ? 'Retrain after a few weeks of play to keep it current.'
        : '';
    } else {
      badge.hidden = true;
      if (!running) el('train-note').textContent = 'Takes a minute or two for 100 games.';
    }

    // Always shown, trained or not - this is "what am I actually being graded against
    // right now", parsed straight from the same tables gradeMatch.js scores a replay
    // with (see src/gradeMatch.js's DEFAULT_ABSOLUTE/DEFAULT_MEDIANS and
    // src/calibration.js's `absolute`), so it can never drift from what a game's grade
    // actually reflects. Plain counts and a plain duration, not the duration-normalized
    // ratios/percentage grading uses internally - "0.83" isn't an answer to "how many
    // workers do I usually have."
    const medians = state.currentMedians;
    if (medians) {
      const trained = medians.source === 'trained';
      mediansHint.textContent = trained
        ? "Yours, from your trained replays - what you're actually graded against."
        : `The shipped defaults for a roughly ${medians.referenceMinutes}-minute game - what ` +
          `you're graded against until you train on your own replays.`;

      const rows = [
        {
          label: `Economy size${trained ? '' : ` (~${medians.referenceMinutes} min)`}`,
          value: `${formatCount(medians.workers.actual)} workers (${formatCount(medians.workers.expected)} expected)`,
        },
        {
          label: `Bases taken${trained ? '' : ` (~${medians.referenceMinutes} min)`}`,
          value: `${formatCount(medians.bases.actual)} bases (${formatCount(medians.bases.expected)} expected)`,
        },
        { label: 'Time supply blocked', value: formatDuration(medians.supplyBlockedSeconds) },
        { label: 'Unspent resources', value: Number.isFinite(medians.meanBank) ? `${Math.round(medians.meanBank)} banked` : '–' },
        { label: 'Effective APM', value: Number.isFinite(medians.eapm) ? `${Math.round(medians.eapm)} eAPM` : '–' },
      ];
      for (const row of rows) {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = `${row.label} · ${trained ? 'your median' : 'default'}`;
        const value = document.createElement('span');
        value.className = 'metric-value';
        value.textContent = row.value;
        li.append(label, value);
        metricsList.append(li);
      }
    }

    if (running && state.progress) {
      const p = state.progress;
      const total = p.total || 0;
      const pct = total ? Math.round((p.index / total) * 100) : 0;
      el('progress-fill').style.width = `${pct}%`;
      el('progress-text').textContent = p.done
        ? 'Building your grade boundaries…'
        : `Reviewing ${p.index + 1} of ${total} — ${p.used} usable so far${p.current ? ` — ${p.current}` : ''}`;
    }
  }

  el('train-start').addEventListener('click', async () => {
    if (settings.playerNames.length === 0) {
      nameError.textContent = 'Add your in-game name first - training needs to know which player is you.';
      nameError.hidden = false;
      newName.focus();
      return;
    }
    const res = await window.review.trainStart();
    if (res && res.ok === false && res.message) {
      el('train-note').textContent = res.message;
    }
  });

  el('train-cancel').addEventListener('click', () => window.review.trainCancel());

  el('train-reset').addEventListener('click', async () => {
    await window.review.trainReset();
  });

  // --- twitch predictions ---------------------------------------------------

  function setValidity(target, level, text) {
    target.hidden = false;
    target.textContent = text;
    target.classList.toggle('is-good', level === 'good');
    target.classList.toggle('is-wait', level === 'wait');
    target.classList.toggle('is-bad', level === 'bad');
  }

  /** Populates the four prediction text fields from settings. Called once at boot
   *  and after an explicit external settings change - never from renderTwitch(),
   *  which runs on every Twitch status push (link health checks, scanner ticks) and
   *  would otherwise overwrite whatever the user is mid-typing with stale values. */
  function applyPredictionFieldsFromSettings() {
    predictionWinLabel.value = settings.predictionWinLabel ?? '';
    predictionLoseLabel.value = settings.predictionLoseLabel ?? '';
    predictionTitle.value = settings.predictionTitleTemplate ?? '';
    predictionWindow.value = settings.predictionWindowSeconds ?? 300;
  }

  /**
   * Renders the scanner row, the Twitch link row, and the composite "will this work
   * for my next game" line - all three purely from twitchState/settings, which only
   * ever hold the result of a real check main.cjs just performed. Nothing here is
   * allowed to say "connected" or "attached" from a stored flag.
   *
   * Deliberately does not touch the four prediction text inputs - see
   * applyPredictionFieldsFromSettings().
   */
  function renderTwitch() {
    liveScannerEnabled.checked = !!settings.liveScannerEnabled;
    autoPredictionsEnabled.checked = !!settings.twitchAutoPredictionsEnabled;

    // Scanner row: only shown when the toggle is on, and always the scanner's own
    // real attach state (bwfind.exe's status ticks), never just "the toggle is on."
    const scannerAttached = !!(twitchState.scanner && Array.isArray(twitchState.scanner.players));
    if (!settings.liveScannerEnabled) {
      scannerStatusEl.hidden = true;
    } else if (scannerAttached) {
      setValidity(scannerStatusEl, 'good', 'Attached - tracking your game.');
    } else {
      const status = twitchState.scanner?.status || 'starting…';
      const failed = /couldn't|exited/i.test(status);
      setValidity(scannerStatusEl, failed ? 'bad' : 'wait', failed ? status : `Waiting for StarCraft (${status}).`);
    }

    // Twitch link row.
    const connected = twitchState.linked && twitchState.link.ok;
    if (linking) {
      twitchLinkBtn.hidden = true;
      twitchCancelBtn.hidden = false;
      if (pendingCode) {
        setValidity(twitchStatusEl, 'wait', 'Approving in your browser…');
        twitchCodeHint.hidden = false;
        twitchCodeHint.innerHTML = `Didn't open? Go to <code>${pendingCode.verificationUri}</code> and enter code <code>${pendingCode.userCode}</code>.`;
      } else {
        setValidity(twitchStatusEl, 'wait', 'Starting the Twitch link…');
        twitchCodeHint.hidden = true;
      }
    } else {
      twitchLinkBtn.hidden = false;
      twitchCancelBtn.hidden = true;
      twitchCodeHint.hidden = true;
      if (connected) {
        twitchLinkBtn.textContent = 'Unlink';
        const checkedAt = twitchState.link.checkedAt ? new Date(twitchState.link.checkedAt) : null;
        const when = checkedAt && !Number.isNaN(checkedAt.getTime())
          ? ` — checked ${checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : '';
        setValidity(twitchStatusEl, 'good', `Connected as ${twitchState.login}${when}.`);
      } else if (twitchState.linked) {
        // Linked but the last real check said it isn't healthy - reauthorizing is a
        // fresh link flow, not an unlink, so the button stays as a link action.
        twitchLinkBtn.textContent = 'Relink Twitch';
        setValidity(twitchStatusEl, 'bad', twitchState.link.message || 'Twitch connection needs reauthorizing.');
      } else {
        twitchLinkBtn.textContent = 'Link Twitch';
        setValidity(twitchStatusEl, 'wait', 'Not connected to Twitch.');
      }
    }

    // The one line that answers what actually matters: will a prediction open next game.
    if (!settings.twitchAutoPredictionsEnabled) {
      setValidity(predictionsReadiness, 'wait', 'Auto-open Twitch Predictions is off.');
    } else if (!connected) {
      setValidity(predictionsReadiness, 'bad', "Predictions won't open yet: Twitch isn't connected.");
    } else if (!settings.liveScannerEnabled) {
      setValidity(predictionsReadiness, 'bad', "Predictions won't open yet: live match tracking is off.");
    } else if (!scannerAttached) {
      setValidity(predictionsReadiness, 'wait', "Predictions won't open yet: the live scanner hasn't attached to StarCraft.");
    } else {
      setValidity(predictionsReadiness, 'good', 'Predictions will open for your next game.');
    }
  }

  liveScannerEnabled.addEventListener('change', async () => {
    await save({ liveScannerEnabled: liveScannerEnabled.checked });
    renderTwitch();
  });

  autoPredictionsEnabled.addEventListener('change', async () => {
    await save({ twitchAutoPredictionsEnabled: autoPredictionsEnabled.checked });
    renderTwitch();
  });

  predictionWinLabel.addEventListener('blur', async () => {
    const value = predictionWinLabel.value.trim() || 'Win';
    if (value === settings.predictionWinLabel) return;
    await save({ predictionWinLabel: value });
  });

  predictionLoseLabel.addEventListener('blur', async () => {
    const value = predictionLoseLabel.value.trim() || 'Lose';
    if (value === settings.predictionLoseLabel) return;
    await save({ predictionLoseLabel: value });
  });

  predictionTitle.addEventListener('blur', async () => {
    const value = predictionTitle.value.trim();
    if (value === settings.predictionTitleTemplate) return;
    await save({ predictionTitleTemplate: value });
  });

  predictionWindow.addEventListener('blur', async () => {
    const value = Math.max(30, Math.min(1800, Math.round(Number(predictionWindow.value) || 300)));
    if (value !== settings.predictionWindowSeconds) await save({ predictionWindowSeconds: value });
    predictionWindow.value = settings.predictionWindowSeconds;
  });

  twitchLinkBtn.addEventListener('click', async () => {
    if (twitchState.linked && twitchState.link.ok) {
      await window.twitch.unlink();
      const status = await window.twitch.getStatus();
      if (status) twitchState = status;
      renderTwitch();
      return;
    }
    linking = true;
    pendingCode = null;
    renderTwitch();
    await window.twitch.link();
  });

  twitchCancelBtn.addEventListener('click', async () => {
    await window.twitch.cancelLink();
    linking = false;
    pendingCode = null;
    renderTwitch();
  });

  sendTestPredictionBtn.addEventListener('click', async () => {
    sendTestPredictionBtn.disabled = true;
    const previous = sendTestPredictionBtn.textContent;
    sendTestPredictionBtn.textContent = 'Sending…';
    try {
      await window.twitch.sendTestPrediction();
    } finally {
      sendTestPredictionBtn.disabled = false;
      sendTestPredictionBtn.textContent = previous;
    }
  });

  window.twitch.onStatus((payload) => {
    twitchState = payload;
    renderTwitch();
  });

  window.twitch.onLinkCode((code) => {
    pendingCode = code;
    renderTwitch();
  });

  window.twitch.onLinkResult(() => {
    // Success or failure, the link attempt is over - twitchState.link already carries
    // the real result via the twitchStatus push that accompanies this.
    linking = false;
    pendingCode = null;
    renderTwitch();
  });

  // --- grade detail popup ---------------------------------------------------
  //
  // The same full breakdown the overlay shows automatically on stream (see
  // web/bw-ladder-review-overlay.html's report card) - so a player gets the identical
  // picture whether they click into it here or just have the overlay running.

  function openGradeModal(row) {
    const grades = row.grades_json ? JSON.parse(row.grades_json) : null;
    const hasCategories = !!(grades && Array.isArray(grades.categories) && grades.categories.length);

    gradeModalLetter.textContent = grades ? grades.overallLetter : '–';
    gradeModalLetter.style.color = grades ? gradeColor(grades.overallLetter) : '';

    const result = (row.result || 'unknown').toUpperCase();
    gradeModalTitle.textContent =
      `${result} · ${raceLetter(row.my_race)}v${raceLetter(row.opponent_race)}` +
      `${row.opponent_name ? ` vs ${row.opponent_name}` : ''}`;

    const subParts = [];
    if (row.map_name) subParts.push(row.map_name);
    if (row.duration_seconds != null) subParts.push(formatClock(row.duration_seconds));
    subParts.push(grades ? `${grades.overallScore}/100` : 'Not graded');
    gradeModalSub.textContent = subParts.join(' · ');

    gradeModalKeymoment.hidden = !row.key_moment_text;
    gradeModalKeymoment.textContent = row.key_moment_text || '';

    gradeModalCategories.innerHTML = '';
    gradeModalEmpty.hidden = hasCategories;
    if (hasCategories) {
      for (const cat of grades.categories) {
        const li = document.createElement('li');

        const letter = document.createElement('span');
        letter.className = 'cat-letter';
        letter.textContent = cat.letter;
        letter.style.color = gradeColor(cat.letter);

        const body = document.createElement('div');
        body.className = 'cat-body';
        const label = document.createElement('div');
        label.className = 'cat-label';
        label.textContent = cat.label;
        body.append(label);
        if (cat.detail) {
          const detail = document.createElement('div');
          detail.className = 'cat-detail';
          detail.textContent = cat.detail;
          body.append(detail);
        }

        li.append(letter, body);
        gradeModalCategories.append(li);
      }
    }

    gradeModalBackdrop.hidden = false;
  }

  function closeGradeModal() {
    gradeModalBackdrop.hidden = true;
  }

  el('grade-modal-close').addEventListener('click', closeGradeModal);
  gradeModalBackdrop.addEventListener('click', (e) => {
    if (e.target === gradeModalBackdrop) closeGradeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !gradeModalBackdrop.hidden) closeGradeModal();
  });

  // --- sidenav ---------------------------------------------------------------
  //
  // Anchor jumps within the page (CSS handles the smooth scroll - see html { scroll-
  // behavior }); this just keeps the sidebar's highlighted link in sync with whatever
  // section is actually in view, since a plain :target selector wouldn't update on
  // manual scrolling, only on click.

  const sidenavLinks = Array.from(document.querySelectorAll('.sidenav-link'));

  function setActiveSection(id) {
    for (const link of sidenavLinks) {
      link.classList.toggle('is-active', link.dataset.section === id);
    }
  }

  if (sidenavLinks.length) {
    const sectionObserver = new IntersectionObserver(
      (entries) => {
        // More than one section can be "intersecting" the tracked band at once on a
        // page this long - the one nearest the top of the viewport is the one that
        // reads as "current" to someone scrolling down through the page.
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible.length === 0) return;
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        setActiveSection(visible[0].target.id);
      },
      { rootMargin: '-10% 0px -70% 0px', threshold: 0 }
    );

    for (const link of sidenavLinks) {
      const section = document.getElementById(link.dataset.section);
      if (section) sectionObserver.observe(section);
    }
    setActiveSection(sidenavLinks[0].dataset.section);

    // The observer's band (rootMargin above) sits in the top third of the viewport, so a
    // short trailing section - here, the last one or two - never crosses into it: the
    // page runs out of room to scroll before that section's start reaches the band.
    // Scrolling to the literal bottom of the page is unambiguous regardless of section
    // height, so it overrides whatever the observer last decided.
    window.addEventListener('scroll', () => {
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom) setActiveSection(sidenavLinks[sidenavLinks.length - 1].dataset.section);
    }, { passive: true });
  }

  // --- status + log --------------------------------------------------------

  function renderStatus(status) {
    if (!status) return;
    statusText.textContent = status.status;
    statusPill.classList.remove('is-good', 'is-warn', 'is-bad', 'is-busy');
    if (status.reviewing) statusPill.classList.add('is-busy');
    else if (status.lastError) statusPill.classList.add('is-bad');
    else if (status.healthy) statusPill.classList.add('is-good');
    else statusPill.classList.add('is-warn');

    statusPill.title = status.problems.length ? status.problems.join('\n') : status.status;
    if (status.port) overlayUrl.value = `http://127.0.0.1:${status.port}/`;
  }

  const seenLogIds = new Set();

  function appendLog(entry) {
    // Startup delivers some lines twice - once live, once in the buffered replay - so ignore any
    // id already on screen. Entries without an id are always shown, since they cannot be checked.
    if (entry.id != null) {
      if (seenLogIds.has(entry.id)) return;
      seenLogIds.add(entry.id);
    }

    const li = document.createElement('li');
    li.className = `is-${entry.level}`;

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = clockOf(entry.at);

    const message = document.createElement('span');
    message.className = 'log-message';
    message.textContent = entry.message;

    li.append(time, message);
    logList.append(li);
    // Newest at the bottom, so keep it in view - but only when the log itself is actually
    // scrollable. Assigning scrollTop to a container that cannot scroll is not always the no-op
    // it looks like, and this ran on every line including the ones replayed during startup.
    if (logList.scrollHeight > logList.clientHeight) {
      logList.scrollTop = logList.scrollHeight;
    }
  }

  // --- boot ----------------------------------------------------------------

  window.review.onStatus(renderStatus);
  window.review.onActivity(appendLog);
  window.review.onTraining(renderTraining);
  window.review.onReviewed(() => {
    void window.review.loadSettings().then((state) => renderReviews(state.recent));
  });

  (async function boot() {
    const state = await window.review.loadSettings();
    settings = state.settings;

    installPath.value = settings.installPath || '';
    replayPath.value = settings.lastReplayPath || '';
    replayFolder.value = settings.replayFolder || '';
    portInput.value = settings.port;
    overlayUrl.value = `http://127.0.0.1:${(state.status && state.status.port) || settings.port}/`;

    renderNames();
    renderReviews(state.recent || []);
    for (const entry of state.activity || []) appendLog(entry);
    renderStatus(state.status);

    renderTraining(state.training || { running: false, calibration: null });

    if (state.twitch) twitchState = state.twitch;
    applyPredictionFieldsFromSettings();
    renderTwitch();

    await showValidity('install', settings.installPath, installValidity);
    await showValidity('replay', settings.lastReplayPath, replayValidity);
    await showValidity('folder', settings.replayFolder, folderValidity);
    watchValidity();

    // Belt and braces with overflow-anchor in the stylesheet: whatever the layout does while
    // being filled in, the window opens showing the top of the page - the masthead and the OBS
    // URL, which are the two things a first-time user needs.
    //
    // Twice: once after layout settles, and once more shortly after, because the startup log
    // lines (including a port-in-use error) arrive as live events just after boot finishes and
    // used to leave the window scrolled past the top. Deliberately only during startup - yanking
    // the view to the top when a game gets reviewed half an hour in would be worse.
    requestAnimationFrame(() => window.scrollTo(0, 0));
    setTimeout(() => window.scrollTo(0, 0), 400);
  })();
})();
