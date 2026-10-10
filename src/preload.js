const { contextBridge, ipcRenderer } = require('electron');

// Narrow, synchronous key/value bridge for the existing V40 UI.
// Only the journal's three known storage keys are persisted outside Chromium.
const JOURNAL_KEYS = new Set([
  'tj_trades_v1',
  'tj_setups_v1',
  'tj_poi_options_v1'
]);

contextBridge.exposeInMainWorld('tradeJournalDesktop', {
  isDesktop: true,
  getItem(key, browserFallback) {
    if (!JOURNAL_KEYS.has(String(key))) return browserFallback ?? null;
    return ipcRenderer.sendSync('journal-storage:get', String(key), browserFallback ?? null);
  },
  setItem(key, value) {
    if (!JOURNAL_KEYS.has(String(key))) return false;
    return ipcRenderer.sendSync('journal-storage:set', String(key), String(value));
  },
  removeItem(key) {
    if (!JOURNAL_KEYS.has(String(key))) return false;
    return ipcRenderer.sendSync('journal-storage:remove', String(key));
  },
  exportBackup() { return ipcRenderer.invoke('journal-backup:export'); },
  restoreBackup() { return ipcRenderer.invoke('journal-backup:restore'); },
  checkForUpdates() { return ipcRenderer.invoke('ui-update:check'); },
  reloadUpdatedUi() { return ipcRenderer.invoke('ui-update:reload'); },
  onUpdateReady(callback) { if (typeof callback === 'function') ipcRenderer.on('ui-update:ready', (_event, info) => callback(info)); }
});
