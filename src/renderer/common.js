'use strict';
/* Shared renderer helpers (classic script, exposes window.DM). */
(function () {
  const params = new URLSearchParams(location.search);

  // Theme id -> light/dark base (drives icon variants, color-scheme, dark-only rules).
  const THEME_BASE = {
    light: 'light', dark: 'dark', day: 'light', paper: 'light', mint: 'light', retro: 'light',
    night: 'dark', ocean: 'dark', neon: 'dark', jungle: 'dark',
  };
  function setTheme(t) {
    const id = THEME_BASE[t] ? t : 'light';
    document.documentElement.dataset.theme = id;
    document.documentElement.dataset.base = THEME_BASE[id];
  }
  setTheme(params.get('theme'));

  // ---- texts: all English for now (see shared/i18n.js for adding a language)
  const { t, digits } = I18N;
  I18N.setLang(params.get('lang') || 'en');
  const FA = false;

  /** Translates the page's fixed text (text nodes, title / placeholder / alt) once it has been parsed. */
  function translateDom(root = document.body) {
    if (I18N.getLang() === 'en') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const raw = n.nodeValue.trim();
      if (raw && I18N.has(raw)) n.nodeValue = n.nodeValue.replace(raw, t(raw));
    }
    for (const e of root.querySelectorAll('[title],[placeholder],[alt],[aria-label],[data-tip]')) {
      for (const a of ['title', 'placeholder', 'alt', 'aria-label', 'data-tip']) {
        const v = e.getAttribute(a);
        if (v && I18N.has(v)) e.setAttribute(a, t(v));
      }
    }
    if (document.title && I18N.has(document.title)) document.title = t(document.title);
  }
  const ready = (fn) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', fn) : fn());
  ready(() => translateDom());
  // macOS: traffic lights on the left of the title bar, ⌘ shortcuts
  if (/Macintosh/.test(navigator.userAgent)) document.documentElement.dataset.platform = 'mac';
  window.api.on('theme:changed', setTheme);

  // Sizes, speeds and times: Persian shows Persian digits and unit names (مگابایت).
  function fmtBytes(n, places = 2) {
    if (!(n >= 0)) return '—';
    if (n < 1024) return digits(`${n} ${t('B')}`);
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return digits(`${v.toFixed(i === 0 ? 0 : places)} ${t(units[i])}`);
  }

  function fmtSpeed(bps) {
    if (!(bps > 0)) return digits(`0 ${t('KB')}/${t('sec')}`);
    if (bps >= 1024 * 1024) return digits(`${(bps / 1048576).toFixed(1)} ${t('MB')}/${t('sec')}`);
    return digits(`${Math.max(1, Math.round(bps / 1024))} ${t('KB')}/${t('sec')}`);
  }

  function fmtEta(sec) {
    if (!(sec >= 0) || !isFinite(sec)) return '--:--:--';
    sec = Math.round(sec);
    if (sec > 99 * 3600) return digits('99:59:59+');
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return digits([h, m, s].map((x) => String(x).padStart(2, '0')).join(':'));
  }

  function fmtSizePair(d) {
    if (d.size > 0) return `${fmtBytes(d.downloaded)}/${fmtBytes(d.size)}`; // right-to-left text reads it in the right order
    return fmtBytes(d.downloaded);
  }

  function pct(d) {
    if (d.status === 'completed') return 100;
    return d.size > 0 ? Math.min(100, (d.downloaded / d.size) * 100) : 0;
  }

  const CAT = { video: 'video', audio: 'audio', zip: 'zip', text: 'text', exe: 'exe', other: 'other' };
  function catIcon(category, size = 'min') {
    return `assets/categories/${CAT[category] || 'other'}-${size}.svg`;
  }

  const MEDIA_EXT = /\.(mp4|mkv|webm|mov|m4v|avi|wmv|flv|ts|mp3|m4a|aac|flac|wav|ogg|opus)$/i;

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = I18N.has(v) ? t(v) : v;
      else if ((k === 'title' || k === 'placeholder') && typeof v === 'string' && I18N.has(v)) e.setAttribute(k, t(v));
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) e.append(c);
    return e;
  }

  function icon(name, cls = '') {
    return el('img', { src: `assets/icons/${name}.svg`, class: cls, alt: '' });
  }

  /** Icon with separate light/dark artwork (as drawn in the Figma file). */
  function themedIcon(name, cls = '') {
    const wrap = document.createDocumentFragment();
    wrap.append(icon(name, `${cls} only-light`), icon(`${name}-dark`, `${cls} only-dark`));
    return wrap;
  }

  let toastTimer;
  function toast(text, ms = 2200) {
    let t = document.getElementById('toast');
    if (!t) {
      t = el('div', { id: 'toast', class: 'toast' });
      document.body.append(t);
    }
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
  window.api.on('toast', (p) => p && p.text && toast(p.text));

  function splitUrls(text) {
    return String(text || '')
      .split(/[\s"'<>]+/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\/\S+/i.test(s));
  }

  /** A translated sentence with {placeholders} replaced by DOM nodes (e.g. <code> elements). */
  function rich(key, nodes) {
    const frag = document.createDocumentFragment();
    for (const part of t(key).split(/(\{\w+\})/)) {
      const m = /^\{(\w+)\}$/.exec(part);
      if (m && nodes[m[1]]) frag.append(nodes[m[1]]);
      else if (part) frag.append(part);
    }
    return frag;
  }

  window.DM = { v: I18N.ver, rich, t, digits, n: (x) => digits(String(x)), dateTime: I18N.dateTime, FA, translateDom, ready, params, setTheme, fmtBytes, fmtSpeed, fmtEta, fmtSizePair, pct, catIcon, el, icon, themedIcon, toast, splitUrls, MEDIA_EXT };
})();
