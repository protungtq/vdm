'use strict';

// More libuv threads: positional file writes from many connections run in parallel.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  Notification,
  powerSaveBlocker,
  session,
} = require('electron');

const { Settings } = require('./settings');
const { Manager } = require('./engine/manager');
const { Windows, resolveTheme, nativeThemeSource } = require('./windows');
const { startIntegrationServer } = require('./integration/server');
const { watchClipboard } = require('./integration/clipboard');
const { PowerActions } = require('./power');
const { Components } = require('./media/components');
const { probeMedia, isVideoPage, FORMATS_MISSING } = require('./media/media');
const { Updater } = require('./updater');
const proxyConfig = require('./engine/proxy');
const { testConnection } = require('./engine/http');
const I18N = require('../shared/i18n');
const WHATS_NEW = require('../shared/whats-new');
const { t, digits: D } = I18N;

const APP_ID = 'vn.game8.vdm';
const ASSETS = path.join(__dirname, '..', 'renderer', 'assets');

// A background app must never freeze behind Electron's modal "JavaScript
// error" dialog: log unexpected errors to <userData>/main.log and keep going.
function logError(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${(err && err.stack) || err}\n`;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'main.log'), line);
  } catch {
    /* ignore */
  }
  console.error(line);
}
process.on('uncaughtException', (e) => logError('uncaughtException', e));
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));

// Test/dev overrides (used by the UI check script; harmless otherwise).
if (process.env.DM_USER_DATA) app.setPath('userData', process.env.DM_USER_DATA);
if (process.env.DM_DOWNLOADS) app.setPath('downloads', process.env.DM_DOWNLOADS);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId(APP_ID);
const IS_MAC = process.platform === 'darwin';
// Windows: no menu bar. macOS always shows one, and ⌘C / ⌘V / ⌘Q only work through it.
function buildAppMenu() {
  Menu.setApplicationMenu(
    IS_MAC
      ? Menu.buildFromTemplate([
          {
            label: 'VDM',
            submenu: [
              { role: 'about', label: t('About VN Download Manager') },
              { type: 'separator' },
              { label: t('Add Link…'), accelerator: 'CmdOrCtrl+N', click: () => openAddDialog() },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { label: t('Quit VDM'), accelerator: 'Cmd+Q', click: () => quit() },
            ],
          },
          { role: 'editMenu' },
          { role: 'windowMenu' },
        ])
      : null
  );
}
buildAppMenu();

let settings;
let manager;
let windows;
let tray;
let clip;
let power;
let tools;
let updater;
let pendingInstall = null; // installer to run once the app has shut down
let blockerId = null;
let quitting = false;
let shutdownDone = false;
let trayHintShown = false;
let lastActivity = { active: 0, speed: 0, progress: null };
const dialogPayloads = new Map();

const extensionDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, '..', '..', 'extension'));
const theme = () => resolveTheme(settings.get().theme);

// ---------------------------------------------------------------- startup
app.whenReady().then(() => {
  migrateFromOldName();
  const userData = app.getPath('userData');
  settings = new Settings(path.join(userData, 'settings.json'), app.getPath('downloads'), osSecrets());
  proxyConfig.configure({
    getConfig: () => settings.get().proxy,
    resolveSystem: (url) => session.defaultSession.resolveProxy(url),
  });
  nativeTheme.themeSource = nativeThemeSource(settings.get().theme);
  windows = new Windows(theme);
  buildAppMenu();

  // yt-dlp + ffmpeg for video downloads live next to the user's data (downloaded on first use)
  tools = new Components(process.env.DM_TOOLS_DIR || path.join(userData, 'bin'));
  manager = new Manager({
    file: path.join(userData, 'downloads.json'),
    getSettings: () => settings.get(),
    tools,
    secrets: osSecrets(),
  });
  manager.load();
  wireManagerEvents();
  manager.startTimers();

  power = new PowerActions({
    onState: (s) => {
      windows.broadcast('power:pending', s);
      refreshTrayMenu();
    },
    quitApp: () => quit(),
  });

  registerIpc();
  createTray();
  applyLoginItem();

  planWhatsNew();
  const hidden = process.argv.includes('--hidden');
  showMain({ show: !hidden });

  startIntegrationServer({
    version: app.getVersion(),
    isEnabled: () => settings.get().browserIntegration,
    onDownload: (p) => openFromBrowser(p),
    extra: () => ({ videoButton: settings.get().videoButton !== false }),
  });

  clip = watchClipboard({
    clipboard,
    isEnabled: () => settings.get().clipboardWatch,
    onLink: (url) => openAddDialog({ url, source: 'clipboard' }),
  });

  settings.onChange(onSettingsChanged);
  nativeTheme.on('updated', () => {
    if (tray) tray.setImage(trayImage()); // Windows taskbar switched light/dark
    windows.applyTheme();
    windows.broadcast('theme:changed', theme());
  });

  applyElectronProxy();
  startUpdater();
  // keep yt-dlp current in the background (video sites change their pages often)
  setTimeout(() => tools.ready() && tools.updateIfStale(3 * 24 * 3600 * 1000).catch(() => {}), 20000);
  handleArgv(process.argv);
});

// macOS: clicking the Dock icon brings the window back
app.on('activate', () => {
  if (windows) showMain();
});

// a proxy that asks for a username and password (Chromium's own requests, e.g. the player window)
app.on('login', (e, _wc, _req, authInfo, callback) => {
  const p = settings && settings.get().proxy;
  if (!authInfo.isProxy || !p || p.mode !== 'manual' || !p.username) return;
  e.preventDefault();
  callback(p.username, p.password || '');
});

app.on('second-instance', (_e, argv) => {
  if (!handleArgv(argv)) windows.openMain();
});

app.on('window-all-closed', () => {
  /* keep running in the tray */
});

app.on('before-quit', (e) => {
  quitting = true;
  if (shutdownDone || !manager) return;
  e.preventDefault();
  manager
    .shutdown()
    .catch(() => {})
    .finally(() => {
      shutdownDone = true;
      if (pendingInstall) runInstaller(pendingInstall);
      app.quit();
    });
});

/**
 * The app used to be called "Download Manager" (and briefly "Kronos"); its data folder name follows
 * the product name, so bring the settings and download list across once.
 */
function migrateFromOldName() {
  if (process.env.DM_USER_DATA) return;
  try {
    const newDir = app.getPath('userData');
    for (const oldName of ['Download Manager', 'Kronos Download Manager']) {
      const oldDir = path.join(app.getPath('appData'), oldName);
      if (path.resolve(oldDir) === path.resolve(newDir) || !fs.existsSync(oldDir)) continue;
      fs.mkdirSync(newDir, { recursive: true });
      for (const f of ['settings.json', 'downloads.json']) {
        const src = path.join(oldDir, f);
        const dst = path.join(newDir, f);
        if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
      }
    }
  } catch (e) {
    logError('migrate', e);
  }
}

/** Readable text for what can go wrong when connecting through a proxy. */
function proxyError(e) {
  const m = String((e && e.message) || e);
  if (/407/.test(m)) return t('The proxy rejected the username or password.');
  if (/ECONNREFUSED/.test(m)) return t('The proxy refused the connection. Check the address and port.');
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return t('The proxy address was not found.');
  if (/ETIMEDOUT|timed out/i.test(m)) return t('The proxy did not answer in time.');
  if (/socks/i.test(m) && /auth/i.test(m)) return t('The proxy rejected the username or password.');
  return m.slice(0, 200);
}

/**
 * The player window ("Online Watch") and Electron itself use Chromium's network stack, which has its
 * own proxy setting: keep it in line with the one downloads use.
 */
function applyElectronProxy() {
  const p = settings.get().proxy;
  let cfg = { mode: 'direct' };
  if (p.mode === 'system') cfg = { mode: 'system' };
  else if (p.mode === 'manual' && p.host && p.port > 0) {
    cfg = { mode: 'fixed_servers', proxyRules: p.type === 'socks5' ? `socks5://${p.host}:${p.port}` : `http://${p.host}:${p.port}`, proxyBypassRules: '<local>' };
  }
  for (const ses of [session.defaultSession, session.fromPartition('persist:player')]) ses.setProxy(cfg).catch(() => {});
}

/**
 * Encryption by the operating system (Windows DPAPI, macOS Keychain, Linux keyring) for the browser
 * cookies saved with unfinished downloads. null when no real key store is available: then cookies
 * stay in memory only and are never written to disk.
 */
function osSecrets() {
  const { safeStorage } = require('electron');
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    if (process.platform === 'linux' && ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())) return null;
  } catch {
    return null;
  }
  return {
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  };
}

function quit() {
  quitting = true;
  app.quit();
}

function handleArgv(argv) {
  const url = argv.find((a) => /^https?:\/\//i.test(a));
  if (url) {
    openAddDialog({ url, source: 'cli' });
    return true;
  }
  return false;
}

function hookMainClose() {
  const main = windows.main;
  if (!main) return;
  main.on('close', (e) => {
    if (quitting || !settings.get().closeToTray) return;
    e.preventDefault();
    main.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({
        title: t('VN Download Manager is still running'),
        body: t('Downloads continue in the background. Right-click the tray icon to quit.'),
        icon: path.join(ASSETS, 'app-256.png'),
        silent: true,
      }).show();
    }
  });
}

/** After an update, "What's new" opens once, the first time the main window is shown. */
let whatsNewPending = null;
function planWhatsNew() {
  const cur = app.getVersion();
  const forced = process.env.DM_WHATS_NEW; // development: pretend this was the last version seen
  const last = forced !== undefined ? forced || null : settings.get().lastSeenVersion;
  if (forced === undefined && settings.isFirstRun) return void settings.set({ lastSeenVersion: cur }); // new install: nothing to explain
  if (last === cur) return;
  if ((last && WHATS_NEW.cmp(last, cur) > 0) || !WHATS_NEW.between(last, cur).length) return void settings.set({ lastSeenVersion: cur });
  whatsNewPending = { from: last || '', to: cur };
}
function showWhatsNewIfDue() {
  if (!whatsNewPending) return;
  const q = whatsNewPending;
  whatsNewPending = null;
  settings.set({ lastSeenVersion: q.to });
  setTimeout(() => windows.openWhatsNew(q), 700);
}

function showMain({ show = true } = {}) {
  const w = windows.openMain({ show });
  if (!w.__closeHooked) {
    w.__closeHooked = true;
    hookMainClose();
  }
  if (show) showWhatsNewIfDue();
}

// ---------------------------------------------------------------- manager -> UI
function wireManagerEvents() {
  manager.on('added', (s) => windows.broadcast('downloads:added', s));
  manager.on('changed', (s) => windows.broadcast('downloads:changed', s));
  manager.on('removed', (id) => {
    windows.broadcast('downloads:removed', id);
    windows.closeProgress(id);
  });
  manager.on('progress', (list) => windows.broadcast('downloads:progress', list));
  manager.on('queue', (q) => {
    windows.broadcast('queue:state', q);
    refreshTrayMenu();
  });
  manager.on('queue-done', ({ id } = {}) => {
    const q = manager.queues().find((x) => x.id === id) || {};
    const action = (q.schedule || {}).afterDone;
    if (action && action !== 'none') power.schedule(action);
  });
  manager.on('completed', (s) => {
    const s0 = settings.get();
    const progressOpen = windows.progress.has(s.id);
    if (progressOpen && !s0.showCompleteWindow) windows.closeProgress(s.id);
    if (s0.notifications && Notification.isSupported() && !(progressOpen && s0.showCompleteWindow)) {
      const n = new Notification({ title: t('Download complete'), body: s.filename, icon: path.join(ASSETS, 'app-256.png') });
      n.on('click', () => shell.showItemInFolder(s.savePath));
      n.show();
    }
  });
  manager.on('failed', (s) => {
    if (settings.get().notifications && Notification.isSupported() && !windows.progress.has(s.id)) {
      new Notification({ title: t('Download failed'), body: `${s.filename}\n${s.error || ''}`, icon: path.join(ASSETS, 'app-256.png') }).show();
    }
  });
  manager.on('activity', (a) => {
    lastActivity = a;
    updateTaskbar(a);
    updateSleepBlocker(a.active > 0);
    if (tray) tray.setToolTip(a.active ? t('VDM — {n} active · {speed}', { n: D(a.active), speed: fmtSpeed(a.speed) }) : t('VN Download Manager'));
  });
}

function updateTaskbar(a) {
  const main = windows.main;
  if (!main || main.isDestroyed()) return;
  if (!a.active) main.setProgressBar(-1);
  else if (a.progress === -1) main.setProgressBar(2, { mode: 'indeterminate' });
  else main.setProgressBar(Math.max(0.01, a.progress || 0));
}

function updateSleepBlocker(active) {
  const want = active && settings.get().preventSleep;
  if (want && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
  if (!want && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

function fmtSpeed(bps) {
  if (bps >= 1024 * 1024) return D(`${(bps / 1048576).toFixed(1)} ${t('MB')}/${t('s')}`);
  return D(`${Math.round(bps / 1024)} ${t('KB')}/${t('s')}`);
}

// ---------------------------------------------------------------- dialogs
function openAddDialog({ url = '', source = 'manual' } = {}) {
  for (const w of windows.dialogs) if (w.__url && w.__url === url && url) return windows.reveal(w);
  const win = windows.openDialog({ mode: 'add', url, source });
  win.__url = url;
  return win;
}

function openFromBrowser(p) {
  if (p.media) {
    // "Download this video" from the browser: let the video dialog find the best source
    const token = crypto.randomUUID();
    dialogPayloads.set(token, { ...p, source: 'browser' });
    setTimeout(() => dialogPayloads.delete(token), 10 * 60 * 1000);
    windows.openDialog({ mode: 'media', token });
    return;
  }
  if (p.urls && p.urls.length > 1) {
    const win = windows.openDialog({ mode: 'add', url: p.urls.join('\n'), source: 'browser' });
    win.__url = p.urls[0];
    return;
  }
  // Several downloads arriving at once (a page starting many, or an older extension replaying the
  // browser's history) open ONE window with a checklist instead of a window each.
  browserBurst.push({ ...p, url: p.url || p.urls[0] });
  clearTimeout(browserBurst.timer);
  browserBurst.timer = setTimeout(flushBrowserBurst, 800);
}

const browserBurst = [];
function flushBrowserBurst() {
  const open = new Set(windows.all().map((w) => w.__url).filter(Boolean));
  const seen = new Set();
  const items = browserBurst.splice(0).filter((x) => !open.has(x.url) && !seen.has(x.url) && seen.add(x.url));
  if (!items.length) return;
  if (items.length > 1) {
    const win = windows.openDialog({ mode: 'add', url: items.map((x) => x.url).join('\n'), source: 'browser' });
    win.__url = items[0].url;
    return;
  }
  const token = crypto.randomUUID();
  dialogPayloads.set(token, { ...items[0], source: 'browser' });
  setTimeout(() => dialogPayloads.delete(token), 10 * 60 * 1000);
  const win = windows.openDialog({ mode: 'info', token });
  win.__url = items[0].url;
}

// ---------------------------------------------------------------- tray
/** Single-colour tray glyph that contrasts with the Windows taskbar (dark by default). */
function trayImage() {
  if (IS_MAC) {
    // menu-bar "template" icon: macOS tints it for light/dark menu bars itself
    const img = nativeImage.createEmpty();
    img.addRepresentation({ scaleFactor: 1, buffer: fs.readFileSync(path.join(ASSETS, 'tray-dark-16.png')) });
    img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(ASSETS, 'tray-dark-32.png')) });
    img.setTemplateImage(true);
    return img;
  }
  const darkTaskbar = process.platform === 'win32' ? nativeTheme.shouldUseDarkColorsForSystemIntegratedUI !== false : true;
  const v = darkTaskbar ? 'light' : 'dark';
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, buffer: fs.readFileSync(path.join(ASSETS, `tray-${v}-16.png`)) });
  img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(ASSETS, `tray-${v}-32.png`)) });
  return img;
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('VN Download Manager');
  tray.on('click', () => showMain());
  refreshTrayMenu();
}

const POWER_LABELS = { exit: 'Exit app', sleep: 'Sleep', hibernate: 'Hibernate', shutdown: 'Shut down' };

function queueTrayItems() {
  const queues = manager.queues();
  const item = (q, name) => (manager.qstate(q.id).running ? { label: t('Stop {name}', { name }), click: () => manager.stopQueue(q.id) } : { label: t('Start {name}', { name }), click: () => manager.startQueue(q.id) });
  if (queues.length === 1) return [item(queues[0], t('queue'))];
  return [{ label: t('Queues'), submenu: queues.map((q) => item(q, `“${t(q.name)}”`)) }];
}

function refreshTrayMenu() {
  if (!tray) return;
  const items = [
    { label: t('Open VDM'), click: () => showMain() },
    { label: t('Add Link…'), click: () => openAddDialog() },
    { type: 'separator' },
    { label: t('Pause all'), click: () => manager.pauseAll() },
    { label: t('Resume all'), click: () => manager.resumeAll() },
    ...queueTrayItems(),
  ];
  if (power && power.pending) items.push({ type: 'separator' }, { label: t('Cancel {action}', { action: t(POWER_LABELS[power.pending.action] || power.pending.action) }), click: () => power.cancel() });
  items.push({ type: 'separator' }, { label: t('Quit'), click: () => quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function applyLoginItem() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  app.setLoginItemSettings({ openAtLogin: !!settings.get().launchAtStartup, args: ['--hidden'] });
}

function onSettingsChanged(s, prev) {
  if (JSON.stringify(s.proxy) !== JSON.stringify(prev.proxy)) {
    proxyConfig.configure({}); // forget cached system-proxy answers
    applyElectronProxy();
  }
  if (s.theme !== prev.theme) {
    nativeTheme.themeSource = nativeThemeSource(s.theme);
    windows.applyTheme();
    windows.broadcast('theme:changed', theme());
  }
  if (s.speedLimit !== prev.speedLimit) manager.setSpeedLimit(s.speedLimit);
  if (s.launchAtStartup !== prev.launchAtStartup) applyLoginItem();
  if (s.maxConcurrent !== prev.maxConcurrent) manager.pump();
  if (s.autoUpdate !== prev.autoUpdate) startUpdater();
  if (s.preventSleep !== prev.preventSleep) updateSleepBlocker(lastActivity.active > 0);
  windows.broadcast('settings:changed', settings.forRenderer());
  // after the windows have the new settings, so they know every queue that is reported
  if (JSON.stringify(s.queues) !== JSON.stringify(prev.queues)) {
    // a queue was added / renamed / deleted or its "at a time" changed
    manager.pump();
    manager.emitQueue();
    refreshTrayMenu();
  }
}

// ---------------------------------------------------------------- external players
function findPlayer() {
  if (IS_MAC) {
    const apps = ['/Applications/IINA.app/Contents/MacOS/IINA', '/Applications/VLC.app/Contents/MacOS/VLC', '/Applications/mpv.app/Contents/MacOS/mpv'];
    return apps.find((p) => fs.existsSync(p)) || null;
  }
  if (process.platform !== 'win32') return null;
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const candidates = [];
  for (const base of pf) {
    candidates.push(path.join(base, 'VideoLAN', 'VLC', 'vlc.exe'));
    candidates.push(path.join(base, 'DAUM', 'PotPlayer', 'PotPlayerMini64.exe'));
    candidates.push(path.join(base, 'DAUM', 'PotPlayer', 'PotPlayerMini.exe'));
    candidates.push(path.join(base, 'MPC-HC', 'mpc-hc64.exe'));
    candidates.push(path.join(base, 'mpv', 'mpv.exe'));
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

// ---------------------------------------------------------------- IPC
function senderWindow(e) {
  return BrowserWindow.fromWebContents(e.sender);
}

/** Asks before taking a download off the list. */
async function confirmRemove(win, snap) {
  const done = snap.status === 'completed';
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [t('Remove'), t('Keep')],
    defaultId: 1,
    cancelId: 1,
    title: t('VN Download Manager'),
    message: t('Remove “{name}” from the list?', { name: snap.filename }),
    detail: done ? 'The downloaded file stays on your disk.' : 'The partially downloaded data will be deleted.',
    noLink: true,
  });
  return response === 0;
}

/** Toolbar "Delete" with several items selected: one confirmation, optionally deleting the files too. */
async function deleteMany(win, ids) {
  const items = [...new Set(ids)].map((id) => manager.get(id)).filter(Boolean).map((dl) => dl.snapshot());
  if (!items.length) return false;
  const done = items.filter((s) => s.status === 'completed');
  const onDisk = done.filter((s) => fs.existsSync(s.savePath));
  const unfinished = items.length - done.length;
  const lines = [];
  if (done.length) lines.push(t(done.length > 1 ? '{n} finished downloads will be removed from the list.' : '{n} finished download will be removed from the list.', { n: D(done.length) }));
  if (unfinished) lines.push(t(unfinished > 1 ? '{n} unfinished downloads will stop, and their partially downloaded data will be deleted.' : '{n} unfinished download will stop, and its partially downloaded data will be deleted.', { n: D(unfinished) }));
  const opts = {
    type: 'question',
    buttons: [t('Delete {n}', { n: D(items.length) }), t('Cancel')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: t('VN Download Manager'),
    message: t('Delete {n} downloads?', { n: D(items.length) }),
    detail: lines.join('\n'),
  };
  if (onDisk.length) {
    opts.checkboxLabel = onDisk.length === 1 ? t('Also delete the downloaded file from disk') : t('Also delete the {n} downloaded files from disk', { n: D(onDisk.length) });
    opts.checkboxChecked = false;
  }
  const { response, checkboxChecked } = await dialog.showMessageBox(win, opts);
  if (response !== 0) return false;
  for (const s of items) await manager.remove(s.id, { deleteFile: s.status === 'completed' && !!checkboxChecked }).catch((err) => logError('delete', err));
  return true;
}

async function runAction(win, { id, action, value }) {
  const dl = manager.get(id);
  if (!dl) return null;
  const s = dl.snapshot();
  switch (action) {
    case 'start':
    case 'resume':
      manager.start(id);
      break;
    case 'pause':
      await manager.pause(id);
      break;
    case 'toggle':
      if (dl.running) await manager.pause(id);
      else manager.start(id);
      break;
    case 'cancel':
      // A running / paused / queued download is canceled but stays in the list;
      // canceling something that is already canceled takes it off the list.
      if (s.status === 'canceled') {
        if (await confirmRemove(win, s)) await manager.remove(id);
      } else {
        windows.closeProgress(id);
        await manager.cancel(id);
      }
      break;
    case 'remove':
      if (s.status === 'completed' || (await confirmRemove(win, s))) await manager.remove(id);
      break;
    case 'delete': {
      // Toolbar "Delete": take the item off the list (optionally the file too).
      const done = s.status === 'completed';
      const opts = {
        type: 'question',
        buttons: [t('Delete'), t('Cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: t('VN Download Manager'),
        message: t('Delete “{name}”?', { name: s.filename }),
        detail: done ? 'It will be removed from the list.' : 'The download stops and is removed from the list; the partially downloaded data is deleted.',
      };
      if (done && fs.existsSync(s.savePath)) {
        opts.checkboxLabel = 'Also delete the file from disk';
        opts.checkboxChecked = false;
      }
      const { response, checkboxChecked } = await dialog.showMessageBox(win, opts);
      if (response === 0) await manager.remove(id, { deleteFile: done && !!checkboxChecked });
      break;
    }
    case 'deleteFile': {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: [t('Delete'), t('Keep')],
        defaultId: 1,
        cancelId: 1,
        message: t('Delete “{name}” from disk?', { name: s.filename }),
        detail: s.savePath,
        noLink: true,
      });
      if (response === 0) await manager.remove(id, { deleteFile: true });
      break;
    }
    case 'open':
      if (s.status === 'completed') {
        const err = await shell.openPath(s.savePath);
        if (err) windows.broadcast('toast', { text: err });
      } else windows.openProgress(id);
      break;
    case 'openFolder':
      if (fs.existsSync(s.savePath)) shell.showItemInFolder(s.savePath);
      else if (fs.existsSync(dl.tempPath)) shell.showItemInFolder(dl.tempPath);
      else shell.openPath(s.dir);
      break;
    case 'copyUrl':
      clipboard.writeText(s.url);
      clip?.ignore(s.url);
      windows.broadcast('toast', { text: t('Address copied') });
      break;
    case 'redownload':
      await manager.redownload(id);
      break;
    case 'refresh':
      windows.openDialog({ mode: 'refresh', id, url: s.url });
      break;
    case 'refreshUrl':
      await manager.refreshUrl(id, String(value || ''));
      break;
    case 'queue':
      // value: a queue id, true (main queue) or false (leave the queue)
      manager.setQueued(id, !!value, typeof value === 'string' ? value : 'main');
      break;
    case 'moveUp':
      manager.moveInQueue(id, 'up');
      break;
    case 'moveDown':
      manager.moveInQueue(id, 'down');
      break;
    case 'progress':
      windows.openProgress(id);
      break;
    case 'connections':
    case 'speedLimit':
      manager.update(id, { [action]: Number(value) || 0 });
      break;
    case 'hash': {
      windows.broadcast('toast', { text: t('Calculating SHA-256…') });
      try {
        const h = await sha256(s.savePath);
        clipboard.writeText(h);
        clip?.ignore(h);
        windows.broadcast('toast', { text: t('SHA-256 copied: {h}…', { h: h.slice(0, 16) }) });
      } catch (e) {
        windows.broadcast('toast', { text: t('Couldn’t read file: {e}', { e: e.message }) });
      }
      break;
    }
    default:
      return null;
  }
  return manager.get(id)?.snapshot() || null;
}

function contextMenuFor(win, id) {
  const dl = manager.get(id);
  if (!dl) return;
  const s = dl.snapshot();
  const done = s.status === 'completed';
  const act = (action, value) => () => runAction(win, { id, action, value });
  const tpl = [];
  if (done) tpl.push({ label: t('Open'), click: act('open') });
  tpl.push({ label: t('Open folder'), click: act('openFolder') });
  tpl.push({ type: 'separator' });
  if (!done) {
    if (dl.running) tpl.push({ label: t('Pause'), click: act('pause') });
    else tpl.push({ label: t(s.status === 'error' ? 'Retry' : 'Resume'), click: act('start') });
    if (s.status === 'canceled') tpl.push({ label: t('Restart from beginning'), click: act('redownload') });
    tpl.push({ label: t('Show progress window'), click: act('progress') });
    const queues = manager.queues();
    if (queues.length === 1) tpl.push({ label: s.queued ? 'Remove from queue' : 'Add to queue', click: act('queue', s.queued ? false : 'main') });
    else {
      const current = s.queued ? s.queueId || 'main' : null;
      tpl.push({
        label: t(s.queued ? 'Move to queue' : 'Add to queue'),
        submenu: queues.map((q) => ({ label: t(q.name), type: 'radio', checked: q.id === current, click: act('queue', q.id) })),
      });
      if (s.queued) tpl.push({ label: t('Remove from queue'), click: act('queue', false) });
    }
    if (s.queued) tpl.push({ label: t('Move up in queue'), click: act('moveUp') }, { label: t('Move down in queue'), click: act('moveDown') });
    tpl.push({ type: 'separator' });
  }
  tpl.push({ label: t('Copy address'), click: act('copyUrl') });
  if (!done) tpl.push({ label: t('Refresh link…'), click: act('refresh') });
  if (done) tpl.push({ label: t('Download again'), click: act('redownload') }, { label: t('Copy SHA-256 checksum'), click: act('hash') });
  tpl.push({ type: 'separator' });
  if (done) tpl.push({ label: t('Remove from list'), click: act('remove') }, { label: t('Delete file…'), click: act('deleteFile') });
  else if (s.status === 'canceled') tpl.push({ label: t('Remove from list…'), click: act('remove') });
  else tpl.push({ label: t('Cancel download'), click: act('cancel') }, { label: t('Remove from list…'), click: act('remove') });
  Menu.buildFromTemplate(tpl).popup({ window: win });
}

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (e, ...a) => fn(e, ...a));

  h('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    theme: theme(),
    downloads: app.getPath('downloads'),
    extensionDir: extensionDir(),
  }));
  h('settings:get', () => settings.forRenderer());
  h('settings:set', (_e, patch) => {
    settings.set(patch || {});
    return settings.forRenderer();
  });
  /** "Test" in the proxy settings: a tiny request through the proxy exactly as typed (not saved yet). */
  h('proxy:test', async (_e, form = {}) => {
    const testUrl = 'https://www.gstatic.com/generate_204';
    try {
      let px = null;
      const saved = settings.get().proxy;
      if (form.mode === 'manual') {
        if (!form.host || !(Number(form.port) > 0)) return { ok: false, error: t('Enter the proxy address and port first.') };
        px = { type: form.type === 'socks5' ? 'socks5' : 'http', host: String(form.host), port: Number(form.port), username: form.username || '', password: form.password || (form.username && form.username === saved.username ? saved.password : '') };
      } else if (form.mode === 'system') {
        px = proxyConfig.parsePac(await session.defaultSession.resolveProxy(testUrl));
      }
      const r = await testConnection(px, testUrl);
      return { ok: r.ok, ms: r.ms, via: px ? proxyConfig.describe(px) : '' };
    } catch (e) {
      return { ok: false, error: proxyError(e) };
    }
  });

  h('downloads:list', () => manager.list());
  h('downloads:detail', (_e, id) => manager.get(id)?.detail() || null);
  h('downloads:probe', async (_e, opts) => {
    try {
      return await manager.probe(String(opts.url || '').trim(), opts);
    } catch (err) {
      const { friendlyError } = require('./engine/download');
      return { error: friendlyError(err) };
    }
  });
  h('downloads:add', (e, opts) => {
    const dl = manager.add(opts);
    if (opts.mode === 'now' && settings.get().showProgressWindow) windows.openProgress(dl.id);
    return dl.snapshot();
  });
  h('downloads:action', (e, payload) => runAction(senderWindow(e), payload || {}));
  h('downloads:deleteMany', (e, ids) => deleteMany(senderWindow(e), Array.isArray(ids) ? ids : []));
  h('downloads:contextMenu', (e, id) => contextMenuFor(senderWindow(e), id));
  h('downloads:pauseAll', () => manager.pauseAll());
  h('downloads:resumeAll', () => manager.resumeAll());

  h('queue:start', (_e, id) => manager.startQueue(manager.queueIdOr(id)));
  h('queue:stop', (_e, id) => manager.stopQueue(manager.queueIdOr(id)));
  h('queue:state', () => manager.queueState());
  h('queue:delete', async (e, id) => {
    const q = manager.queues().find((x) => x.id === id);
    if (!q || id === 'main') return false;
    const n = manager.queueItems(id).length;
    const main = manager.queues()[0];
    const { response } = await dialog.showMessageBox(senderWindow(e), {
      type: 'question',
      buttons: [t('Delete queue'), t('Cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: t('VN Download Manager'),
      message: t('Delete the queue “{name}”?', { name: t(q.name) }),
      detail: n ? t(n > 1 ? 'Its {n} downloads will move to “{main}”. Nothing is deleted from your disk.' : 'Its {n} download will move to “{main}”. Nothing is deleted from your disk.', { n: D(n), main: t(main.name) }) : t('The queue is empty.'),
    });
    if (response !== 0) return false;
    await manager.deleteQueue(id);
    settings.set({ queues: settings.get().queues.filter((q) => q.id !== id) });
    return true;
  });
  /** "Download Later" with several queues: a menu to pick one. Resolves the queue id, or null if dismissed. */
  h('queue:pick', (e) => {
    const queues = manager.queues();
    if (queues.length < 2) return 'main';
    return new Promise((resolve) => {
      let picked = null;
      const menu = Menu.buildFromTemplate([
        { label: t('Add to queue'), enabled: false },
        ...queues.map((q) => ({ label: q.name, click: () => (picked = q.id) })),
      ]);
      menu.popup({ window: senderWindow(e), callback: () => setTimeout(() => resolve(picked), 0) });
    });
  });
  h('queue:move', (_e, { ids, queueId } = {}) => {
    for (const id of Array.isArray(ids) ? ids : []) manager.setQueued(id, true, queueId);
    return true;
  });

  h('dialog:open', (_e, q) => (q && q.mode === 'add' ? openAddDialog(q) : windows.openDialog(q || { mode: 'add' })) && true);
  h('dialog:payload', (_e, token) => {
    const p = dialogPayloads.get(token) || null;
    dialogPayloads.delete(token);
    return p;
  });
  h('dialog:pickFolder', async (e, current) => {
    const r = await dialog.showOpenDialog(senderWindow(e), {
      title: t('Choose a folder'),
      defaultPath: current || settings.get().downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  h('disk:free', async (_e, dir) => {
    let p = dir || settings.get().downloadDir;
    while (p && !fs.existsSync(p)) {
      const up = path.dirname(p);
      if (up === p) break;
      p = up;
    }
    try {
      const st = await fs.promises.statfs(p);
      return st.bavail * st.bsize;
    } catch {
      return -1;
    }
  });

  h('player:open', async (_e, q) => {
    const part = 'persist:player';
    const ses = session.fromPartition(part);
    ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
      const headers = { ...d.requestHeaders };
      if (q.referrer) headers.Referer = q.referrer;
      if (q.cookies && sameHost(d.url, q.url)) headers.Cookie = q.cookies;
      cb({ requestHeaders: headers });
    });
    windows.openPlayer({ src: q.url, title: q.title || '', partition: part });
    return true;
  });
  h('player:external', (_e, q) => {
    const exe = findPlayer();
    if (exe) {
      spawn(exe, [q.url], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, player: path.basename(exe) };
    }
    return { ok: false };
  });

  h('window:close', (e) => senderWindow(e)?.close());
  h('window:minimize', (e) => senderWindow(e)?.minimize());
  h('window:resize', (e, height) => windows.resizeContent(senderWindow(e), height));

  h('extension:openFolder', () => shell.openPath(extensionDir()));
  h('power:cancel', () => power.cancel());
  h('power:state', () => (power.pending ? { action: power.pending.action } : null));
  h('shell:openPath', (_e, p) => shell.openPath(String(p || '')));

  // ---- video downloads (yt-dlp + ffmpeg)
  h('media:status', () => tools.status());
  h('media:install', async () => {
    try {
      return await tools.install((p) => windows.broadcast('media:install-progress', p));
    } catch (e) {
      return { error: t('Couldn’t download video support: {e}', { e: e.message }) };
    }
  });
  h('media:update', async () => {
    try {
      return await tools.update();
    } catch (e) {
      return { error: e.message };
    }
  });
  h('media:isVideoPage', (_e, url) => isVideoPage(String(url || '')));
  /** Tries each candidate (page, embedded player, sniffed streams) until yt-dlp finds a video. */
  h('media:probe', async (_e, opts = {}) => {
    if (!tools.ready()) return { needsTools: true, status: await tools.status() };
    const headers = { referrer: opts.referrer, cookies: opts.cookies, userAgent: opts.userAgent };
    const candidates = [...new Set([opts.url, ...(opts.candidates || [])].filter((u) => /^https?:\/\//i.test(u || '')))];
    let lastError = 'No video found on this page';
    const tryAll = async () => {
      for (const url of candidates) {
        try {
          return { ...(await probeMedia(tools.ytdlpPath, url, headers)), source: url };
        } catch (e) {
          lastError = e.message;
        }
      }
      return null;
    };
    let found = await tryAll();
    // Sites like YouTube change often; an outdated yt-dlp is the usual cause. Update once and retry.
    if (!found && lastError === FORMATS_MISSING && (await tools.updateIfStale(60 * 60 * 1000))) found = await tryAll();
    return found || { error: t(lastError) };
  });
  h('update:state', () => (updater ? updater.state : null));
  h('update:check', () => (updater ? updater.check() : null));
  h('update:action', (e) => updateAction(senderWindow(e)));
  // fixed links only: the renderer passes a name, never a URL
  h('shell:openSocial', (_e, id) => {
    const url = { telegram: 'https://t.me/mojtabatn', instagram: 'https://www.instagram.com/mojtabanavade' }[id];
    if (url) shell.openExternal(url);
    return !!url;
  });
  h('shell:openProject', (_e, what) => {
    const url = projectUrl();
    if (!url) return false;
    shell.openExternal(what === 'releases' ? `${url}/releases` : url);
    return true;
  });
  h('whatsnew:open', () => !!windows.openWhatsNew({ from: '', to: app.getVersion() }));
}

/** The project's GitHub page (package.json "homepage"); only https GitHub links are opened. */
// ---------------------------------------------------------------- updates (GitHub Releases)
function startUpdater() {
  if (!updater) {
    const repo = (projectUrl().match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/) || [])[1];
    if (!repo) return;
    // DM_UPDATE_API points the dev build at a local test server (ignored in the packaged app)
    const testApi = !app.isPackaged && process.env.DM_UPDATE_API;
    updater = new Updater({
      version: app.getVersion(),
      repo: repo.replace(/\.git$/, ''),
      cacheDir: path.join(app.getPath('userData'), 'updates'),
      // the portable exe and the (unsigned) Mac app can't replace themselves: they open the release page
      portable: !!process.env.PORTABLE_EXECUTABLE_FILE || IS_MAC,
      assetPattern: IS_MAC ? new RegExp(`^VDM-.*-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}\\.dmg$`, 'i') : null,
      ...(testApi ? { apiBase: testApi, allowedPrefixes: [testApi] } : {}),
    });
    updater.cleanup();
    updater.on('state', (st) => windows.broadcast('update:state', st));
  }
  updater.start({ enabled: () => settings.get().autoUpdate !== false, delay: Number(process.env.DM_UPDATE_DELAY) || 8000 });
}

/** Button in the sidebar: download → (ready) restart and install; the portable build opens the release page. */
async function updateAction(win) {
  if (!updater) return null;
  const st = updater.state;
  if (st.status === 'available' && (st.portable || !st.asset)) {
    shell.openExternal(st.page);
    return st;
  }
  if (st.status === 'available' || (st.status === 'error' && st.stage === 'download')) {
    updater.download().catch(() => {});
    return updater.state;
  }
  if (st.status === 'ready') {
    const active = lastActivity.active;
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      title: t('Update VDM'),
      message: t('Install VDM {v} now?', { v: I18N.ver(st.version) }),
      detail: active
        ? t(active > 1 ? 'VDM will close and reopen. {n} active downloads will pause and can be resumed afterwards.' : 'VDM will close and reopen. {n} active download will pause and can be resumed afterwards.', { n: D(active) })
        : 'VDM will close, install the update and open again.',
      buttons: [t('Restart and update'), t('Later')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (r.response !== 0) return st;
    pendingInstall = st.file;
    quit();
    return st;
  }
  if (st.status === 'error' || st.status === 'none' || st.status === 'idle') return updater.check();
  return st;
}

function runInstaller(file) {
  try {
    // NSIS (electron-builder): /S = silent, installs over the current copy; --force-run reopens VDM afterwards
    spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    logError('update', e);
  }
}

function projectUrl() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    const url = String(pkg.homepage || '');
    return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(url) ? url : '';
  } catch {
    return '';
  }
}

function sameHost(a, b) {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}
