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
  const installValidity = el('install-validity');
  const replayValidity = el('replay-validity');
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
    target.classList.toggle('is-good', res.ok);
    target.classList.toggle('is-bad', !res.ok);
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
    // Newest at the bottom, so keep it in view.
    logList.scrollTop = logList.scrollHeight;
  }

  // --- boot ----------------------------------------------------------------

  window.review.onStatus(renderStatus);
  window.review.onActivity(appendLog);
  window.review.onReviewed(() => {
    void window.review.loadSettings().then((state) => renderReviews(state.recent));
  });

  (async function boot() {
    const state = await window.review.loadSettings();
    settings = state.settings;

    installPath.value = settings.installPath || '';
    replayPath.value = settings.lastReplayPath || '';
    portInput.value = settings.port;
    overlayUrl.value = `http://127.0.0.1:${(state.status && state.status.port) || settings.port}/`;

    renderNames();
    renderReviews(state.recent || []);
    for (const entry of state.activity || []) appendLog(entry);
    renderStatus(state.status);

    await showValidity('install', settings.installPath, installValidity);
    await showValidity('replay', settings.lastReplayPath, replayValidity);

    // Belt and braces with overflow-anchor in the stylesheet: whatever the layout does while
    // being filled in, the window ends up showing the top of the page. After a frame, so it runs
    // once the rows and log lines added above have actually been laid out.
    requestAnimationFrame(() => window.scrollTo(0, 0));
  })();
})();
