'use strict';

const { t, digits: D } = require('../../shared/i18n');

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { request, HttpError, parseContentRange } = require('./http');
const { deriveFilename, uniquePath } = require('./filename');
const { categoryOf } = require('./categories');
const { Throttle } = require('./throttle');

const MIN_SEGMENT = 1024 * 1024; // initial segments are at least 1 MiB
const MIN_SPLIT = 256 * 1024; // dynamic splits leave at least 256 KiB per half
const FLUSH_BYTES = 512 * 1024; // coalesce network chunks into 512 KiB writes
const PART_EXT = '.dmpart';

const segDone = (s) => s.done || (s.end >= 0 && s.pos > s.end);

/**
 * Asks the server about a URL without downloading it: final name, size and
 * whether byte ranges (resume + multiple connections) are supported.
 */
async function probe(url, { headers = {}, timeout = 20000, signal } = {}) {
  const { req, res, url: finalUrl } = await request(url, { headers: { ...headers, Range: 'bytes=0-' }, timeout, signal });
  try {
    const sc = res.statusCode;
    if (sc >= 400) throw new HttpError(sc);
    let size = -1;
    let resumable = false;
    if (sc === 206) {
      const cr = parseContentRange(res.headers['content-range']);
      size = cr ? cr.total : -1;
      resumable = size > 0;
    } else {
      const cl = res.headers['content-length'];
      size = cl !== undefined && /^\d+$/.test(cl) ? Number(cl) : -1;
      resumable = size > 0 && /bytes/i.test(res.headers['accept-ranges'] || '');
    }
    const contentType = String(res.headers['content-type'] || '').split(';')[0].trim();
    const filename = deriveFilename({
      contentDisposition: res.headers['content-disposition'],
      finalUrl,
      url,
      contentType,
    });
    return {
      size,
      resumable,
      filename,
      contentType,
      finalUrl,
      category: categoryOf(filename),
      isWebPage: /^text\/html/i.test(contentType) && !res.headers['content-disposition'],
    };
  } finally {
    res.destroy();
    req.destroy();
  }
}

function friendlyError(err) {
  if (!err) return t('Unknown error');
  if (err instanceof HttpError) {
    switch (err.status) {
      case 401: return t('Authorization required (401)');
      case 403: return t('Access denied (403) — the link may have expired. Use “Refresh link”.');
      case 404: return t('File not found on server (404)');
      case 410: return t('Link expired (410) — use “Refresh link”.');
      case 416: return err.message.includes('resum') ? err.message : t('Server rejected the byte range (416)');
      case 429: return t('Server is rate-limiting (429)');
      default: return t('Server error ({n})', { n: D(err.status) });
    }
  }
  const code = err.code || (/\b(E[A-Z]{3,})\b/.exec(err.message || '') || [])[1] || '';
  if (code === 'ENOSPC') return t('Not enough disk space');
  if (code === 'EACCES' || code === 'EPERM') return t('No permission to write to the folder');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return t('Server not found — check the address or your connection');
  if (code === 'ECONNREFUSED') return t('Connection refused by server');
  if (code === 'ECONNRESET') return t('Connection was reset');
  if (code === 'ETIMEDOUT' || /timed out/i.test(err.message || '')) return t('Connection timed out');
  if (/\b407\b/.test(err.message || '') && /proxy/i.test(err.message || '')) return t('The proxy rejected the username or password.');
  return t(err.message || String(err));
}

class Download extends EventEmitter {
  /**
   * @param data persisted record
   * @param ctx  { throttle: Throttle, settings(): object, takenPaths(id) }
   */
  constructor(data, ctx) {
    super();
    this.ctx = ctx;
    this.d = {
      size: -1,
      resumable: false,
      status: 'paused',
      downloaded: 0,
      segments: [],
      connections: 8,
      queued: false,
      error: null,
      speedLimit: 0,
      ...data,
    };
    this.running = false;
    this.aborted = false;
    this.reqs = new Set();
    this.sleepers = new Set();
    this.conns = new Map();
    this.connSeq = 0;
    this.workers = 0;
    this.maxConn = 1;
    this.speed = 0;
    this.eta = -1;
    this.windowBytes = 0;
    this.localThrottle = new Throttle((this.d.speedLimit || 0) * 1024);
    this.fd = null;
    this.recomputeDownloaded();
  }

  get id() {
    return this.d.id;
  }
  /** Workers stop when the user pauses or when we fall back to one connection. */
  get halted() {
    return this.aborted || this.restarting;
  }
  get status() {
    return this.d.status;
  }
  get tempPath() {
    return this.d.savePath + PART_EXT;
  }

  snapshot() {
    const d = this.d;
    return {
      id: d.id,
      url: d.url,
      filename: d.filename,
      savePath: d.savePath,
      dir: d.dir,
      size: d.size,
      downloaded: Math.min(d.downloaded, d.size > 0 ? d.size : Infinity),
      status: d.status,
      speed: this.running ? Math.round(this.speed) : 0,
      eta: this.running ? this.eta : -1,
      category: d.category,
      resumable: d.resumable,
      error: d.error,
      queued: d.queued,
      queueOrder: d.queueOrder || 0,
      queueId: d.queued ? d.queueId || 'main' : null,
      createdAt: d.createdAt,
      completedAt: d.completedAt || null,
      startedAt: d.startedAt || null,
      // downloads from older versions never recorded it: the best guess is when they last ran
      lastTryAt: d.lastTryAt || d.completedAt || d.startedAt || null,
      activeConnections: this.workers,
      connections: d.connections,
      speedLimit: d.speedLimit || 0,
    };
  }

  /** Extra data for the per-download window: segment map + connection list. */
  detail() {
    return {
      ...this.snapshot(),
      referrer: this.d.referrer || '',
      segments: this.d.segments.map((s) => ({ start: s.start, end: s.end, pos: s.recv ?? s.pos, active: !!s.active })),
      conns: [...this.conns.values()].map((c) => ({ id: c.id, downloaded: c.downloaded, status: c.status, start: c.seg.start })),
    };
  }

  toJSON() {
    const d = { ...this.d };
    d.segments = this.d.segments.map((s) => ({ start: s.start, end: s.end, pos: s.pos, ...(s.done ? { done: true } : {}) }));
    // merge finished neighbours to keep the file small
    const merged = [];
    for (const s of d.segments) {
      const prev = merged[merged.length - 1];
      if (prev && segDone(prev) && segDone(s) && prev.end + 1 === s.start) {
        prev.end = s.end;
        prev.pos = s.end + 1;
      } else merged.push({ ...s });
    }
    d.segments = merged;
    return d;
  }

  flushedBytes() {
    return this.d.segments.reduce((n, s) => n + Math.max(0, s.pos - s.start), 0);
  }

  recomputeDownloaded() {
    if (this.d.status === 'completed') this.d.downloaded = this.d.size > 0 ? this.d.size : this.d.downloaded;
    else this.d.downloaded = this.flushedBytes();
  }

  setStatus(status) {
    if (this.d.status === status) return;
    this.d.status = status;
    this.emit('change', this);
  }

  update(patch) {
    Object.assign(this.d, patch);
    if ('speedLimit' in patch) this.localThrottle.setRate((patch.speedLimit || 0) * 1024);
    if ('connections' in patch && this.running && this.d.resumable && this.d.size > 0) {
      this.maxConn = Math.max(1, patch.connections);
      this.schedule();
    }
    this.emit('change', this);
  }

  headers() {
    const h = {};
    if (this.d.referrer) h.Referer = this.d.referrer;
    if (this.d.cookies) h.Cookie = this.d.cookies;
    if (this.d.userAgent) h['User-Agent'] = this.d.userAgent;
    return h;
  }

  start() {
    if (this.running) return this.runPromise;
    if (this.d.status === 'completed') return Promise.resolve();
    this.running = true;
    this.aborted = false;
    this.abortReason = null;
    this.lastError = null;
    this.d.error = null;
    this.speed = 0;
    this.eta = -1;
    this.abortCtl = new AbortController();
    this.d.startedAt = this.d.startedAt || Date.now();
    this.d.lastTryAt = Date.now(); // every attempt (start, resume, retry) counts as a try
    this.setStatus('connecting');
    this.runPromise = this.run().finally(() => {
      this.running = false;
      this.speed = 0;
      this.emit('change', this);
      this.emit('stopped', this);
    });
    return this.runPromise;
  }

  /** reason: 'pause' | 'queue' (back to waiting) | 'cancel' (stays in the list as Canceled) | 'remove' */
  async stop(reason = 'pause') {
    if (!this.running) {
      if (reason === 'queue' && this.d.status !== 'completed') this.setStatus('queued');
      else if (reason === 'pause' && ['queued', 'error'].includes(this.d.status)) this.setStatus('paused');
      else if (reason === 'cancel' && this.d.status !== 'completed') this.setStatus('canceled');
      return;
    }
    this.aborted = true;
    this.abortReason = reason;
    this.abortCtl.abort();
    for (const r of this.reqs) r.destroy(new Error('Aborted'));
    for (const wake of this.sleepers) wake();
    await this.runPromise;
  }

  async run() {
    try {
      await this.prepare();
      if (this.aborted) return this.afterAbort();
      this.setStatus('downloading');
      await this.runWorkers();
      if (!this.aborted && this.fallbackSingle) {
        // The server advertised byte ranges but ignores them: start over with
        // a single plain connection instead of failing.
        this.fallbackSingle = false;
        this.restarting = false;
        this.d.resumable = false;
        this.d.segments = [{ start: 0, end: this.d.size > 0 ? this.d.size - 1 : -1, pos: 0, recv: 0 }];
        this.d.downloaded = 0;
        await this.fd.truncate(0);
        this.emit('change', this);
        await this.runWorkers();
      }
      if (this.aborted) return this.afterAbort();
      if (this.d.segments.length && this.d.segments.every(segDone)) await this.finalize();
      else this.fail(this.lastError || new Error('Download did not finish'));
    } catch (err) {
      if (this.aborted) return this.afterAbort();
      this.fail(err);
    } finally {
      await this.closeFile();
    }
  }

  afterAbort() {
    this.recomputeDownloaded();
    const next = { queue: 'queued', remove: 'removed', cancel: 'canceled' };
    this.setStatus(next[this.abortReason] || 'paused');
  }

  fail(err) {
    this.recomputeDownloaded();
    this.d.error = friendlyError(err);
    this.setStatus('error');
    this.emit('failed', this, err);
  }

  async prepare() {
    const info = await probe(this.d.url, { headers: this.headers(), signal: this.abortCtl.signal });
    if (this.aborted) return;
    const hadProgress = this.flushedBytes() > 0;
    const sizeChanged = this.d.size > 0 && info.size !== this.d.size;
    if (hadProgress && (!info.resumable || sizeChanged)) {
      // Can't continue where we left off — start over cleanly.
      this.d.segments = [];
      await fsp.rm(this.tempPath, { force: true });
    }
    if (!this.d.filenameLocked && this.flushedBytes() === 0 && info.filename && info.filename !== this.d.filename) {
      const target = uniquePath(this.d.dir, info.filename, this.ctx.takenPaths ? this.ctx.takenPaths(this.d.id) : undefined);
      this.d.savePath = target;
      this.d.filename = path.basename(target);
      this.d.category = categoryOf(this.d.filename);
    }
    this.d.size = info.size;
    this.d.resumable = info.resumable;
    this.d.contentType = info.contentType;

    await fsp.mkdir(this.d.dir, { recursive: true });
    if (this.d.size > 0 && fsp.statfs) {
      try {
        const st = await fsp.statfs(this.d.dir);
        const free = st.bavail * st.bsize;
        const need = this.d.size - this.flushedBytes();
        if (need > free) {
          const e = new Error('Not enough disk space');
          e.code = 'ENOSPC';
          throw e;
        }
      } catch (e) {
        if (e.code === 'ENOSPC') throw e;
      }
    }
    const exists = fs.existsSync(this.tempPath);
    if (!exists && this.flushedBytes() > 0) this.d.segments = []; // partial file was deleted
    const fresh = !this.d.segments.length;
    this.fd = await fsp.open(this.tempPath, exists && !fresh ? 'r+' : 'w+');
    if (fresh) {
      this.initSegments();
      if (this.d.size > 0) await this.fd.truncate(this.d.size);
    }
    for (const s of this.d.segments) s.recv = s.pos;
    this.recomputeDownloaded();
  }

  initSegments() {
    const size = this.d.size;
    if (!this.d.resumable || size <= 0) {
      this.d.segments = [{ start: 0, end: size > 0 ? size - 1 : -1, pos: 0 }];
      return;
    }
    const n = Math.max(1, Math.min(this.d.connections, Math.floor(size / MIN_SEGMENT) || 1));
    const part = Math.floor(size / n);
    this.d.segments = [];
    for (let i = 0; i < n; i++) {
      const start = i * part;
      this.d.segments.push({ start, end: i === n - 1 ? size - 1 : start + part - 1, pos: start });
    }
  }

  runWorkers() {
    return new Promise((resolve) => {
      this.resolveWorkers = resolve;
      this.maxConn = this.d.resumable && this.d.size > 0 ? Math.max(1, this.d.connections) : 1;
      this.schedule();
    });
  }

  /** Assigns idle segments to free connection slots, splitting big segments when idle slots remain. */
  schedule() {
    if (!this.resolveWorkers) return;
    if (!this.halted) {
      for (const seg of this.d.segments) {
        if (this.workers >= this.maxConn) break;
        if (!seg.active && !segDone(seg) && (seg.fails || 0) < 3) this.spawn(seg);
      }
      // Dynamic segmentation (IDM-style): a finished connection takes over
      // the second half of the largest remaining segment.
      while (this.workers < this.maxConn && this.d.resumable && this.d.size > 0) {
        let best = null;
        for (const s of this.d.segments) {
          if (!s.active || segDone(s)) continue;
          const remaining = s.end - s.recv + 1;
          if (remaining >= 2 * MIN_SPLIT && (!best || remaining > best.end - best.recv + 1)) best = s;
        }
        if (!best) break;
        const remaining = best.end - best.recv + 1;
        const mid = best.recv + Math.ceil(remaining / 2);
        const ns = { start: mid, end: best.end, pos: mid, recv: mid };
        best.end = mid - 1;
        this.d.segments.splice(this.d.segments.indexOf(best) + 1, 0, ns);
        this.spawn(ns);
      }
    }
    if (this.workers === 0) {
      const done = this.resolveWorkers;
      this.resolveWorkers = null;
      done();
    }
  }

  spawn(seg) {
    seg.active = true;
    this.workers++;
    const conn = { id: ++this.connSeq, seg, downloaded: 0, status: t('Connecting…') };
    this.conns.set(conn.id, conn);
    this.worker(seg, conn)
      .catch((err) => {
        this.lastError = err;
      })
      .finally(() => {
        seg.active = false;
        this.workers--;
        this.conns.delete(conn.id);
        this.schedule();
      });
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(t);
        this.sleepers.delete(wake);
        resolve();
      };
      const t = setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  }

  async worker(seg, conn) {
    const maxRetries = this.ctx.settings().maxRetries ?? 10;
    let attempt = 0;
    while (!this.halted && !segDone(seg)) {
      let req = null;
      let res = null;
      const pending = [];
      let pendingLen = 0;
      let pendingOffset = seg.recv;
      const flush = async () => {
        if (!pendingLen) return;
        const buf = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLen);
        const off = pendingOffset;
        pending.length = 0;
        pendingLen = 0;
        pendingOffset = off + buf.length;
        await this.fd.write(buf, 0, buf.length, off);
        seg.pos = off + buf.length;
      };
      try {
        conn.status = attempt ? t('Reconnecting ({n})…', { n: D(attempt) }) : t('Connecting…');
        const headers = this.headers();
        const ranged = this.d.resumable && this.d.size > 0;
        if (ranged) headers.Range = `bytes=${seg.recv}-${seg.end}`;
        else if (seg.recv > 0) {
          // No range support: the only way to recover is to start over.
          seg.recv = seg.pos = 0;
          this.d.downloaded = 0;
        }
        pendingOffset = seg.recv;
        const r = await request(this.d.url, { headers, timeout: 30000, signal: this.abortCtl.signal });
        req = r.req;
        res = r.res;
        this.reqs.add(req);
        if (this.halted) break;
        if (ranged) {
          if (res.statusCode === 206) {
            const cr = parseContentRange(res.headers['content-range']);
            if (cr && cr.start !== seg.recv) throw new Error('Server sent the wrong byte range');
          } else if (!(res.statusCode === 200 && seg.recv === 0 && this.d.segments.length === 1)) {
            if (res.statusCode === 200) {
              // Range ignored: stop every connection and fall back to one.
              this.fallbackSingle = true;
              this.restarting = true;
              for (const r of this.reqs) if (r !== req) r.destroy(new Error('Restarting'));
              for (const wake of this.sleepers) wake();
              return;
            }
            throw new HttpError(res.statusCode);
          }
        } else if (res.statusCode !== 200 && res.statusCode !== 206) {
          throw new HttpError(res.statusCode);
        }
        conn.status = t('Receiving data…');
        attempt = 0;
        for await (let chunk of res) {
          if (this.halted) break;
          const end = seg.end >= 0 ? seg.end : Infinity;
          const room = end - seg.recv + 1;
          if (room <= 0) break;
          if (chunk.length > room) chunk = chunk.subarray(0, room);
          const w1 = this.ctx.throttle.take(chunk.length);
          if (w1) await w1;
          const w2 = this.localThrottle.take(chunk.length);
          if (w2) await w2;
          pending.push(chunk);
          pendingLen += chunk.length;
          seg.recv += chunk.length;
          conn.downloaded += chunk.length;
          this.d.downloaded += chunk.length;
          this.windowBytes += chunk.length;
          if (pendingLen >= FLUSH_BYTES) await flush();
          if (seg.recv > end) break;
        }
        await flush();
        if (this.halted) break;
        if (seg.end < 0) {
          // Unknown length: end of stream is end of file.
          if (!res.complete) throw new Error('Connection closed before the file finished');
          seg.end = seg.recv - 1;
          seg.done = true;
          this.d.size = seg.recv;
          break;
        }
        if (!segDone(seg)) throw new Error('Connection closed early');
      } catch (err) {
        try {
          await flush();
        } catch (e) {
          if (!this.halted) throw e;
        }
        if (this.halted) break;
        if (err.code === 'ENOSPC' || err.code === 'EACCES' || err.code === 'EPERM') throw err;
        this.lastError = err;
        attempt++;
        const fatal = err instanceof HttpError && err.fatal;
        if (fatal || attempt > maxRetries) {
          seg.fails = (seg.fails || 0) + 1;
          // Servers that cap connections answer extra ones with errors:
          // keep the healthy connections going and use one fewer.
          if (this.workers > 1) this.maxConn = Math.max(1, this.workers - 1);
          conn.status = `Error: ${err.message}`;
          return;
        }
        const wait = Math.min(1000 * 2 ** (attempt - 1), 15000);
        conn.status = t('Retrying in {n}s…', { n: D(Math.round(wait / 1000)) });
        await this.sleep(wait);
      } finally {
        if (req) {
          this.reqs.delete(req);
          if (!res || !res.complete) req.destroy();
        }
      }
    }
  }

  async closeFile() {
    if (!this.fd) return;
    const fd = this.fd;
    this.fd = null;
    try {
      await fd.close();
    } catch {
      /* already closed */
    }
  }

  async finalize() {
    await this.closeFile();
    let target = this.d.savePath;
    if (fs.existsSync(target)) target = uniquePath(this.d.dir, path.basename(target));
    // Antivirus scanners can briefly lock fresh files on Windows: retry a few times.
    for (let i = 0; ; i++) {
      try {
        await fsp.rename(this.tempPath, target);
        break;
      } catch (e) {
        if (i >= 9) throw e;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    this.d.savePath = target;
    this.d.filename = path.basename(target);
    if (this.d.size < 0) this.d.size = this.d.downloaded;
    this.d.downloaded = this.d.size;
    this.d.segments = [];
    this.d.completedAt = Date.now();
    this.d.error = null;
    this.setStatus('completed');
    this.emit('completed', this);
  }

  /** Called by the manager every `dt` ms to update speed / time left. */
  tick(dt) {
    const inst = (this.windowBytes * 1000) / dt;
    this.windowBytes = 0;
    this.speed = this.speed ? this.speed * 0.75 + inst * 0.25 : inst;
    if (this.speed < 1) this.speed = 0;
    const left = this.d.size > 0 ? this.d.size - this.d.downloaded : -1;
    this.eta = left >= 0 && this.speed > 0 ? left / this.speed : -1;
  }

  async deleteFiles({ includeCompleted = false } = {}) {
    await fsp.rm(this.tempPath, { force: true }).catch(() => {});
    if (includeCompleted && this.d.status === 'completed') await fsp.rm(this.d.savePath, { force: true }).catch(() => {});
  }
}

module.exports = { Download, probe, friendlyError, PART_EXT, MIN_SEGMENT };
