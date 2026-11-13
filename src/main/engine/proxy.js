'use strict';

/*
 * Proxy settings shared by everything in the main process that talks to the network:
 * downloads, the video tools, tool installs and the update check.
 *
 *   settings.proxy = { mode: 'none' | 'system' | 'manual', type: 'http' | 'socks5',
 *                      host, port, username, password }
 *   'system' follows the operating system's proxy (Windows / macOS settings, PAC scripts),
 *   resolved through Electron: configure({ resolveSystem }) supplies that function.
 *
 * Nothing is configured in unit tests, so they connect directly.
 */

let getConfig = () => null;
let resolveSystem = null; // async (url) => 'PROXY host:port; DIRECT' (Chromium's PAC format)
const cache = new Map(); // host -> { value, until } for system lookups

function configure(opts = {}) {
  if (opts.getConfig) getConfig = opts.getConfig;
  if ('resolveSystem' in opts) resolveSystem = opts.resolveSystem;
  cache.clear();
}

/** Addresses that never go through a proxy: this computer (VDM's own bridge, local servers). */
function isLocal(host) {
  return /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i.test(String(host || ''));
}

/** First usable entry of a PAC-style answer such as "PROXY a:8080; SOCKS5 b:1080; DIRECT". */
function parsePac(text) {
  for (const part of String(text || '').split(';')) {
    const m = /^\s*(DIRECT|PROXY|HTTPS?|SOCKS5?|SOCKS4)\s*(?:\[?([^\]\s]+?)\]?:(\d+))?\s*$/i.exec(part);
    if (!m) continue;
    const kind = m[1].toUpperCase();
    if (kind === 'DIRECT') return null;
    if (!m[2] || !m[3]) continue;
    return { type: kind.startsWith('SOCKS') ? (kind === 'SOCKS4' ? 'socks4' : 'socks5') : 'http', host: m[2], port: Number(m[3]) };
  }
  return null;
}

/** The proxy to use for this URL: { type, host, port, username?, password? } or null for a direct connection. */
async function forUrl(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (isLocal(host)) return null;
  const cfg = getConfig() || {};
  if (cfg.mode === 'manual') {
    if (!cfg.host || !(cfg.port > 0)) return null;
    return { type: cfg.type === 'socks5' ? 'socks5' : 'http', host: cfg.host, port: Number(cfg.port), username: cfg.username || '', password: cfg.password || '' };
  }
  if (cfg.mode === 'system' && resolveSystem) {
    const hit = cache.get(host);
    if (hit && hit.until > Date.now()) return hit.value;
    let value = null;
    try {
      value = parsePac(await resolveSystem(url));
    } catch {
      /* no answer: connect directly */
    }
    cache.set(host, { value, until: Date.now() + 60_000 });
    return value;
  }
  return null;
}

/** "http://host:port" for display, never with the password. */
function describe(p) {
  return p ? `${p.type === 'socks5' ? 'socks5' : p.type}://${p.host}:${p.port}` : '';
}

/**
 * Command-line arguments that make yt-dlp use the same proxy.
 * 'none' passes an empty --proxy, which also ignores proxy environment variables.
 */
async function ytdlpArgs(url = 'https://www.youtube.com/') {
  const cfg = getConfig() || {};
  if (!cfg.mode || cfg.mode === 'none') return ['--proxy', ''];
  const p = await forUrl(url);
  if (!p) return ['--proxy', ''];
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || '')}@` : '';
  const scheme = p.type === 'socks5' ? 'socks5h' : p.type === 'socks4' ? 'socks4a' : 'http'; // proxy-side DNS
  return ['--proxy', `${scheme}://${auth}${p.host}:${p.port}`];
}

module.exports = { configure, forUrl, describe, ytdlpArgs, parsePac, isLocal };
