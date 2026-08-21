'use strict';

/**
 * The renderer's only route to the outside world. It gets a fixed list of operations rather
 * than node access, so the settings screen cannot touch the filesystem in any way the main
 * process has not explicitly agreed to.
 *
 * CommonJS (.cjs) even though the rest of the app is ESM: Electron requires preload scripts
 * to be CommonJS.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('review', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  pickFolder: (title, defaultPath) => ipcRenderer.invoke('dialog:pickFolder', { title, defaultPath }),
  pickReplay: (title, defaultPath) => ipcRenderer.invoke('dialog:pickReplay', { title, defaultPath }),
  validatePath: (kind, value) => ipcRenderer.invoke('path:validate', { kind, value }),

  reviewOnce: (replayPath) => ipcRenderer.invoke('review:once', replayPath ?? null),

  trainStart: (limit) => ipcRenderer.invoke('train:start', { limit }),
  trainCancel: () => ipcRenderer.invoke('train:cancel'),
  trainReset: () => ipcRenderer.invoke('train:reset'),
  onTraining: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('training', listener);
    return () => ipcRenderer.removeListener('training', listener);
  },

  copyOverlayUrl: () => ipcRenderer.invoke('overlay:copyUrl'),
  openOverlay: () => ipcRenderer.invoke('overlay:open'),
  openExternal: (key) => ipcRenderer.invoke('external:open', key),

  onStatus: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('status', listener);
    return () => ipcRenderer.removeListener('status', listener);
  },
  onActivity: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('activity', listener);
    return () => ipcRenderer.removeListener('activity', listener);
  },
  onReviewed: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('reviewed', listener);
    return () => ipcRenderer.removeListener('reviewed', listener);
  },
});

contextBridge.exposeInMainWorld('twitch', {
  link: () => ipcRenderer.invoke('twitch:link'),
  cancelLink: () => ipcRenderer.invoke('twitch:cancelLink'),
  unlink: () => ipcRenderer.invoke('twitch:unlink'),
  sendTestPrediction: () => ipcRenderer.invoke('twitch:sendTestPrediction'),
  getStatus: () => ipcRenderer.invoke('twitch:status'),

  onStatus: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('twitchStatus', listener);
    return () => ipcRenderer.removeListener('twitchStatus', listener);
  },
  onLinkCode: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('twitchLinkCode', listener);
    return () => ipcRenderer.removeListener('twitchLinkCode', listener);
  },
  onLinkResult: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('twitchLinkResult', listener);
    return () => ipcRenderer.removeListener('twitchLinkResult', listener);
  },
});
