'use strict';

// Electron main process: owns the window, the settings, and the review server.
//
// CommonJS (.cjs) despite the rest of the project being ESM, matching the sibling Replay Sorter
// app. The ESM pipeline under src/ is pulled in with dynamic import().
//
// Worth knowing if you debug this from a terminal: if ELECTRON_RUN_AS_NODE is set in the
// environment, electron.exe runs as plain Node - no window, no `app`, and an immediate exit with
// no error - and `electron --version` prints a Node version instead of an Electron one. Some
// editors (VS Code's extension host among them) export it, so a shell inherited from one will
// appear to prove the app is broken when it is fine. Unset it before launching.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');

const appRoot = path.join(__dirname, '..');

/** Dynamic import of an ESM file from CommonJS. Needs a file:// URL to work on Windows. */
const importEsm = (relative) => import(pathToFileURL(path.join(appRoot, relative)).href);

let mainWindow = null;
let server = null;
let detect = null;
/** Buffered so the renderer, which loads after the server starts, does not miss early lines. */
const activityLog = [];

/**
 * A crash in the main process closes the window with nothing to look at, so anything that gets
 * this far is written next to the settings before the app goes down.
 */
function recordFatal(scope, error) {
  try {
    const logPath = path.join(app.getPath('userData'), 'crash.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `\n[${new Date().toISOString()}] ${scope}\n${(error && error.stack) || error}\n`);
  } catch {
    // nothing useful left to do
  }
}
process.on('uncaughtException', (error) => recordFatal('uncaughtException', error));
process.on('unhandledRejection', (error) => recordFatal('unhandledRejection', error));

// ---------------------------------------------------------------------------
// Settings.
//
// In userData, not beside the exe: the portable build extracts itself into a new temp folder on
// every run, so "beside the exe" is not a place anything survives.
// ---------------------------------------------------------------------------

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const historyPath = () => path.join(app.getPath('userData'), 'match-history.json');

function defaultSettings() {
  return {
    playerNames: [],
    installPath: (detect && detect.detectInstallPath()) || '',
    lastReplayPath: (detect && detect.detectLastReplayPath()) || '',
    port: (detect && detect.DEFAULT_PORT) || 3712,
  };
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    // Merged over the defaults so a settings file from an older version, or one missing a key,
    // still yields a usable config rather than undefined paths.
    return { ...defaultSettings(), ...saved };
  } catch {
    return defaultSettings();
  }
}

function saveSettings(patch) {
  const merged = { ...loadSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
  } catch (err) {
    // Failing to persist must not stop the app working for this session.
    log(`Could not save settings: ${err.message}`, 'warn');
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Where the bundled files live, which differs between a packaged build and `npm start`.
// ---------------------------------------------------------------------------

function bwstatsPath() {
  // extraResources puts it beside the asar rather than inside it, because it has to be a real
  // file on disk to be spawned.
  if (app.isPackaged) return path.join(process.resourcesPath, 'bwstats.exe');
  return path.join(appRoot, 'native', 'bwstats.exe');
}

function overlayHtml() {
  // Inside the asar when packaged, which Electron's patched fs reads transparently.
  return fs.readFileSync(path.join(appRoot, 'web', 'bw-ladder-review-overlay.html'));
}

// ---------------------------------------------------------------------------
// Activity log, mirrored to the window.
// ---------------------------------------------------------------------------

let nextLogId = 1;

function log(message, level = 'info') {
  // The id lets the renderer discard a line it already has. It needs one because there is a real
  // race at startup: it replays the buffered log when it boots, and a line logged in the window
  // between its listeners attaching and that replay finishing arrives by both routes.
  const entry = { id: nextLogId++, at: new Date().toISOString(), message, level };
  activityLog.push(entry);
  if (activityLog.length > 200) activityLog.shift();
  if (mainWindow) mainWindow.webContents.send('activity', entry);
}

function sendStatus() {
  if (!server || !mainWindow) return;
  mainWindow.webContents.send('status', server.status());
}

// ---------------------------------------------------------------------------
// Server lifecycle.
// ---------------------------------------------------------------------------

function describeReview({ row, elapsedSeconds }) {
  if (!row.my_name) {
    const found = row.all_players.map((p) => p.name).filter(Boolean).join(', ');
    return {
      level: 'warn',
      message:
        `Reviewed in ${elapsedSeconds.toFixed(1)}s, but none of your in-game names matched this ` +
        `game. Players in this replay: ${found}. Add the right one above to get a win/loss and a grade.`,
    };
  }
  const grade = row.grades_json ? JSON.parse(row.grades_json).overallLetter : 'not graded';
  const matchup =
    `${row.my_race ? row.my_race[0].toUpperCase() : '?'}v${row.opponent_race ? row.opponent_race[0].toUpperCase() : '?'}`;
  return {
    level: row.result === 'win' ? 'good' : 'info',
    message:
      `${row.result.toUpperCase()} as ${row.my_name} - ${matchup}` +
      `${row.opponent_name ? ` vs ${row.opponent_name}` : ''} on ${row.map_name || 'unknown map'} - ` +
      `grade ${grade} - reviewed in ${elapsedSeconds.toFixed(1)}s`,
  };
}

async function startServer(settings) {
  const { ReviewServer } = await importEsm('src/reviewServer.js');

  server = new ReviewServer({
    overlayHtml: overlayHtml(),
    bwstatsPath: bwstatsPath(),
    historyPath: historyPath(),
    onEvent: (type, payload) => {
      if (type === 'review:start') log(`New replay: ${path.basename(payload.replayPath)} - reviewing...`);
      if (type === 'review:skipped') log('Already reviewing a replay, skipped this trigger.', 'warn');
      if (type === 'review:error') log(`Review failed: ${payload.message}`, 'bad');
      if (type === 'review:done') {
        const described = describeReview(payload);
        log(described.message, described.level);
        if (mainWindow) mainWindow.webContents.send('reviewed', payload.row);
      }
      sendStatus();
    },
  });

  server.setConfig({
    installPath: settings.installPath || null,
    lastReplayPath: settings.lastReplayPath || null,
    playerNames: settings.playerNames,
  });

  try {
    await server.listen(settings.port);
    log(`Overlay is being served at http://127.0.0.1:${settings.port}/`, 'good');
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      log(
        `Port ${settings.port} is already in use - the overlay is probably already running in ` +
        `another window. Close it, or change the port under Advanced.`,
        'bad'
      );
    } else {
      log(`Could not start the overlay server: ${err.message}`, 'bad');
    }
  }
  sendStatus();
}

// ---------------------------------------------------------------------------
// Window.
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 860,
    minWidth: 720,
    minHeight: 600,
    backgroundColor: '#faf9f7',
    title: 'BW Ladder Review Overlay',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(appRoot, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  detect = await importEsm('src/detect.js');
  createWindow();
  await startServer(loadSettings());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Closing the window stops the overlay, which is what the docs promise and what a caster
  // expects - nothing should keep serving invisibly in the background.
  if (server) void server.close();
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC.
// ---------------------------------------------------------------------------

ipcMain.handle('settings:load', () => ({
  settings: loadSettings(),
  status: server ? server.status() : null,
  activity: activityLog,
  recent: server ? server.store.list(10) : [],
}));

ipcMain.handle('settings:save', async (_event, patch) => {
  const previous = loadSettings();
  const merged = saveSettings(patch);

  if (server) {
    server.setConfig({
      installPath: merged.installPath || null,
      lastReplayPath: merged.lastReplayPath || null,
      playerNames: merged.playerNames,
    });
  }

  // The port is the one setting that cannot be applied in place - rebinding means stopping and
  // restarting the listener, and the OBS source has to be repointed either way.
  if (merged.port !== previous.port || !server || !server.port) {
    log(`Restarting the overlay server on port ${merged.port}...`);
    if (server) await server.close();
    await startServer(merged);
  } else {
    sendStatus();
  }
  return { settings: merged, status: server ? server.status() : null };
});

ipcMain.handle('dialog:pickFolder', async (_event, { title, defaultPath }) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title,
    defaultPath: defaultPath || undefined,
    buttonLabel: 'Use this folder',
    properties: ['openDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('dialog:pickReplay', async (_event, { title, defaultPath }) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title,
    defaultPath: defaultPath || undefined,
    buttonLabel: 'Use this replay',
    filters: [{ name: 'StarCraft replay', extensions: ['rep'] }],
    properties: ['openFile'],
  });
  return res.canceled ? null : res.filePaths[0];
});

/** Reviews a past replay, so the overlay can be tested without playing a game first. */
ipcMain.handle('review:once', async (_event, replayPath) => {
  let target = replayPath;
  if (!target) {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Pick a replay to review',
      defaultPath: loadSettings().lastReplayPath || undefined,
      buttonLabel: 'Review it',
      filters: [{ name: 'StarCraft replay', extensions: ['rep'] }],
      properties: ['openFile'],
    });
    if (res.canceled) return null;
    target = res.filePaths[0];
  }
  const row = server ? await server.review(target) : null;
  return row || null;
});

ipcMain.handle('overlay:copyUrl', () => {
  const url = `http://127.0.0.1:${(server && server.port) || loadSettings().port}/`;
  clipboard.writeText(url);
  return url;
});

ipcMain.handle('overlay:open', () =>
  shell.openExternal(`http://127.0.0.1:${(server && server.port) || loadSettings().port}/`)
);

ipcMain.handle('path:validate', (_event, { kind, value }) => {
  if (!value) return { ok: false, message: 'Not set.' };
  if (!fs.existsSync(value)) return { ok: false, message: 'That path does not exist.' };
  if (kind === 'install') {
    if (!fs.existsSync(path.join(value, 'Data'))) {
      return { ok: false, message: 'No Data folder inside - this may not be the StarCraft folder.' };
    }
    return { ok: true, message: 'Looks like a StarCraft install.' };
  }
  if (kind === 'replay') {
    if (!value.toLowerCase().endsWith('.rep')) return { ok: false, message: 'Not a .rep file.' };
    return { ok: true, message: 'Found it.' };
  }
  return { ok: true, message: '' };
});
