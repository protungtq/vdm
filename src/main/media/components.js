'use strict';

const { t } = require('../../shared/i18n');

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { request } = require('../engine/http');
const proxyConfig = require('../engine/proxy');

/**
 * Video support needs two helper programs that are downloaded on first use
 * (≈ 53 MB) instead of being bundled into the installer:
 *  - yt-dlp: finds the real video streams on 1000+ sites (YouTube, X, …)
 *  - ffmpeg: joins separate video + audio streams, converts audio to MP3
 */
/*
 * Every download is checked before it is used:
 *  - yt-dlp changes often, so it comes from its latest release, and is checked against the
 *    SHA2-256SUMS list published with that same release (resolved to one release tag first, so the
 *    program and the list always belong together). Its own "-U" update checks that list too.
 *  - ffmpeg is a fixed version whose SHA-256 is pinned here.
 * A file that doesn't match is deleted and never run.
 */
const YTDLP = (asset, file) => ({ latest: 'https://github.com/yt-dlp/yt-dlp/releases', asset, file, sums: 'SHA2-256SUMS' });
const FFMPEG = (name, sha256, file) => ({ url: `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/${name}`, sha256, file, gz: true });
const SOURCES = {
  win32: {
    ytdlp: YTDLP('yt-dlp.exe', 'yt-dlp.exe'),
    ffmpeg: FFMPEG('ffmpeg-win32-x64.gz', '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77', 'ffmpeg.exe'),
  },
  linux: {
    ytdlp: YTDLP('yt-dlp_linux', 'yt-dlp'),
    ffmpeg: FFMPEG('ffmpeg-linux-x64.gz', 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa', 'ffmpeg'),
  },
  darwin: {
    ytdlp: YTDLP('yt-dlp_macos', 'yt-dlp'),
    ffmpeg:
      process.arch === 'arm64'
        ? FFMPEG('ffmpeg-darwin-arm64.gz', '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa', 'ffmpeg')
        : FFMPEG('ffmpeg-darwin-x64.gz', '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106', 'ffmpeg'),
  },
};

class Components {
  /** sources: optional override of the download URLs (used by tests). */
  constructor(dir, platform = process.platform, sources = null) {
    this.dir = dir;
    this.src = sources || SOURCES[platform] || SOURCES.linux;
    this.installing = null;
    this.ytdlpVersion = null;
  }

  get ytdlpPath() {
    return path.join(this.dir, this.src.ytdlp.file);
  }
  get ffmpegPath() {
    return path.join(this.dir, this.src.ffmpeg.file);
  }

  ready() {
    return fs.existsSync(this.ytdlpPath) && fs.existsSync(this.ffmpegPath);
  }

  async status() {
    const ytdlp = fs.existsSync(this.ytdlpPath);
    const ffmpeg = fs.existsSync(this.ffmpegPath);
    if (ytdlp && !this.ytdlpVersion) this.ytdlpVersion = await this.run(this.ytdlpPath, ['--version']).catch(() => null);
    return {
      ready: ytdlp && ffmpeg,
      installing: !!this.installing,
      ytdlp: { installed: ytdlp, version: ytdlp ? this.ytdlpVersion : null },
      ffmpeg: { installed: ffmpeg },
      downloadSize: (ytdlp ? 0 : 24) + (ffmpeg ? 0 : 30), // MB, roughly
    };
  }

  run(file, args, timeout = 20000) {
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } }, (err, out) =>
        err ? reject(err) : resolve(String(out).trim())
      );
    });
  }

  /** Downloads whatever is missing. onProgress({ step, received, total }). */
  install(onProgress = () => {}) {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      await fsp.mkdir(this.dir, { recursive: true });
      const todo = [];
      if (!fs.existsSync(this.ytdlpPath)) todo.push(['ytdlp', this.src.ytdlp, this.ytdlpPath]);
      if (!fs.existsSync(this.ffmpegPath)) todo.push(['ffmpeg', this.src.ffmpeg, this.ffmpegPath]);
      // One combined progress bar across both files.
      const totals = new Map();
      const got = new Map();
      const report = (step) => {
        const total = [...totals.values()].reduce((a, b) => a + b, 0);
        const received = [...got.values()].reduce((a, b) => a + b, 0);
        onProgress({ step, received, total, files: todo.length });
      };
      await Promise.all(
        todo.map(async ([name, src, dest]) => {
          const tmp = dest + '.download';
          const { url, sha256 } = await resolveSource(src);
          const { req, res } = await request(url, { timeout: 60000 });
          if (res.statusCode !== 200) {
            res.resume();
            req.destroy();
            throw new Error(t('Could not download {name} (HTTP {code})', { name, code: res.statusCode }));
          }
          totals.set(name, Number(res.headers['content-length']) || 0);
          got.set(name, 0);
          const hash = crypto.createHash('sha256');
          res.on('data', (c) => {
            hash.update(c);
            got.set(name, got.get(name) + c.length);
            report(name);
          });
          const out = fs.createWriteStream(tmp, { mode: 0o755 });
          if (src.gz) await pipeline(res, zlib.createGunzip(), out);
          else await pipeline(res, out);
          // the hash covers the file exactly as published (the .gz for ffmpeg)
          if (hash.digest('hex') !== sha256) {
            await fsp.rm(tmp, { force: true });
            throw new Error(t('The downloaded {name} failed its integrity check and was deleted', { name: name === 'ytdlp' ? 'yt-dlp' : 'ffmpeg' }));
          }
          await fsp.rename(tmp, dest);
          if (process.platform !== 'win32') await fsp.chmod(dest, 0o755);
        })
      );
      this.ytdlpVersion = null;
      return this.status();
    })().finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  /**
   * Updates yt-dlp if the last update attempt is older than maxAge (ms).
   * Resolves true when an update was attempted, false when it was recent enough.
   */
  async updateIfStale(maxAge) {
    const stamp = path.join(this.dir, '.last-update');
    let last = 0;
    try {
      last = Number(await fsp.readFile(stamp, 'utf8')) || 0;
    } catch {
      try {
        last = (await fsp.stat(this.ytdlpPath)).mtimeMs; // first time: use the install date
      } catch {
        /* not installed */
      }
    }
    if (Date.now() - last < maxAge) return false;
    await fsp.writeFile(stamp, String(Date.now())).catch(() => {});
    await this.update().catch(() => {});
    return true;
  }

  /** yt-dlp updates itself in place (sites change often, so this matters). */
  async update() {
    if (!fs.existsSync(this.ytdlpPath)) return this.install();
    const proxyArgs = await proxyConfig.ytdlpArgs('https://github.com/').catch(() => []);
    await this.run(this.ytdlpPath, ['-U', ...proxyArgs], 120000).catch(async () => {
      // Fall back to a fresh download if self-update isn't possible.
      await fsp.rm(this.ytdlpPath, { force: true });
      await this.install();
    });
    this.ytdlpVersion = null;
    return this.status();
  }
}

/**
 * Turns a source into { url, sha256 }. Fixed files carry their hash; "latest" sources are resolved
 * to one release tag, and the hash is read from that release's checksum list.
 */
async function resolveSource(src) {
  if (!src.latest) {
    if (!/^[0-9a-f]{64}$/.test(src.sha256 || '')) throw new Error('No checksum known for this download');
    return { url: src.url, sha256: src.sha256 };
  }
  // .../releases/latest redirects to .../releases/tag/<tag>
  const { req, res, url: page } = await request(`${src.latest}/latest`, { timeout: 30000 });
  res.resume();
  req.destroy();
  const tag = (/\/releases\/tag\/([^/?#]+)/.exec(page) || [])[1];
  // no redirect (some proxies): fall back to the "latest" links; a release published in between
  // makes the check fail safely, and the next attempt succeeds
  const base = tag ? `${src.latest}/download/${tag}` : `${src.latest}/latest/download`;
  const sums = await fetchText(`${base}/${src.sums}`);
  const line = sums.split(/\r?\n/).find((l) => l.trim().split(/\s+\*?/)[1] === src.asset);
  const sha256 = line && line.trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256 || '')) throw new Error(`No checksum published for ${src.asset}`);
  return { url: `${base}/${src.asset}`, sha256 };
}

async function fetchText(url) {
  const { req, res } = await request(url, { timeout: 30000 });
  if (res.statusCode !== 200) {
    res.resume();
    req.destroy();
    throw new Error(`Could not download the checksum list (HTTP ${res.statusCode})`);
  }
  let text = '';
  res.setEncoding('utf8');
  for await (const c of res) {
    text += c;
    if (text.length > 1_000_000) break;
  }
  req.destroy();
  return text;
}

module.exports = { Components, SOURCES };
