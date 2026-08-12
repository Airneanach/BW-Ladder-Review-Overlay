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

  let settings = { playerNames: [], installPath: '', lastReplayPath: '', port: 3712 };

  // --- helpers -------------------------------------------------------------

  function clockOf(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function raceLetter(race) {
    return race ? race.charAt(0).toUpperCase() : '?';
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

  const METRIC_LABELS = {
    workerRatio: 'Economy size',
    baseRatio: 'Bases taken',
    meanBank: 'Unspent resources',
    supplyBlockedPct: 'Supply blocked',
    eapm: 'Effective APM',
  };

  /** Medians are what a user can sanity-check against their own sense of their play. */
  function formatMedian(key, value) {
    if (!Number.isFinite(value)) return '–';
    if (key === 'eapm') return `${Math.round(value)} APM`;
    if (key === 'meanBank') return `${Math.round(value)} banked`;
    if (key === 'supplyBlockedPct') return `${value.toFixed(1)}%`;
    // The two ratios are against the length-scaled target, so a percentage reads better than
    // a bare 0.83.
    return `${Math.round(value * 100)}% of target`;
  }

  function renderTraining(state) {
    const running = state.running;
    el('train-start').hidden = running;
    el('train-cancel').hidden = !running;
    el('train-reset').hidden = running || !state.calibration;
    el('train-progress').hidden = !running;

    const badge = el('trained-badge');
    const metricsList = el('trained-metrics');
    metricsList.innerHTML = '';

    if (state.calibration) {
      const when = new Date(state.calibration.trainedAt);
      badge.hidden = false;
      badge.textContent = `Trained on ${state.calibration.games} games`;
      badge.title = Number.isNaN(when.getTime()) ? '' : `Trained ${when.toLocaleString()}`;
      el('train-note').textContent = state.calibration.games
        ? 'Retrain after a few weeks of play to keep it current.'
        : '';
      for (const m of state.calibration.metrics) {
        const li = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = `${METRIC_LABELS[m.key] || m.key} · your median`;
        const value = document.createElement('span');
        value.className = 'metric-value';
        value.textContent = formatMedian(m.key, m.median);
        li.append(label, value);
        metricsList.append(li);
      }
    } else {
      badge.hidden = true;
      if (!running) el('train-note').textContent = 'Takes a minute or two for 100 games.';
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
