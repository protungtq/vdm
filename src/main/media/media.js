'use strict';

const { t, digits: D } = require('../../shared/i18n');

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { sanitize, uniquePath } = require('../engine/filename');
const proxyConfig = require('../engine/proxy');

// yt-dlp is a Python program: force UTF-8 so non-English titles survive on Windows.
// ELECTRON_RUN_AS_NODE lets yt-dlp use VDM's own executable as its JavaScript runtime (see jsArgs).
const childEnv = () => ({ ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) });

/**
 * YouTube only hands out its video files after a JavaScript challenge is solved, so yt-dlp needs a
 * JavaScript runtime. Electron contains Node.js: started with ELECTRON_RUN_AS_NODE=1, VDM's own
 * executable behaves exactly like `node`, so users don't have to install anything.
 */
const jsArgs = () => ['--js-runtimes', `node:${process.execPath}`];
const KNOWN_VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|x\.com|twitter\.com|instagram\.com|tiktok\.com|vimeo\.com|facebook\.com|fb\.watch|aparat\.com|twitch\.tv|dailymotion\.com|reddit\.com|soundcloud\.com|bilibili\.com|vk\.com|ok\.ru|rumble\.com|streamable\.com|telewebion\.com|namava\.ir|filimo\.com)$/i;

function isVideoPage(url) {
  try {
    return KNOWN_VIDEO_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function headerArgs({ referrer, cookies, userAgent } = {}) {
  const a = [];
  if (userAgent) a.push('--user-agent', userAgent);
  if (referrer) a.push('--referer', referrer);
  if (cookies) a.push('--add-header', `Cookie:${cookies}`);
  return a;
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => proc.kill());
  } else {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }
  }
}

/** Runs `yt-dlp -J` and returns the parsed info JSON. */
async function probeInfo(ytdlp, url, headers = {}, timeout = 90000) {
  const proxyArgs = await proxyConfig.ytdlpArgs(url).catch(() => []); // same proxy as downloads
  return new Promise((resolve, reject) => {
    const args = ['-J', '--no-playlist', '--no-warnings', '--no-colors', ...jsArgs(), ...proxyArgs, ...headerArgs(headers), '--', url];
    const p = spawn(ytdlp, args, { windowsHide: true, env: childEnv() });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      killTree(p);
      reject(new Error('Timed out while looking for the video'));
    }, timeout);
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) {
        try {
          return resolve(JSON.parse(out));
        } catch {
          return reject(new Error('Could not read video information'));
        }
      }
      reject(new Error(cleanError(err) || `yt-dlp exited with code ${code}`));
    });
  });
}

const FORMATS_MISSING = 'The site didn’t offer a downloadable version of this video';

function cleanError(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.filter((l) => /ERROR:/.test(l)).pop();
  if (!line) return lines.length ? lines[lines.length - 1].slice(0, 200) : '';
  let msg = line.replace(/^.*?ERROR:\s*/, '').replace(/\[[^\]]+\]\s*[\w-]+:\s*/, '');
  if (/Unsupported URL/i.test(msg)) msg = 'No video found on this page';
  if (/Requested format is not available|Only images are available|n challenge|nsig/i.test(msg)) msg = FORMATS_MISSING;
  if (/DRM/i.test(msg)) msg = 'This video is DRM-protected and can’t be downloaded';
  if (/Sign in|login|cookies/i.test(msg)) msg = 'This video needs you to be signed in — try the browser button instead';
  if (/Private video|unavailable/i.test(msg)) msg = 'This video is private or unavailable';
  return msg.slice(0, 200);
}

const SITE_NAMES = { Youtube: 'YouTube', YoutubeTab: 'YouTube', Twitter: 'X', TwitterBroadcast: 'X', Instagram: 'Instagram', TikTok: 'TikTok', Vimeo: 'Vimeo', Facebook: 'Facebook', Aparat: 'Aparat', SoundCloud: 'SoundCloud', Twitch: 'Twitch' };
const sizeOf = (f, dur) => (f && (f.filesize || f.filesize_approx || (f.tbr && dur ? f.tbr * 125 * dur : 0))) || 0;
const codecName = (c = '') => (/^avc1|h264/i.test(c) ? 'H.264' : /^vp0?9/i.test(c) ? 'VP9' : /^av01/i.test(c) ? 'AV1' : /^hev|hvc|h265/i.test(c) ? 'HEVC' : '');
const nick = (h) => (h >= 2160 ? '4K' : h >= 1440 ? '2K' : h >= 1080 ? t('Full HD') : h >= 720 ? t('HD') : '');

/** Turns yt-dlp's long format list into a few clear choices. */
function buildOptions(info) {
  const formats = Array.isArray(info.formats) && info.formats.length ? info.formats : [info];
  const dur = info.duration || 0;
  const hasV = (f) => f.vcodec && f.vcodec !== 'none';
  const hasA = (f) => f.acodec && f.acodec !== 'none';
  const vids = formats.filter((f) => hasV(f) && f.height);
  const auds = formats.filter((f) => hasA(f) && !hasV(f));
  const bestAudio = [...auds].sort((a, b) => sizeOf(b, dur) - sizeOf(a, dur))[0];
  const heights = [...new Set(vids.map((f) => f.height))].sort((a, b) => b - a).slice(0, 8);
  const options = [];
  for (const h of heights) {
    const atH = vids.filter((f) => f.height === h);
    const pick = atH.find((f) => /^avc1/.test(f.vcodec)) || [...atH].sort((a, b) => sizeOf(b, dur) - sizeOf(a, dur))[0];
    const size = sizeOf(pick, dur) + (hasA(pick) ? 0 : sizeOf(bestAudio, dur));
    const fps = Math.round(pick.fps || 0);
    options.push({
      id: `v${h}`,
      height: h,
      label: `${h}p${fps > 30 ? fps : ''}`,
      detail: ['MP4', nick(h), codecName(pick.vcodec)].filter(Boolean).join(' · '),
      size,
      format: `bv*[height<=${h}][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=${h}]+ba/b[height<=${h}]/b`,
      audioOnly: false,
      ext: 'mp4',
    });
  }
  if (auds.length || formats.some(hasA)) {
    options.push({ id: 'audio', height: 0, label: t('Audio only'), detail: 'MP3', size: sizeOf(bestAudio, dur), format: 'ba/b', audioOnly: true, ext: 'mp3' });
  }
  if (!options.length) {
    options.push({ id: 'best', height: 0, label: t('Best quality'), detail: String(info.ext || 'mp4').toUpperCase(), size: sizeOf(info, dur), format: 'bv*+ba/b', audioOnly: false, ext: info.ext || 'mp4' });
  }
  return options;
}

/** Probes a page (or stream) and returns a compact description for the dialog. */
async function probeMedia(ytdlp, url, headers) {
  const info = await probeInfo(ytdlp, url, headers);
  if (info._type === 'playlist' && Array.isArray(info.entries) && info.entries[0]) Object.assign(info, info.entries[0]);
  const thumb = info.thumbnail || (Array.isArray(info.thumbnails) && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : '');
  return {
    url,
    title: info.title || info.fulltitle || 'video',
    site: info.extractor_key && info.extractor_key !== 'Generic' ? SITE_NAMES[info.extractor_key] || info.extractor_key : new URL(url).hostname.replace(/^www\./, ''),
    duration: info.duration || 0,
    thumbnail: /^https?:/.test(thumb) ? thumb : '',
    options: buildOptions(info),
  };
}

/**
 * A download handled by yt-dlp (video pages, HLS/DASH streams). Same shape as
 * engine/download.js so the manager, queue and UI treat both alike.
 */
class MediaDownload extends EventEmitter {
  constructor(data, ctx) {
    super();
    this.ctx = ctx; // { tools: Components, settings() }
    this.d = { type: 'media', size: -1, downloaded: 0, status: 'paused', queued: false, error: null, speedLimit: 0, connections: 8, ...data };
    this.running = false;
    this.speed = 0;
    this.eta = -1;
    this.stage = '';
    this.proc = null;
  }

  get id() {
    return this.d.id;
  }
  get tempPath() {
    return this.d.savePath + '.part';
  }

  snapshot() {
    const d = this.d;
    return {
      id: d.id,
      type: 'media',
      url: d.url,
      filename: d.filename,
      savePath: d.savePath,
      dir: d.dir,
      size: d.size,
      downloaded: d.size > 0 ? Math.min(d.downloaded, d.size) : d.downloaded,
      status: d.status,
      stage: this.running ? this.stage : '',
      speed: this.running ? Math.round(this.speed) : 0,
      eta: this.running ? this.eta : -1,
      category: d.category,
      resumable: true,
      error: d.error,
      queued: d.queued,
      queueOrder: d.queueOrder || 0,
      queueId: d.queued ? d.queueId || 'main' : null,
      createdAt: d.createdAt,
      completedAt: d.completedAt || null,
      startedAt: d.startedAt || null,
      lastTryAt: d.lastTryAt || d.completedAt || d.startedAt || null,
      activeConnections: this.running ? 1 : 0,
      connections: d.connections,
      speedLimit: d.speedLimit || 0,
      quality: d.quality || '',
    };
  }

  detail() {
    return { ...this.snapshot(), referrer: this.d.referrer || '', segments: [], conns: [] };
  }

  toJSON() {
    return { ...this.d };
  }

  flushedBytes() {
    return this.d.downloaded;
  }

  recomputeDownloaded() {}

  setStatus(status) {
    if (this.d.status === status) return;
    this.d.status = status;
    this.emit('change', this);
  }

  update(patch) {
    Object.assign(this.d, patch);
    this.emit('change', this);
  }

  tick() {}

  /** Base path without extension; yt-dlp picks the real extension. */
  get outBase() {
    return this.d.savePath.replace(/\.[^.\\/]+$/, '');
  }

  start() {
    if (this.running) return this.runPromise;
    if (this.d.status === 'completed') return Promise.resolve();
    this.running = true;
    this.abortReason = null;
    this.d.error = null;
    this.stage = 'Connecting…';
    this.d.startedAt = this.d.startedAt || Date.now();
    this.d.lastTryAt = Date.now();
    this.setStatus('connecting');
    this.runPromise = this.run().finally(() => {
      this.running = false;
      this.proc = null;
      this.speed = 0;
      this.emit('change', this);
      this.emit('stopped', this);
    });
    return this.runPromise;
  }

  async run() {
    try {
      await fsp.mkdir(this.d.dir, { recursive: true });
    } catch (e) {
      this.d.error = e.code === 'EACCES' || e.code === 'EPERM' ? t('No permission to write to the folder') : e.message;
      this.setStatus('error');
      this.emit('failed', this);
      return;
    }
    return this.spawnYtdlp();
  }

  spawnYtdlp() {
    return proxyConfig
      .ytdlpArgs(this.d.url)
      .catch(() => [])
      .then((proxyArgs) => this.spawnYtdlpWith(proxyArgs));
  }

  spawnYtdlpWith(proxyArgs) {
    return new Promise((resolve) => {
      const tools = this.ctx.tools;
      if (!tools.ready()) {
        this.d.error = t('Video support is not installed (Settings → Video downloads)');
        this.setStatus('error');
        this.emit('failed', this);
        return resolve();
      }
      const s = this.ctx.settings();
      const limit = (this.d.speedLimit || s.speedLimit || 0) | 0;
      const args = [
        '-f', this.d.format || 'bv*+ba/b',
        '--no-playlist',
        ...jsArgs(),
        ...proxyArgs,
        '--newline',
        '--no-colors',
        '--quiet',
        '--progress',
        '--progress-template', 'download:VDMP|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.filename)s',
        '--print', 'after_move:VDMF|%(filepath)s',
        '-o', `${this.outBase}.%(ext)s`,
        '--ffmpeg-location', tools.ffmpegPath,
        '--concurrent-fragments', String(Math.max(1, Math.min(16, s.connections || 8))),
        '--continue',
        '--no-mtime',
        '--retries', '10',
        '--fragment-retries', '10',
        ...(this.d.audioOnly ? ['-x', '--audio-format', 'mp3', '--audio-quality', '0'] : ['--merge-output-format', 'mp4']),
        ...(limit > 0 ? ['--limit-rate', `${limit}K`] : []),
        ...headerArgs(this.d),
        '--',
        this.d.url,
      ];
      const proc = spawn(tools.ytdlpPath, args, { windowsHide: true, detached: process.platform !== 'win32', env: childEnv() });
      this.proc = proc;
      this.phase = 0;
      this.phases = !this.d.audioOnly && /\+/.test(this.d.format || '') ? 2 : 1;
      this.lastFile = null;
      this.doneBytes = 0;
      this.curTotal = 0;
      let errText = '';
      let finalPath = null;
      let buf = '';
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line.startsWith('VDMP|')) this.onProgress(line);
          else if (line.startsWith('VDMF|')) finalPath = line.slice(5).trim();
        }
      });
      proc.stderr.on('data', (c) => (errText = (errText + c).slice(-4000)));
      proc.on('error', (e) => {
        errText += `\nERROR: ${e.message}`;
      });
      proc.on('close', async (code) => {
        if (this.abortReason) {
          this.setStatus(this.abortReason === 'queue' ? 'queued' : this.abortReason === 'remove' ? 'removed' : this.abortReason === 'cancel' ? 'canceled' : 'paused');
          return resolve();
        }
        if (code === 0) {
          const file = finalPath && fs.existsSync(finalPath) ? finalPath : this.d.savePath;
          try {
            const st = await fsp.stat(file);
            this.d.size = st.size;
          } catch {
            /* keep estimate */
          }
          this.d.savePath = file;
          this.d.filename = path.basename(file);
          this.d.downloaded = this.d.size;
          this.d.completedAt = Date.now();
          this.setStatus('completed');
          this.emit('completed', this);
        } else {
          this.d.error = t(cleanError(errText) || 'Video download failed');
          this.setStatus('error');
          this.emit('failed', this);
        }
        resolve();
      });
    });
  }

  onProgress(line) {
    const [, status, dl, total, est, speed, eta, ...fileParts] = line.split('|');
    const num = (v) => (v && v !== 'NA' && v !== 'None' ? Number(v) : NaN);
    const file = fileParts.join('|');
    const cur = num(dl) || 0;
    const tot = num(total) || num(est) || 0;
    if (this.lastFile && file && file !== this.lastFile) {
      // yt-dlp moved on to the next stream (e.g. audio after video)
      this.doneBytes += this.curTotal || 0;
      this.phase++;
    }
    if (file) this.lastFile = file;
    this.curTotal = tot || cur;
    this.d.downloaded = this.doneBytes + cur;
    const known = this.doneBytes + (tot || 0);
    if (this.phase + 1 >= this.phases) this.d.size = known > 0 ? known : this.d.size;
    else this.d.size = Math.max(this.d.sizeEstimate || 0, known);
    this.speed = num(speed) || 0;
    this.eta = num(eta) >= 0 ? num(eta) : -1;
    if (status === 'finished' && this.phase + 1 >= this.phases) {
      this.stage = t(this.d.audioOnly ? 'Converting to MP3…' : this.phases > 1 ? 'Merging video and audio…' : 'Finishing…');
      this.speed = 0;
    } else this.stage = '';
    if (this.d.status !== 'downloading') this.setStatus('downloading');
    this.emit('progress', this);
  }

  async stop(reason = 'pause') {
    if (!this.running) {
      if (reason === 'queue' && this.d.status !== 'completed') this.setStatus('queued');
      else if (reason === 'pause' && ['queued', 'error'].includes(this.d.status)) this.setStatus('paused');
      else if (reason === 'cancel' && this.d.status !== 'completed') this.setStatus('canceled');
      return;
    }
    this.abortReason = reason;
    killTree(this.proc);
    await this.runPromise;
  }

  /** Removes yt-dlp's partial files (and the result when asked). */
  async deleteFiles({ includeCompleted = false } = {}) {
    const base = path.basename(this.outBase);
    try {
      for (const f of await fsp.readdir(this.d.dir)) {
        if (!f.startsWith(base)) continue;
        const full = path.join(this.d.dir, f);
        const partial = /\.(part|ytdl|temp)$|\.part-Frag\d+|\.f\d+\.\w+$/.test(f);
        if (partial || (includeCompleted && this.d.status === 'completed' && full === this.d.savePath)) await fsp.rm(full, { force: true });
      }
    } catch {
      /* folder gone */
    }
  }
}

/** Picks a unique "<dir>/<title>.<ext>" for a new media download. */
function mediaTarget(dir, title, ext, taken) {
  const name = sanitize(`${title}`.slice(0, 150)) + '.' + ext;
  return uniquePath(dir, name, taken);
}

module.exports = { MediaDownload, probeMedia, buildOptions, isVideoPage, mediaTarget, FORMATS_MISSING };
