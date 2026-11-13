'use strict';

const { looksDownloadable } = require('../engine/categories');

/**
 * Watches the clipboard for copied file links (IDM-style) and reports new ones.
 * Newer Electron versions return a Promise from clipboard.readText(), older
 * ones a string — both are handled. Nothing is read while the feature is off.
 */
function watchClipboard({ clipboard, isEnabled, onLink }) {
  let last = null; // null = take a fresh baseline without triggering
  let busy = false;

  const read = async () => {
    try {
      const v = await clipboard.readText();
      return typeof v === 'string' ? v.trim() : '';
    } catch {
      return '';
    }
  };

  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (!isEnabled()) {
        last = null;
        return;
      }
      const text = await read();
      if (last === null || text === last) {
        last = text;
        return;
      }
      last = text;
      if (!text || text.length > 4096 || /\s/.test(text)) return;
      if (looksDownloadable(text)) onLink(text);
    } finally {
      busy = false;
    }
  }, 1000);

  return {
    /** Call when the app itself writes to the clipboard so it doesn't trigger. */
    ignore(text) {
      last = String(text || '').trim();
    },
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { watchClipboard };
