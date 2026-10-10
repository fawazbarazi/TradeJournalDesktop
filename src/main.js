const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');

// Configure at build/deployment time. Updates are downloaded as HTML, verified by
// SHA-256, and cached locally; the app never executes a remote URL directly.
const BUNDLED_UI_PATH = path.join(__dirname, '..', 'app', 'index.html');
let win;
let loadedUiVersion = '1.0.0';
const JOURNAL_KEYS = new Set(['tj_trades_v1', 'tj_setups_v1', 'tj_poi_options_v1']);
let lastBackupAt = 0;

function dataFilePath() {
  return path.join(app.getPath('userData'), 'journal-data.json');
}
function backupDirPath() {
  return path.join(app.getPath('userData'), 'backups');
}
function getUpdateConfig() {
  let fileConfig = {};
  try { fileConfig = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'update-config.json'), 'utf8')); } catch (_) {}
  return {
    manifestUrl: process.env.TRADE_JOURNAL_UPDATE_MANIFEST_URL || fileConfig.manifestUrl || '',
    trustedOrigin: process.env.TRADE_JOURNAL_UPDATE_ORIGIN || fileConfig.trustedOrigin || ''
  };
}
function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFilePath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) { return {}; }
}
function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
}
function backupStoreIfNeeded() {
  const file = dataFilePath();
  if (!fs.existsSync(file)) return;
  const now = Date.now();
  // Keep at most one automatic snapshot every 10 minutes, with a rolling set of 30.
  if (now - lastBackupAt < 10 * 60 * 1000) return;
  try {
    const dir = backupDirPath();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(dir, `journal-${stamp}.json`));
    const snapshots = fs.readdirSync(dir).filter(n => /^journal-.*\.json$/.test(n)).sort();
    while (snapshots.length > 30) fs.unlinkSync(path.join(dir, snapshots.shift()));
    lastBackupAt = now;
  } catch (_) { /* A backup issue must not block saving the journal. */ }
}

ipcMain.on('journal-storage:get', (event, key, browserFallback) => {
  if (!JOURNAL_KEYS.has(key)) { event.returnValue = null; return; }
  const store = readStore();
  if (Object.prototype.hasOwnProperty.call(store, key)) {
    event.returnValue = String(store[key]);
    return;
  }
  // One-time migration from the prior V40 browser localStorage when available.
  if (typeof browserFallback === 'string' && browserFallback.length) {
    store[key] = browserFallback;
    try { atomicWrite(dataFilePath(), JSON.stringify(store)); } catch (_) {}
    event.returnValue = browserFallback;
    return;
  }
  event.returnValue = null;
});

ipcMain.on('journal-storage:set', (event, key, value) => {
  if (!JOURNAL_KEYS.has(key)) { event.returnValue = false; return; }
  try {
    backupStoreIfNeeded();
    const store = readStore();
    store[key] = String(value);
    atomicWrite(dataFilePath(), JSON.stringify(store));
    event.returnValue = true;
  } catch (_) { event.returnValue = false; }
});

ipcMain.on('journal-storage:remove', (event, key) => {
  if (!JOURNAL_KEYS.has(key)) { event.returnValue = false; return; }
  try {
    backupStoreIfNeeded();
    const store = readStore();
    delete store[key];
    atomicWrite(dataFilePath(), JSON.stringify(store));
    event.returnValue = true;
  } catch (_) { event.returnValue = false; }
});



function validateBackupPayload(payload) {
  if (!payload || typeof payload !== 'object' || payload.format !== 'trade-journal-backup' || payload.version !== 1 || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    throw new Error('This file is not a supported Trade Journal backup.');
  }
  const clean = {};
  for (const key of JOURNAL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(payload.data, key)) continue;
    const raw = payload.data[key];
    if (typeof raw !== 'string') throw new Error(`Invalid data for ${key}.`);
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { throw new Error(`Backup data for ${key} is damaged.`); }
    if (key === 'tj_trades_v1' && !Array.isArray(parsed)) throw new Error('The backup trade list is invalid.');
    if (key === 'tj_setups_v1' && (!Array.isArray(parsed) || !parsed.every(x => typeof x === 'string'))) throw new Error('The backup setup list is invalid.');
    if (key === 'tj_poi_options_v1' && (!Array.isArray(parsed) || !parsed.every(x => typeof x === 'string'))) throw new Error('The backup POI list is invalid.');
    clean[key] = raw;
  }
  if (!Object.prototype.hasOwnProperty.call(clean, 'tj_trades_v1')) throw new Error('The backup does not contain the trade list.');
  return clean;
}

ipcMain.handle('journal-backup:export', async () => {
  try {
    const store = readStore();
    const payload = {
      format: 'trade-journal-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      data: Object.fromEntries([...JOURNAL_KEYS].filter(key => Object.prototype.hasOwnProperty.call(store, key)).map(key => [key, String(store[key])]))
    };
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Trade Journal Backup',
      defaultPath: `Trade-Journal-Backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Trade Journal Backup', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'w' });
    return { ok: true, message: 'Backup exported successfully.' };
  } catch (error) {
    return { ok: false, message: error?.message || 'Could not export backup.' };
  }
});

ipcMain.handle('journal-backup:restore', async () => {
  try {
    const result = await dialog.showOpenDialog(win, {
      title: 'Restore Trade Journal Backup',
      properties: ['openFile'],
      filters: [{ name: 'Trade Journal Backup', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
    const selectedPath = result.filePaths[0];
    const stat = fs.statSync(selectedPath);
    if (!stat.isFile() || stat.size > 500 * 1024 * 1024) throw new Error('Backup file is invalid or exceeds the 500 MB safety limit.');
    const payload = JSON.parse(fs.readFileSync(selectedPath, 'utf8'));
    const restored = validateBackupPayload(payload);
    const trades = JSON.parse(restored.tj_trades_v1 || '[]');
    const confirmation = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Restore Backup'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Replace current journal data?',
      message: 'Restore this backup and replace the current journal data?',
      detail: `${trades.length} trade(s) found in the backup. A local snapshot of the current data will be created first. This action cannot be undone from inside the app.`
    });
    if (confirmation.response !== 1) return { ok: false, canceled: true };
    backupStoreIfNeeded();
    const current = readStore();
    // Force a pre-restore snapshot even if a recent automatic snapshot exists.
    if (fs.existsSync(dataFilePath())) {
      const dir = backupDirPath();
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(dataFilePath(), path.join(dir, `journal-pre-restore-${stamp}.json`));
    }
    const merged = { ...current, ...restored };
    atomicWrite(dataFilePath(), JSON.stringify(merged));
    return { ok: true, message: `Restored ${trades.length} trade(s).` };
  } catch (error) {
    return { ok: false, message: error?.message || 'Could not restore backup.' };
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 850,
    minWidth: 760,
    minHeight: 650,
    title: 'Trade Journal',
    backgroundColor: '#0c1119',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });

  // External links open in the user's default browser, not inside the journal.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  loadBestUi();
  if (getUpdateConfig().manifestUrl.startsWith('https://')) {
    // Check in the background after the bundled/cached UI is already available.
    setTimeout(() => checkForUiUpdate({ interactive: false }), 1200);
  }
}

function cacheDirPath() { return path.join(app.getPath('userData'), 'ui-cache'); }
function cachedUiPath() { return path.join(cacheDirPath(), 'index.html'); }
function updateStatePath() { return path.join(cacheDirPath(), 'update-state.json'); }
function readUpdateState() {
  try { return JSON.parse(fs.readFileSync(updateStatePath(), 'utf8')); } catch (_) { return { version: '1.0.0' }; }
}
function writeUpdateState(state) {
  fs.mkdirSync(cacheDirPath(), { recursive: true });
  atomicWrite(updateStatePath(), JSON.stringify(state, null, 2));
}
function loadBestUi() {
  const cached = cachedUiPath();
  if (fs.existsSync(cached)) {
    loadedUiVersion = readUpdateState().version || '1.0.0';
    win.loadFile(cached);
  } else {
    loadedUiVersion = '1.0.0';
    win.loadFile(BUNDLED_UI_PATH);
  }
}
function requestBuffer(urlString, maxBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (_) { reject(new Error('Invalid update URL')); return; }
    if (url.protocol !== 'https:') { reject(new Error('Updates require HTTPS')); return; }
    const req = https.get(url, { timeout: 10000, headers: { 'User-Agent': 'TradeJournalDesktop' } }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new Error(`Update server returned HTTP ${res.statusCode}`)); return; }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { req.destroy(new Error('Update file exceeds size limit')); return; } chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Update request timed out')));
  });
}
function compareVersions(a, b) {
  const aa = String(a).split('.').map(n => Number.parseInt(n, 10) || 0);
  const bb = String(b).split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const diff = (aa[i] || 0) - (bb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}
async function checkForUiUpdate({ interactive = true } = {}) {
  const updateConfig = getUpdateConfig();
  const updateCheckUrl = updateConfig.manifestUrl;
  if (!updateCheckUrl.startsWith('https://')) {
    const result = { ok: false, available: false, message: 'Online updates are not configured yet.' };
    if (interactive && win && !win.isDestroyed()) await dialog.showMessageBox(win, { type: 'info', title: 'Check for Updates', message: result.message });
    return result;
  }
  try {
    const manifestUrl = new URL(updateCheckUrl);
    const expectedOrigin = updateConfig.trustedOrigin || manifestUrl.origin;
    if (manifestUrl.origin !== expectedOrigin) throw new Error('Manifest origin does not match the configured trusted origin.');
    const manifestBytes = await requestBuffer(updateCheckUrl, 100_000);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (!manifest || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version) || typeof manifest.uiUrl !== 'string' || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
      throw new Error('The update manifest is missing required fields.');
    }
    const uiUrl = new URL(manifest.uiUrl, manifestUrl);
    if (uiUrl.protocol !== 'https:' || uiUrl.origin !== expectedOrigin) throw new Error('The UI must be served over HTTPS from the configured trusted origin.');
    const state = readUpdateState();
    if (compareVersions(manifest.version, state.version || '1.0.0') <= 0) {
      if (interactive && win && !win.isDestroyed() && compareVersions(state.version || '1.0.0', loadedUiVersion) > 0) {
        const choice = await dialog.showMessageBox(win, { type: 'info', buttons: ['Reload Now', 'Later'], defaultId: 0, cancelId: 1, title: 'Update Ready', message: `Verified interface version ${state.version} is ready.`, detail: 'Reload the interface to apply it. Your local journal data will remain untouched.' });
        if (choice.response === 0) loadBestUi();
        return { ok: true, available: true, version: state.version, message: 'A verified update is ready to apply.' };
      }
      const result = { ok: true, available: false, version: state.version || '1.0.0', message: 'You are using the latest available UI.' };
      if (interactive && win && !win.isDestroyed()) await dialog.showMessageBox(win, { type: 'info', title: 'Trade Journal Updates', message: result.message, detail: `Current version: ${result.version}` });
      return result;
    }
    const html = await requestBuffer(uiUrl.toString(), 5_000_000);
    const actualHash = crypto.createHash('sha256').update(html).digest('hex');
    if (actualHash.toLowerCase() !== manifest.sha256.toLowerCase()) throw new Error('The downloaded UI failed its SHA-256 integrity check.');
    const htmlText = html.toString('utf8');
    if (!/<html[\s>]/i.test(htmlText) || !/<\/html>/i.test(htmlText)) throw new Error('The downloaded update is not a valid HTML document.');

    const dir = cacheDirPath();
    fs.mkdirSync(dir, { recursive: true });
    const target = cachedUiPath();
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, html, { mode: 0o600, flag: 'w' });
    // Keep the last known-good UI for rollback before replacing the active cache.
    if (fs.existsSync(target)) fs.copyFileSync(target, path.join(dir, 'index.previous.html'));
    fs.renameSync(temp, target);
    writeUpdateState({ version: manifest.version, notes: String(manifest.notes || ''), updatedAt: new Date().toISOString(), sha256: actualHash });
    const result = { ok: true, available: true, version: manifest.version, notes: String(manifest.notes || ''), message: 'A new interface update has been downloaded and verified.' };
    if (win && !win.isDestroyed()) win.webContents.send('ui-update:ready', result);
    if (interactive && win && !win.isDestroyed()) {
      const choice = await dialog.showMessageBox(win, {
        type: 'info', buttons: ['Reload Now', 'Later'], defaultId: 0, cancelId: 1,
        title: 'Trade Journal Update Ready', message: `Version ${manifest.version} is ready to use.`,
        detail: `${String(manifest.notes || 'The interface has been updated.')}\n\nYour local trades and screenshots are stored separately and are not replaced by this update.`
      });
      if (choice.response === 0) loadBestUi();
    }
    return result;
  } catch (error) {
    const result = { ok: false, available: false, message: error?.message || 'Could not check for updates.' };
    if (interactive && win && !win.isDestroyed()) await dialog.showMessageBox(win, { type: 'warning', title: 'Update Check Failed', message: result.message, detail: 'The current installed interface will remain available.' });
    return result;
  }
}

ipcMain.handle('ui-update:check', () => checkForUiUpdate({ interactive: true }));
ipcMain.handle('ui-update:reload', async () => {
  if (!win || win.isDestroyed()) return { ok: false };
  loadBestUi();
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
