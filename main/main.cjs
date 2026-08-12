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
const calibrationPath = () => path.join(app.getPath('userData'), 'calibration.json');

function defaultSettings() {
  const lastReplayPath = (detect && detect.detectLastReplayPath()) || '';
  return {
    playerNames: [],
    installPath: (detect && detect.detectInstallPath()) || '',
    lastReplayPath,
    // The folder training scans. Defaults to the folder LastReplay.rep sits in, which is the
    // Replays folder, whose AutoSave subfolder is where a ladder history actually accumulates.
    replayFolder: lastReplayPath ? path.dirname(lastReplayPath) : '',
    port: (detect && detect.DEFAULT_PORT) || 3712,
  };
}

/** The trained anchor tables, or null when the user has not trained yet. */
function loadCalibration() {
  const file = calibrationPath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    log(`Could not read the trained grading data (${err.message}) - using the defaults.`, 'bad');
    return null;
  }
}

function saveCalibration(calibration) {
  try {
    fs.mkdirSync(path.dirname(calibrationPath()), { recursive: true });
    if (calibration) fs.writeFileSync(calibrationPath(), JSON.stringify(calibration, null, 2));
    else if (fs.existsSync(calibrationPath())) fs.rmSync(calibrationPath());
  } catch (err) {
    log(`Could not save the trained grading data: ${err.message}`, 'bad');
  }
}

function loadSettings() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return defaultSettings();
  try {
    // The BOM strip matters: anything that writes this file with a Windows text editor or
    // PowerShell's `-Encoding utf8` produces UTF-8 with a BOM, which JSON.parse rejects. Without
    // this, hand-editing the file silently reverted every setting to its default.
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const saved = JSON.parse(text);
    // Merged over the defaults so a settings file from an older version, or one missing a key,
    // still yields a usable config rather than undefined paths.
    return { ...defaultSettings(), ...saved };
  } catch (err) {
    // Said out loud rather than swallowed: silently falling back to defaults looks to the user
    // like the app forgot their settings for no reason.
    log(`Could not read settings (${err.message}) - using defaults. Fix or delete ${file}`, 'bad');
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

  const calibration = loadCalibration();
  server.setConfig({
    installPath: settings.installPath || null,
    lastReplayPath: settings.lastReplayPath || null,
    playerNames: settings.playerNames,
    calibration,
  });
  if (calibration) {
    log(`Grading is calibrated to your own play (${calibration.games} games).`);
  }

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
  training: trainingState(),
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

/**
 * Levels are 'good' / 'wait' / 'bad' rather than a boolean, because a missing LastReplay.rep is
 * the normal state of a correctly configured machine that has not played a game yet. Reporting
 * that in red as "path does not exist" made a working setup look broken, which is the single
 * most expensive kind of wrong message this app can show.
 */
// ---------------------------------------------------------------------------
// Training: calibrating the grades to this user's own play.
//
// The shipped anchor tables were tuned against one player's replay history, so out of the box
// the grades describe how someone compares with *that* player. Training re-simulates a batch of
// the user's own games and rebuilds those tables from their own distribution, which is the only
// way to make a grade mean "compared with how you normally play". All local - see
// src/trainer.js and src/calibration.js.
// ---------------------------------------------------------------------------

let training = null; // { cancelled, progress } while a run is in flight

function trainingState() {
  const calibration = loadCalibration();
  return {
    running: Boolean(training),
    progress: training ? training.progress : null,
    calibration: calibration
      ? {
        games: calibration.games,
        trainedAt: calibration.trainedAt,
        metrics: Object.entries(calibration.metrics).map(([key, v]) => ({ key, median: v.median, samples: v.samples })),
      }
      : null,
  };
}

function sendTraining() {
  if (mainWindow) mainWindow.webContents.send('training', trainingState());
}

ipcMain.handle('train:start', async (_event, { limit } = {}) => {
  if (training) return { ok: false, message: 'Training is already running.' };

  const settings = loadSettings();
  const folder = settings.replayFolder
    || (settings.lastReplayPath ? path.dirname(settings.lastReplayPath) : '');

  training = { cancelled: false, progress: { total: 0, reviewed: 0, used: 0, current: null, done: false } };
  sendTraining();

  const { trainCalibration } = await importEsm('src/trainer.js');
  try {
    log(`Training on your replays in ${folder} - this takes a minute or two.`);
    const { calibration, report } = await trainCalibration({
      replayFolder: folder,
      installPath: settings.installPath,
      bwstatsPath: bwstatsPath(),
      playerNames: settings.playerNames,
      limit: limit || undefined,
      onProgress: progress => {
        training.progress = progress;
        sendTraining();
      },
      isCancelled: () => training.cancelled,
    });

    if (report.cancelled && !calibration) {
      log('Training cancelled - grading is unchanged.', 'warn');
      return { ok: false, cancelled: true, report };
    }
    if (!calibration) {
      log(
        `Not enough usable games to calibrate: found ${report.counts.total} replays, ` +
        `${report.games} of them yours and long enough (need ${report.needed}). ` +
        `Grading is unchanged.`,
        'warn'
      );
      return { ok: false, report };
    }

    saveCalibration(calibration);
    if (server) server.setConfig({ calibration });
    const parts = [`Trained on ${calibration.games} of your games - grading is now calibrated to your play.`];
    if (report.skipped.length) {
      parts.push(`Still on defaults: ${report.skipped.map(s => s.label).join(', ')}.`);
    }
    log(parts.join(' '), 'good');
    return { ok: true, report };
  } catch (err) {
    log(`Training failed: ${err.message}`, 'bad');
    return { ok: false, message: err.message };
  } finally {
    training = null;
    sendTraining();
    sendStatus();
  }
});

ipcMain.handle('train:cancel', () => {
  if (!training) return { ok: false };
  // Flagged rather than killed: the trainer checks between replays, so the simulator process
  // in flight is allowed to finish instead of being left half-read.
  training.cancelled = true;
  log('Cancelling training after the current replay...', 'warn');
  return { ok: true };
});

ipcMain.handle('train:reset', () => {
  saveCalibration(null);
  if (server) server.setConfig({ calibration: null });
  log('Trained grading data cleared - back to the built-in grading.', 'warn');
  sendTraining();
  sendStatus();
  return { ok: true };
});

ipcMain.handle('path:validate', async (_event, { kind, value }) => {
  if (!value) return { level: 'bad', message: 'Not set.' };

  if (kind === 'folder') {
    if (!fs.existsSync(value)) return { level: 'bad', message: 'That folder does not exist.' };
    // Counting is the only validation worth doing here: "the folder exists" tells the user
    // nothing, whereas "3 replays" immediately explains why training will say there is not
    // enough to work with.
    try {
      const { findReplays } = await importEsm('src/trainer.js');
      const count = findReplays(value, { limit: 500 }).length;
      if (count === 0) return { level: 'bad', message: 'No .rep files in here or its subfolders.' };
      return {
        level: 'good',
        message: `${count}${count === 500 ? '+' : ''} replay${count === 1 ? '' : 's'} found, including subfolders.`,
      };
    } catch (err) {
      return { level: 'bad', message: `Could not read that folder: ${err.message}` };
    }
  }

  if (kind === 'install') {
    if (!fs.existsSync(value)) return { level: 'bad', message: 'That folder does not exist.' };
    if (!fs.existsSync(path.join(value, 'Data'))) {
      return { level: 'bad', message: 'No Data folder inside - this may not be the StarCraft folder.' };
    }
    return { level: 'good', message: 'Looks like a StarCraft install.' };
  }

  if (kind === 'replay') {
    if (!value.toLowerCase().endsWith('.rep')) return { level: 'bad', message: 'Not a .rep file.' };
    if (!fs.existsSync(value)) {
      const parent = path.dirname(value);
      if (!fs.existsSync(parent)) {
        return { level: 'bad', message: `That folder does not exist: ${parent}` };
      }
      return { level: 'wait', message: 'Not there yet - StarCraft writes it when you finish a game.' };
    }
    return { level: 'good', message: 'Found it.' };
  }

  return { level: 'good', message: '' };
});
