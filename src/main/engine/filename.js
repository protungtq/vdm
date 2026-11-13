'use strict';

const fs = require('fs');
const path = require('path');
const { extOf, extForMime } = require('./categories');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Node exposes header values as latin1 strings; many servers put raw UTF-8
// bytes in `filename=`. Re-decode when the result is valid UTF-8.
function fixLatin1(str) {
  if (!/[\u0080-\u00ff]/.test(str)) return str;
  const buf = Buffer.from(str, 'latin1');
  const utf8 = buf.toString('utf8');
  return utf8.includes('\ufffd') ? str : utf8;
}

function parseContentDisposition(header) {
  if (!header) return '';
  const h = String(header);
  // RFC 5987/6266: filename*=UTF-8''%E2%82%AC%20rates.pdf
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(h);
  if (star) {
    const charset = (star[1] || 'utf-8').toLowerCase();
    const raw = star[2].trim().replace(/^"|"$/g, '');
    try {
      if (charset === 'utf-8' || charset === 'utf8') return decodeURIComponent(raw);
      return Buffer.from(unescape(raw), 'latin1').toString('latin1');
    } catch {
      /* fall through to plain filename */
    }
  }
  const quoted = /filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(h);
  if (quoted) return fixLatin1(quoted[1].replace(/\\(.)/g, '$1'));
  const plain = /filename\s*=\s*([^;]+)/i.exec(h);
  if (plain) {
    const v = plain[1].trim();
    try {
      return fixLatin1(/%[0-9a-f]{2}/i.test(v) ? decodeURIComponent(v) : v);
    } catch {
      return fixLatin1(v);
    }
  }
  return '';
}

function fromUrl(url) {
  try {
    const u = new URL(url);
    let last = u.pathname.split('/').filter(Boolean).pop() || '';
    try {
      last = decodeURIComponent(last);
    } catch {
      /* keep raw */
    }
    return last;
  } catch {
    return '';
  }
}

function sanitize(name) {
  let n = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!n) n = 'download';
  const ext = extOf(n);
  const base = ext ? n.slice(0, -(ext.length + 1)) : n;
  if (RESERVED.test(base)) n = `_${n}`;
  if (n.length > 200) {
    const keep = ext ? 199 - ext.length : 200;
    n = ext ? `${base.slice(0, keep)}.${ext}` : n.slice(0, 200);
  }
  return n;
}

/** Choose a file name from response headers + URL. */
function deriveFilename({ contentDisposition, finalUrl, url, contentType }) {
  let name = parseContentDisposition(contentDisposition) || fromUrl(finalUrl) || fromUrl(url) || 'download';
  name = sanitize(name);
  if (!extOf(name)) {
    const ext = extForMime(contentType);
    if (ext) name = `${name}.${ext}`;
  }
  return name;
}

/** "file.zip" -> "file (1).zip" ... until neither the file nor its partial exists. */
function uniquePath(dir, name, taken = new Set()) {
  const ext = extOf(name);
  const base = ext ? name.slice(0, -(ext.length + 1)) : name;
  for (let i = 0; i < 10000; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${ext ? '.' + ext : ''}`;
    const full = path.join(dir, candidate);
    const key = full.toLowerCase();
    if (taken.has(key)) continue;
    if (!fs.existsSync(full) && !fs.existsSync(full + '.dmpart')) return full;
  }
  return path.join(dir, `${base}-${Date.now()}${ext ? '.' + ext : ''}`);
}

module.exports = { parseContentDisposition, fromUrl, sanitize, deriveFilename, uniquePath };
