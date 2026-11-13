'use strict';

const path = require('path');
const { BrowserWindow, screen, shell } = require('electron');
const { t } = require('../shared/i18n');

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const ICON = path.join(RENDERER, 'assets', 'app-256.png');
const TITLE_H = 32;
// The native caption buttons (min / max / close) are painted by Windows on top
// of the page. Keep them 1px shorter than the HTML title bar so its bottom
// border line stays visible underneath them too.
const OVERLAY_H = TITLE_H - 1;
const IS_MAC = process.platform === 'darwin';

// Window chrome colours per theme (title bar strip + caption buttons).
// Native window chrome per theme: title-bar strip behind the caption buttons
// (main window / dialogs), caption symbol colour, and window background.
// Must match --title-bg / --dialog / --bg in styles/base.css + themes.css.
const T = (base, main, dialog, symbol, bgMain, bgDialog) => ({ base, main, dialog, symbol, bg: { main: bgMain, dialog: bgDialog, player: '#000000' } });
const THEMES = {
  light: T('light', '#FFFFFF', '#FFFFFF', '#191919', '#F6F6F6', '#FFFFFF'),
  dark: T('dark', '#141218', '#211F26', '#FFFFFF', '#141218', '#211F26'),
  day: T('light', '#F6F9FF', '#FFFFFF', '#14213D', '#EEF4FF', '#FFFFFF'),
  night: T('dark', '#161B2B', '#1D2335', '#FFFFFF', '#161B2B', '#1D2335'),
  paper: T('light', '#FBF8F1', '#FFFCF6', '#2B2420', '#F4EFE6', '#FFFCF6'),
  mint: T('light', '#FFFFFF', '#FFFFFF', '#14241C', '#EFF6F2', '#FFFFFF'),
  ocean: T('dark', '#0A2A5E', '#0F3462', '#FFFFFF', '#0A2A5E', '#0F3462'),
  neon: T('dark', '#1A0638', '#240A4A', '#FFFFFF', '#1A0638', '#240A4A'),
  jungle: T('dark', '#0E2F23', '#143A2C', '#FFFFFF', '#0E2F23', '#143A2C'),
  retro: T('light', '#000080', '#000080', '#FFFFFF', '#C0C0C0', '#C0C0C0'),
};

class Windows {
  constructor(getTheme) {
    this.getTheme = getTheme; // () => 'light' | 'dark'
    this.main = null;
    this.dialogs = new Set();
    this.progress = new Map(); // download id -> window
    this.player = null;
  }

  all() {
    return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  }

  broadcast(channel, payload) {
    for (const w of this.all()) w.webContents.send(channel, payload);
  }

  chromeFor(kind) {
    const t = THEMES[this.getTheme()] || THEMES.light;
    const role = kind === 'main' ? 'main' : 'dialog';
    return { color: t[role], symbolColor: t.symbol, height: OVERLAY_H, bg: t.bg[kind] || t.bg.dialog };
  }

  applyTheme() {
    for (const w of this.all()) {
      const kind = w.__kind || 'dialog';
      const c = this.chromeFor(kind);
      try {
        w.setBackgroundColor(c.bg);
        if (kind !== 'player' && !IS_MAC) w.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor, height: OVERLAY_H });
      } catch {
        /* overlay not supported on this platform */
      }
    }
  }

  create(kind, page, { width, height, query = {}, resizable = false, minWidth, minHeight, parent, show = true, title, partition } = {}) {
    const c = this.chromeFor(kind);
    const win = new BrowserWindow({
      width,
      height,
      minWidth,
      minHeight,
      resizable,
      maximizable: resizable,
      fullscreenable: kind === 'player',
      show: false,
      title: title || t('VN Download Manager'),
      icon: ICON,
      parent,
      backgroundColor: c.bg,
      titleBarStyle: kind === 'player' ? 'default' : 'hidden',
      // Windows: native min/max/close painted over our title bar. macOS: the traffic lights,
      // centred in the 32px title bar (the page leaves room for them on the left).
      ...(kind === 'player'
        ? {}
        : IS_MAC
          ? { trafficLightPosition: { x: 12, y: 9 } }
          : { titleBarOverlay: { color: c.color, symbolColor: c.symbolColor, height: OVERLAY_H } }),
      autoHideMenuBar: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
        ...(partition ? { partition } : {}),
      },
    });
    win.__kind = kind;
    win.__page = page;
    win.__query = query;
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(RENDERER, page), { query: { theme: this.getTheme(), ...query } });
    if (show) win.once('ready-to-show', () => this.reveal(win));
    // Never let a dropped link or stray anchor navigate the app away.
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('file://')) e.preventDefault();
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    return win;
  }

  reveal(win) {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // Bring dialogs above the browser when triggered from the extension.
    win.setAlwaysOnTop(true);
    setTimeout(() => !win.isDestroyed() && win.setAlwaysOnTop(false), 400);
  }

  openMain({ show = true } = {}) {
    if (this.main && !this.main.isDestroyed()) {
      if (show) this.reveal(this.main);
      return this.main;
    }
    this.main = this.create('main', 'main.html', {
      width: 800,
      height: 480,
      minWidth: 760,
      minHeight: 440,
      resizable: true,
      show,
      title: t('VN Download Manager'),
    });
    this.main.on('closed', () => (this.main = null));
    return this.main;
  }

  /** Add-link / download-info dialog. query: { mode: 'add'|'info'|'refresh', url, ... } */
  openDialog(query) {
    const sizes = { add: 186, info: 265, refresh: 186, media: 440 };
    const win = this.create('dialog', 'dialog.html', {
      width: 580,
      height: sizes[query.mode] || 186,
      query: { ...query, payload: query.payload ? JSON.stringify(query.payload) : '' },
      title: t(query.mode === 'info' ? 'Download File Info' : query.mode === 'media' ? 'Download Video' : 'Add New Download'),
    });
    this.dialogs.add(win);
    win.on('closed', () => this.dialogs.delete(win));
    this.cascade(win);
    return win;
  }

  /** "What's new" after an update. query: { from?: last seen version, to: current version } */
  openWhatsNew(query) {
    if (this.whatsNew && !this.whatsNew.isDestroyed()) {
      this.reveal(this.whatsNew);
      return this.whatsNew;
    }
    this.whatsNew = this.create('dialog', 'whatsnew.html', { width: 520, height: 600, resizable: false, query, title: t('What’s new') });
    this.whatsNew.on('closed', () => (this.whatsNew = null));
    return this.whatsNew;
  }

  openProgress(id) {
    const existing = this.progress.get(id);
    if (existing && !existing.isDestroyed()) {
      this.reveal(existing);
      return existing;
    }
    const win = this.create('dialog', 'progress.html', { width: 580, height: 240, query: { id }, title: t('Downloading') });
    this.progress.set(id, win);
    win.on('closed', () => this.progress.delete(id));
    this.cascade(win);
    return win;
  }

  closeProgress(id) {
    const w = this.progress.get(id);
    if (w && !w.isDestroyed()) w.close();
  }

  openPlayer(query) {
    if (this.player && !this.player.isDestroyed()) this.player.close();
    this.player = this.create('player', 'player.html', {
      width: 960,
      height: 580,
      minWidth: 480,
      minHeight: 300,
      resizable: true,
      query: { src: query.src, title: query.title },
      partition: query.partition,
      title: query.title || t('Online Watch'),
    });
    this.player.on('closed', () => (this.player = null));
    return this.player;
  }

  /** Offset stacked dialogs slightly so they don't hide each other. */
  cascade(win) {
    const open = [...this.dialogs, ...this.progress.values()].filter((w) => w !== win && !w.isDestroyed() && w.isVisible());
    if (!open.length) return;
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const [w, h] = win.getSize();
    const n = open.length % 8;
    const x = Math.round(area.x + (area.width - w) / 2 + n * 24);
    const y = Math.round(area.y + (area.height - h) / 2 + n * 24);
    win.setPosition(x, y);
  }

  resizeContent(win, height) {
    if (!win || win.isDestroyed()) return;
    const [w] = win.getContentSize();
    const [x, y] = win.getPosition();
    const [, oldH] = win.getSize();
    win.setContentSize(w, Math.round(height));
    const [, newH] = win.getSize();
    // keep the window visually anchored around its centre
    win.setPosition(x, Math.max(0, Math.round(y - (newH - oldH) / 2)));
  }
}

/** Settings value -> the theme id to render (Light is the default). */
function resolveTheme(setting) {
  return THEMES[setting] ? setting : 'light';
}

/** What Electron's nativeTheme should follow (native menus, dialogs, scrollbars). */
function nativeThemeSource(setting) {
  return THEMES[resolveTheme(setting)].base;
}

module.exports = { Windows, resolveTheme, nativeThemeSource, THEMES };
