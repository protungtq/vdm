'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Download, probe } = require('./download');
const { Throttle } = require('./throttle');
const { CATEGORIES, categoryOf } = require('./categories');
const { sanitize, fromUrl, uniquePath } = require('./filename');
const { MediaDownload, mediaTarget } = require('../media/media');

const TICK_MS = 500;
const DAY_KEYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Owns every download, the queues ("Scheduled"; each with its own schedule), the scheduler and the
 * on-disk list. Emits:
 *   'added' (snapshot) · 'changed' (snapshot) · 'removed' (id)
 *   'progress' (snapshots of running items) · 'completed' (snapshot)
 *   'failed' (snapshot) · 'queue' ({ running, queues: { id: running } }) · 'queue-done' ({ id, failed })
 *   'activity' ({ active, speed, progress })
 */
class Manager extends EventEmitter {
  /**
   * secrets: { encrypt(text) -> string | null, decrypt(string) -> text | null } protects the browser
   * cookies saved with a download (OS key store). Without it, cookies are never written to disk.
   */
  constructor({ file, getSettings, tools = null, secrets = null }) {
    super();
    this.file = file;
    this.secrets = secrets;
    this.getSettings = getSettings;
    this.items = new Map();
    // per queue: { running, runCount, startedToday, stoppedToday }
    this.qrun = new Map();
    this.throttle = new Throttle(((getSettings().speedLimit || 0) * 1024) | 0);
    this.ctx = {
      throttle: this.throttle,
      settings: getSettings,
      takenPaths: (exceptId) => this.takenPaths(exceptId),
    };
    // video/stream downloads run through yt-dlp (see media/)
    this.mediaCtx = { tools, settings: getSettings };
    this.saveTimer = null;
    this.ticker = null;
    this.scheduler = null;
  }

  // ---------- persistence ----------
  load() {
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      list = [];
    }
    let plaintext = false;
    for (const data of Array.isArray(list) ? list : []) {
      if (!data || !data.id || !data.url) continue;
      if (data.cookiesEnc) {
        data.cookies = (this.secrets && safe(() => this.secrets.decrypt(data.cookiesEnc))) || '';
        delete data.cookiesEnc;
      } else if (data.cookies) plaintext = true; // saved by 0.1.0–0.1.2: re-save protected
      if (data.status === 'completed') data.cookies = '';
      if (['downloading', 'connecting'].includes(data.status)) data.status = data.queued ? 'queued' : 'paused';
      if (data.status === 'removed') continue;
      const dl = data.type === 'media' ? new MediaDownload(data, this.mediaCtx) : new Download(data, this.ctx);
      this.hook(dl);
      this.items.set(dl.id, dl);
    }
    if (plaintext) this.saveNow();
  }

  /** What goes into downloads.json: browser cookies only encrypted by the OS, never as plain text. */
  serialize(dl) {
    const j = dl.toJSON();
    const cookies = j.cookies;
    delete j.cookies;
    if (cookies && dl.d.status !== 'completed' && this.secrets) {
      const enc = safe(() => this.secrets.encrypt(cookies));
      if (enc) j.cookiesEnc = enc;
    }
    return j;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 800);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const data = JSON.stringify([...this.items.values()].map((d) => this.serialize(d)));
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('save failed', e);
    }
  }

  // ---------- lifecycle ----------
  startTimers() {
    let saveCounter = 0;
    this.ticker = setInterval(() => {
      const running = [...this.items.values()].filter((d) => d.running);
      for (const d of running) d.tick(TICK_MS);
      if (running.length) {
        this.emit('progress', running.map((d) => d.snapshot()));
        if (++saveCounter % 10 === 0) this.save(); // checkpoint segment positions every ~5 s
      }
      this.emitActivity(running);
    }, TICK_MS);
    this.scheduler = setInterval(() => this.checkSchedule(), 15000);
    this.checkSchedule();
  }

  async shutdown() {
    clearInterval(this.ticker);
    clearInterval(this.scheduler);
    await Promise.all([...this.items.values()].filter((d) => d.running).map((d) => d.stop(d.d.queued ? 'queue' : 'pause')));
    this.saveNow();
  }

  emitActivity(running) {
    let size = 0;
    let done = 0;
    let speed = 0;
    let unknown = false;
    for (const d of running) {
      speed += d.speed;
      if (d.d.size > 0) {
        size += d.d.size;
        done += Math.min(d.d.downloaded, d.d.size);
      } else unknown = true;
    }
    this.emit('activity', {
      active: running.length,
      speed: Math.round(speed),
      progress: running.length ? (size > 0 ? done / size : unknown ? -1 : 0) : null,
    });
  }

  hook(dl) {
    dl.on('change', () => {
      this.emit('changed', dl.snapshot());
      this.save();
    });
    dl.on('completed', () => {
      dl.d.cookies = ''; // not needed any more; don't keep a copy of the site's login
      this.emit('completed', dl.snapshot());
      this.save();
    });
    dl.on('failed', () => {
      this.emit('failed', dl.snapshot());
      this.save();
    });
    dl.on('stopped', () => {
      this.save();
      // Let the queue move on (and notice when it has drained).
      setImmediate(() => this.pump());
    });
  }

  // ---------- queries ----------
  get(id) {
    return this.items.get(id);
  }

  list() {
    return [...this.items.values()].map((d) => d.snapshot()).sort((a, b) => b.createdAt - a.createdAt);
  }

  takenPaths(exceptId) {
    const set = new Set();
    for (const d of this.items.values()) if (d.id !== exceptId && d.d.status !== 'completed') set.add(String(d.d.savePath).toLowerCase());
    return set;
  }

  folderFor(filename) {
    const s = this.getSettings();
    return s.categorize ? path.join(s.downloadDir, CATEGORIES[categoryOf(filename)].folder) : s.downloadDir;
  }

  async probe(url, { referrer, cookies, userAgent } = {}) {
    const headers = {};
    if (referrer) headers.Referer = referrer;
    if (cookies) headers.Cookie = cookies;
    if (userAgent) headers['User-Agent'] = userAgent;
    const info = await probe(url, { headers });
    return { ...info, dir: this.folderFor(info.filename) };
  }

  /**
   * opts: { url, filename?, dir?, size?, resumable?, referrer?, cookies?, userAgent?,
   *         mode: 'now' | 'queue' | 'paused', filenameLocked? }
   */
  add(opts) {
    if (opts.type === 'media') return this.addMedia(opts);
    const s = this.getSettings();
    const filename = sanitize(opts.filename || fromUrl(opts.url) || 'download');
    const dir = opts.dir || this.folderFor(filename);
    const savePath = uniquePath(dir, filename, this.takenPaths());
    const queued = opts.mode === 'queue';
    const queueId = queued ? this.queueIdOr(opts.queueId) : null;
    const maxOrder = Math.max(0, ...[...this.items.values()].map((d) => d.d.queueOrder || 0));
    const dl = new Download(
      {
        id: crypto.randomUUID(),
        url: opts.url,
        referrer: opts.referrer || '',
        cookies: opts.cookies || '',
        userAgent: opts.userAgent || '',
        filename: path.basename(savePath),
        filenameLocked: !!opts.filenameLocked,
        dir,
        savePath,
        size: opts.size ?? -1,
        resumable: !!opts.resumable,
        status: queued ? 'queued' : 'paused',
        connections: s.connections,
        category: categoryOf(filename),
        createdAt: Date.now(),
        queued,
        queueId,
        queueOrder: queued ? maxOrder + 1 : 0,
        addedFrom: opts.source || 'manual',
      },
      this.ctx
    );
    this.hook(dl);
    this.items.set(dl.id, dl);
    this.emit('added', dl.snapshot());
    this.save();
    if (opts.mode === 'now') dl.start();
    else if (queued) this.pump();
    return dl;
  }

  /**
   * opts: { type: 'media', url, title, format, audioOnly, ext, quality, size, dir?,
   *         referrer?, cookies?, userAgent?, mode }
   */
  addMedia(opts) {
    const s = this.getSettings();
    const ext = opts.audioOnly ? 'mp3' : opts.ext || 'mp4';
    const category = opts.audioOnly ? 'audio' : 'video';
    const dir = opts.dir || (s.categorize ? path.join(s.downloadDir, CATEGORIES[category].folder) : s.downloadDir);
    const savePath = mediaTarget(dir, opts.title || 'video', ext, this.takenPaths());
    const queued = opts.mode === 'queue';
    const queueId = queued ? this.queueIdOr(opts.queueId) : null;
    const maxOrder = Math.max(0, ...[...this.items.values()].map((d) => d.d.queueOrder || 0));
    const dl = new MediaDownload(
      {
        id: crypto.randomUUID(),
        type: 'media',
        url: opts.url,
        referrer: opts.referrer || '',
        cookies: opts.cookies || '',
        userAgent: opts.userAgent || '',
        title: opts.title || '',
        format: opts.format,
        audioOnly: !!opts.audioOnly,
        quality: opts.quality || '',
        filename: path.basename(savePath),
        dir,
        savePath,
        size: opts.size > 0 ? opts.size : -1,
        sizeEstimate: opts.size > 0 ? opts.size : 0,
        status: queued ? 'queued' : 'paused',
        connections: s.connections,
        category,
        createdAt: Date.now(),
        queued,
        queueId,
        queueOrder: queued ? maxOrder + 1 : 0,
        addedFrom: opts.source || 'manual',
      },
      this.mediaCtx
    );
    this.hook(dl);
    this.items.set(dl.id, dl);
    this.emit('added', dl.snapshot());
    this.save();
    if (opts.mode === 'now') dl.start();
    else if (queued) this.pump();
    return dl;
  }

  // ---------- actions ----------
  start(id) {
    const d = this.items.get(id);
    if (!d || d.d.status === 'completed') return;
    if (d.d.status === 'error') {
      // a manual retry gets a fresh set of attempts
      for (const s of d.d.segments) s.fails = 0;
    }
    d.start();
  }

  async pause(id) {
    const d = this.items.get(id);
    if (d) await d.stop('pause');
  }

  /**
   * Stops a download but keeps it in the list as "Canceled" (with the bytes
   * already downloaded, so Resume continues). It also leaves the queue.
   */
  async cancel(id) {
    const d = this.items.get(id);
    if (!d || d.d.status === 'completed') return;
    if (d.d.queued) d.update({ queued: false, queueId: null, queueOrder: 0 });
    await d.stop('cancel');
  }

  async remove(id, { deleteFile = false } = {}) {
    const d = this.items.get(id);
    if (!d) return;
    await d.stop('remove');
    if (d.d.status !== 'completed' || deleteFile) await d.deleteFiles({ includeCompleted: deleteFile });
    this.items.delete(id);
    this.emit('removed', id);
    this.save();
  }

  async redownload(id) {
    const d = this.items.get(id);
    if (!d) return;
    await d.stop('pause');
    await d.deleteFiles();
    d.d.segments = [];
    d.d.downloaded = 0;
    d.d.completedAt = null;
    d.d.error = null;
    d.d.status = 'paused';
    if (fs.existsSync(d.d.savePath)) {
      d.d.savePath = uniquePath(d.d.dir, d.d.filename, this.takenPaths(id));
      d.d.filename = path.basename(d.d.savePath);
    }
    d.emit('change', d);
    d.start();
  }

  /** Swap an expired link for a fresh one and keep the downloaded bytes. */
  async refreshUrl(id, url) {
    const d = this.items.get(id);
    if (!d) return;
    const resume = d.running || d.d.status === 'error';
    await d.stop('pause');
    d.update({ url, error: null });
    if (resume) d.start();
  }

  update(id, patch) {
    const d = this.items.get(id);
    if (!d) return;
    const allowed = {};
    for (const k of ['connections', 'speedLimit']) if (k in patch) allowed[k] = patch[k];
    d.update(allowed);
  }

  async pauseAll() {
    await Promise.all([...this.items.values()].filter((d) => d.running || d.d.status === 'queued').map((d) => d.stop('pause')));
    for (const st of this.qrun.values()) st.running = false;
    this.emitQueue();
  }

  resumeAll() {
    for (const d of this.items.values()) if (['paused', 'error'].includes(d.d.status) && !d.d.queued) this.start(d.id);
    for (const q of this.queues()) if (this.queueItems(q.id).length) this.startQueue(q.id);
  }

  // ---------- queues ----------
  /** Queue definitions from the settings ({ id, name, maxConcurrent, schedule }); "main" always exists. */
  queues() {
    const s = this.getSettings();
    const list = Array.isArray(s.queues) && s.queues.length ? s.queues : [];
    if (list.some((q) => q.id === 'main')) return list;
    return [{ id: 'main', name: 'Main queue', maxConcurrent: s.maxConcurrent || 1, schedule: s.schedule || {} }, ...list];
  }

  queueIdOr(id) {
    return this.queues().some((q) => q.id === id) ? id : 'main';
  }

  qstate(id) {
    if (!this.qrun.has(id)) this.qrun.set(id, { running: false, runCount: 0, startedToday: null, stoppedToday: null });
    return this.qrun.get(id);
  }

  /** True while any queue is running (tray, "Stop all"). */
  get queueRunning() {
    return [...this.qrun.values()].some((q) => q.running);
  }

  queueState() {
    const queues = {};
    for (const q of this.queues()) queues[q.id] = this.qstate(q.id).running;
    return { running: this.queueRunning, queues };
  }

  emitQueue() {
    this.emit('queue', this.queueState());
  }

  /** Puts a download into a queue (queueId) or takes it out (queued = false). */
  setQueued(id, queued, queueId = 'main') {
    const d = this.items.get(id);
    if (!d) return;
    const maxOrder = Math.max(0, ...[...this.items.values()].map((x) => x.d.queueOrder || 0));
    const qid = queued ? this.queueIdOr(queueId) : null;
    const same = queued && d.d.queued && (d.d.queueId || 'main') === qid;
    d.update({ queued: !!queued, queueId: qid, queueOrder: queued ? (same ? d.d.queueOrder : maxOrder + 1) : 0 });
    if (queued && !d.running && d.d.status !== 'completed') d.setStatus('queued');
    if (!queued && d.d.status === 'queued') d.setStatus('paused');
    // a running download moved to a stopped queue keeps going; the queues just re-balance
    this.pump();
  }

  moveInQueue(id, dir) {
    const item = this.items.get(id);
    if (!item) return;
    const q = this.queueItems(item.d.queueId || 'main');
    const i = q.findIndex((d) => d.id === id);
    const j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= q.length) return;
    const a = q[i].d.queueOrder;
    q[i].update({ queueOrder: q[j].d.queueOrder });
    q[j].update({ queueOrder: a });
  }

  /** Waiting / running items of one queue (all queues when id is omitted), in queue order. */
  queueItems(id) {
    return [...this.items.values()]
      .filter((d) => d.d.queued && d.d.status !== 'completed' && (id === undefined || (d.d.queueId || 'main') === id))
      .sort((a, b) => a.d.queueOrder - b.d.queueOrder);
  }

  startQueue(id = 'main') {
    const st = this.qstate(id);
    st.running = true;
    st.runCount = 0;
    for (const d of this.queueItems(id)) if (['paused', 'error'].includes(d.d.status) && !d.running) d.setStatus('queued');
    this.emitQueue();
    this.pump();
  }

  async stopQueue(id = 'main') {
    this.qstate(id).running = false;
    this.emitQueue();
    await Promise.all(this.queueItems(id).filter((d) => d.running).map((d) => d.stop('queue')));
  }

  /** Removes a queue; its downloads move to the main queue. */
  async deleteQueue(id) {
    if (id === 'main') return;
    const wasRunning = this.qstate(id).running;
    this.qrun.delete(id);
    for (const d of this.queueItems(id)) d.update({ queueId: 'main' });
    if (wasRunning) this.startQueue('main');
    else this.emitQueue();
  }

  /** Starts waiting items of every running queue, up to that queue's "at a time". */
  pump() {
    for (const q of this.queues()) this.pumpQueue(q);
  }

  pumpQueue(q) {
    const st = this.qstate(q.id);
    if (!st.running) return;
    const max = Math.max(1, q.maxConcurrent || 1);
    const items = this.queueItems(q.id);
    let running = items.filter((d) => d.running).length;
    for (const d of items) {
      if (running >= max) break;
      if (!d.running && d.d.status === 'queued') {
        d.start();
        st.runCount++;
        running++;
      }
    }
    const rest = this.queueItems(q.id);
    if (rest.some((d) => d.running || d.d.status === 'queued')) return;
    st.running = false;
    this.emitQueue();
    // Only a queue that actually ran and wasn't interrupted by the user counts
    // as "finished" (this is what triggers shutdown/sleep after downloads).
    const userPaused = rest.some((d) => d.d.status === 'paused');
    if (st.runCount > 0 && !userPaused) this.emit('queue-done', { id: q.id, failed: rest.filter((d) => d.d.status === 'error').length });
  }

  setSpeedLimit(kbps) {
    this.throttle.setRate((Number(kbps) || 0) * 1024);
  }

  // ---------- scheduler ----------
  checkSchedule(now = new Date()) {
    const today = now.toDateString();
    const hm = now.getHours() * 60 + now.getMinutes();
    const toMin = (t) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    for (const q of this.queues()) {
      const sch = q.schedule || {};
      if (!sch.enabled && !sch.stopEnabled) continue;
      const st = this.qstate(q.id);
      const days = Array.isArray(sch.days) ? sch.days : DAY_KEYS;
      const start = sch.enabled ? toMin(sch.startTime) : null;
      const stop = sch.stopEnabled ? toMin(sch.stopTime) : null;
      if (start !== null && days.includes(now.getDay()) && hm >= start && hm < start + 2 && st.startedToday !== today) {
        st.startedToday = today;
        if (!st.running && this.queueItems(q.id).length) this.startQueue(q.id);
      }
      if (stop !== null && hm >= stop && hm < stop + 2 && st.stoppedToday !== today) {
        st.stoppedToday = today;
        if (st.running) this.stopQueue(q.id);
      }
    }
  }
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

module.exports = { Manager };
