'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Manager } = require('../src/main/engine/manager');
const { probe } = require('../src/main/engine/download');
const { parseContentDisposition, sanitize } = require('../src/main/engine/filename');
const { looksDownloadable, categoryOf } = require('../src/main/engine/categories');
const { makeData, sha, startServer } = require('./helpers');

const SIZE = 6 * 1024 * 1024 + 12345;
const DATA = makeData(SIZE);
const DATA_SHA = sha(DATA);

let srv;
let tmp;
test.before(async () => {
  srv = await startServer(DATA);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-test-'));
});
test.after(() => {
  srv.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeManager(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'm-'));
  const settings = {
    downloadDir: dir,
    categorize: false,
    connections: 8,
    maxConcurrent: 3,
    maxRetries: 4,
    speedLimit: 0,
    ...overrides,
  };
  const m = new Manager({ file: path.join(dir, 'downloads.json'), getSettings: () => settings });
  m.startTimers();
  return { m, dir, settings };
}

const waitFor = (dl, statuses = ['completed', 'error']) =>
  new Promise((resolve) => {
    const check = () => statuses.includes(dl.d.status) && !dl.running;
    if (check()) return resolve(dl);
    const on = () => {
      if (check()) {
        dl.off('stopped', on);
        resolve(dl);
      }
    };
    dl.on('stopped', on);
  });

const fileSha = (p) => sha(fs.readFileSync(p));

test('unit: filename parsing and categories', () => {
  assert.strictEqual(parseContentDisposition("attachment; filename*=UTF-8''%E2%82%AC%20rates.pdf"), '€ rates.pdf');
  assert.strictEqual(parseContentDisposition('attachment; filename="a \\"b\\".zip"'), 'a "b".zip');
  assert.strictEqual(sanitize('con.txt'), '_con.txt');
  assert.strictEqual(sanitize('a<b>:c?.mkv  . '), 'a_b__c_.mkv');
  assert.ok(looksDownloadable('https://x.com/Silo.S01E07.720p.mkv?token=1'));
  assert.ok(!looksDownloadable('https://x.com/page.html'));
  assert.strictEqual(categoryOf('a.MP3'), 'audio');
  assert.strictEqual(categoryOf('setup.exe'), 'exe');
});

test('probe reports size, resume support and name', async () => {
  const info = await probe(`${srv.base}/file/movie.mkv`);
  assert.strictEqual(info.size, SIZE);
  assert.strictEqual(info.resumable, true);
  assert.strictEqual(info.filename, 'movie.mkv');
  assert.strictEqual(info.category, 'video');
  const cd = await probe(`${srv.base}/cd`);
  assert.strictEqual(cd.filename, 'فیلم new.mkv');
  const red = await probe(`${srv.base}/redirect`);
  assert.strictEqual(red.filename, 'redirected.bin');
});

test('multi-connection download is byte-exact and uses several connections', async () => {
  const { m } = makeManager({ connections: 6 });
  const before = srv.stats.ranges.length;
  const dl = m.add({ url: `${srv.base}/file/multi.bin`, mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  assert.ok(srv.stats.ranges.length - before >= 6, 'expected >= 6 ranged requests');
  assert.ok(!fs.existsSync(dl.d.savePath + '.dmpart'));
  await m.shutdown();
});

test('pause and resume keeps already downloaded bytes', async () => {
  const slow = await startServer(DATA, { bytesPerSec: 512 * 1024 });
  const { m } = makeManager({ connections: 4 });
  const dl = m.add({ url: `${slow.base}/file/pause.bin`, mode: 'now' });
  await new Promise((r) => setTimeout(r, 1500));
  await m.pause(dl.id);
  assert.strictEqual(dl.d.status, 'paused');
  const kept = dl.flushedBytes();
  assert.ok(kept > 0, 'should have bytes on disk');
  assert.ok(fs.existsSync(dl.tempPath));
  // Simulate an app restart: save, then load into a new manager.
  m.saveNow();
  await m.shutdown();
  const m2 = new (require('../src/main/engine/manager').Manager)({ file: m.file, getSettings: m.getSettings });
  m2.load();
  m2.startTimers();
  const again = m2.get(dl.id);
  assert.strictEqual(again.d.downloaded, kept);
  const reqsBefore = slow.stats.ranges.length;
  slow.server.close();
  const fast = await startServer(DATA);
  again.d.url = `${fast.base}/file/pause.bin`;
  m2.start(again.id);
  await waitFor(again);
  assert.strictEqual(again.d.status, 'completed', again.d.error);
  assert.strictEqual(fileSha(again.d.savePath), DATA_SHA);
  // Resumed ranges must not start at 0 for every segment.
  assert.ok(fast.stats.ranges.some(([s]) => s > 0));
  assert.ok(reqsBefore > 0);
  fast.server.close();
  await m2.shutdown();
});

test('dropped connections are retried transparently', async () => {
  const { m } = makeManager({ connections: 4 });
  const dl = m.add({ url: `${srv.base}/flaky/flaky.bin`, mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  await m.shutdown();
});

test('server without range support falls back to one connection', async () => {
  const { m } = makeManager();
  const dl = m.add({ url: `${srv.base}/norange/plain.bin`, mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(dl.d.resumable, false);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  await m.shutdown();
});

test('server that lies about range support still downloads (single-connection fallback)', async () => {
  const { m } = makeManager({ connections: 8 });
  const dl = m.add({ url: `${srv.base}/liar/liar.bin`, mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(dl.d.resumable, false);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  await m.shutdown();
});

test('unknown length (chunked) download', async () => {
  const { m } = makeManager();
  const dl = m.add({ url: `${srv.base}/chunked/stream.bin`, mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(dl.d.size, SIZE);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  await m.shutdown();
});

test('dynamic segmentation splits the slow segment', async () => {
  const { m } = makeManager({ connections: 4 });
  const dl = m.add({ url: `${srv.base}/slowfirst/split.bin`, mode: 'now' });
  let maxSegs = 0;
  const orig = dl.schedule.bind(dl);
  dl.schedule = () => {
    orig();
    maxSegs = Math.max(maxSegs, dl.d.segments.length);
  };
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  assert.ok(maxSegs > 4, `segments should grow beyond 4 (got ${maxSegs})`);
  await m.shutdown();
});

test('cancel keeps the download in the list (Canceled) and Resume continues', async () => {
  const slow = await startServer(DATA, { bytesPerSec: 768 * 1024 });
  const { m } = makeManager({ connections: 4 });
  const dl = m.add({ url: `${slow.base}/file/cancel.bin`, mode: 'queue' });
  m.startQueue();
  await new Promise((r) => setTimeout(r, 1200));
  await m.cancel(dl.id);
  assert.strictEqual(dl.d.status, 'canceled');
  assert.strictEqual(dl.d.queued, false, 'a canceled item leaves the queue');
  assert.ok(m.list().some((d) => d.id === dl.id), 'still listed');
  const kept = dl.flushedBytes();
  assert.ok(kept > 0 && fs.existsSync(dl.tempPath), 'partial data kept');
  // survives a restart as "canceled"
  m.saveNow();
  const m2 = new (require('../src/main/engine/manager').Manager)({ file: m.file, getSettings: m.getSettings });
  m2.load();
  assert.strictEqual(m2.get(dl.id).d.status, 'canceled');
  m2.resumeAll();
  assert.strictEqual(m2.get(dl.id).running, false, 'Resume all leaves canceled items alone');
  await m.shutdown();
  // explicit resume continues where it stopped
  m.startTimers();
  m.start(dl.id);
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  slow.server.close();
  await m.shutdown();
});

test('403 becomes a readable error', async () => {
  const { m } = makeManager();
  const dl = m.add({ url: `${srv.base}/forbidden`, mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'error');
  assert.match(dl.d.error, /403/);
  await m.shutdown();
});

test('global speed limit is respected', async () => {
  const small = makeData(400 * 1024, 7);
  const s2 = await startServer(small);
  const { m } = makeManager({ speedLimit: 200, connections: 4 });
  const t0 = Date.now();
  const dl = m.add({ url: `${s2.base}/file/limited.bin`, mode: 'now' });
  await waitFor(dl);
  const secs = (Date.now() - t0) / 1000;
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.ok(secs >= 1.4, `took ${secs}s, expected >= 1.4s at 200 KB/s`);
  s2.server.close();
  await m.shutdown();
});

test('queue honours "max downloads at a time" and reports when done', async () => {
  const s3 = await startServer(makeData(1024 * 1024, 3), { bytesPerSec: 2 * 1024 * 1024 });
  const { m } = makeManager({ maxConcurrent: 1, connections: 2 });
  const dls = [1, 2, 3].map((i) => m.add({ url: `${s3.base}/file/q${i}.bin`, mode: 'queue' }));
  assert.ok(dls.every((d) => d.d.status === 'queued'));
  let maxRunning = 0;
  const iv = setInterval(() => (maxRunning = Math.max(maxRunning, dls.filter((d) => d.running).length)), 20);
  const done = new Promise((r) => m.once('queue-done', r));
  m.startQueue();
  await done;
  clearInterval(iv);
  assert.strictEqual(maxRunning, 1);
  assert.ok(dls.every((d) => d.d.status === 'completed'));
  s3.server.close();
  await m.shutdown();
});

test('empty queue never fires queue-done (no surprise shutdown)', async () => {
  const { m } = makeManager();
  let fired = false;
  m.on('queue-done', () => (fired = true));
  m.startQueue();
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(fired, false);
  await m.shutdown();
});

test('refreshing an expired link keeps progress', async () => {
  const slow = await startServer(DATA, { bytesPerSec: 768 * 1024 });
  const { m } = makeManager({ connections: 2 });
  const dl = m.add({ url: `${slow.base}/file/refresh.bin`, mode: 'now' });
  await new Promise((r) => setTimeout(r, 1200));
  await m.pause(dl.id);
  const kept = dl.flushedBytes();
  dl.d.url = `${srv.base}/forbidden`;
  m.start(dl.id);
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'error');
  await m.refreshUrl(dl.id, `${srv.base}/file/refresh.bin`);
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(fileSha(dl.d.savePath), DATA_SHA);
  assert.ok(kept > 0);
  slow.server.close();
  await m.shutdown();
});

test('several queues run independently, each with its own "at a time"', async () => {
  const s4 = await startServer(makeData(1024 * 1024, 4), { bytesPerSec: 1024 * 1024 });
  const sched = { enabled: false, startTime: '02:00', stopEnabled: false, stopTime: '08:00', days: [0, 1, 2, 3, 4, 5, 6], afterDone: 'none' };
  const queues = [
    { id: 'main', name: 'Main queue', maxConcurrent: 1, schedule: sched },
    { id: 'night', name: 'Night', maxConcurrent: 2, schedule: sched },
  ];
  const { m } = makeManager({ queues, connections: 2 });
  const main = [1, 2].map((i) => m.add({ url: `${s4.base}/file/m${i}.bin`, mode: 'queue' }));
  const night = [1, 2, 3].map((i) => m.add({ url: `${s4.base}/file/n${i}.bin`, mode: 'queue', queueId: 'night' }));
  assert.ok(night.every((d) => d.d.queueId === 'night'));
  assert.strictEqual(main[0].d.queueId, 'main');
  assert.strictEqual(m.add({ url: `${s4.base}/file/x.bin`, mode: 'queue', queueId: 'nope' }).d.queueId, 'main', 'unknown queue → main');

  let peak = 0;
  const iv = setInterval(() => (peak = Math.max(peak, night.filter((d) => d.running).length)), 20);
  const done = new Promise((r) => m.on('queue-done', (e) => e.id === 'night' && r(e)));
  m.startQueue('night');
  assert.deepStrictEqual(m.queueState().queues, { main: false, night: true });
  await done;
  clearInterval(iv);
  assert.strictEqual(peak, 2, 'night queue runs two at a time');
  assert.ok(night.every((d) => d.d.status === 'completed'));
  assert.ok(main.every((d) => d.d.status === 'queued'), 'main queue untouched');

  // deleting a queue moves what's left in it to the main queue
  const later = m.add({ url: `${s4.base}/file/n4.bin`, mode: 'queue', queueId: 'night' });
  await m.deleteQueue('night');
  assert.strictEqual(later.d.queueId, 'main');
  s4.server.close();
  await m.shutdown();
});

test('each queue follows its own schedule', async () => {
  const day = [0, 1, 2, 3, 4, 5, 6];
  const queues = [
    { id: 'main', name: 'Main queue', maxConcurrent: 1, schedule: { enabled: true, startTime: '02:00', stopEnabled: false, stopTime: '08:00', days: day, afterDone: 'none' } },
    { id: 'eve', name: 'Evening', maxConcurrent: 1, schedule: { enabled: true, startTime: '20:30', stopEnabled: true, stopTime: '23:00', days: day, afterDone: 'sleep' } },
  ];
  const { m } = makeManager({ queues });
  m.add({ url: 'http://127.0.0.1:9/a.bin', mode: 'queue' });
  m.add({ url: 'http://127.0.0.1:9/b.bin', mode: 'queue', queueId: 'eve' });
  const at = (h, min) => new Date(2026, 10, 12, h, min);
  m.checkSchedule(at(20, 30));
  assert.deepStrictEqual(m.queueState().queues, { main: false, eve: true });
  await m.stopQueue('eve');
  m.checkSchedule(at(2, 0));
  assert.deepStrictEqual(m.queueState().queues, { main: true, eve: false });
  await m.shutdown();
});

test('old single-queue settings become the "Main queue"', () => {
  const { Settings } = require('../src/main/settings');
  const dir = fs.mkdtempSync(path.join(tmp, 's-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ maxConcurrent: 5, schedule: { enabled: true, startTime: '01:30', stopEnabled: false, stopTime: '07:00', days: [1, 2], afterDone: 'shutdown' } }));
  const s = new Settings(file, dir);
  const q = s.get().queues;
  assert.strictEqual(q.length, 1);
  assert.deepStrictEqual({ id: q[0].id, max: q[0].maxConcurrent, start: q[0].schedule.startTime, after: q[0].schedule.afterDone }, { id: 'main', max: 5, start: '01:30', after: 'shutdown' });
  // bad input is cleaned up and "main" always stays first
  s.set({ queues: [{ id: 'x y!', name: '  Night  ', maxConcurrent: 99, schedule: { startTime: '25:00', afterDone: 'boom' } }] });
  const q2 = s.get().queues;
  assert.deepStrictEqual(q2.map((x) => x.id), ['main', 'xy']);
  assert.deepStrictEqual([q2[1].name, q2[1].maxConcurrent, q2[1].schedule.startTime, q2[1].schedule.afterDone], ['Night', 20, '02:00', 'none']);
});

test('queues download one file at a time by default', async () => {
  const { Settings } = require('../src/main/settings');
  const dir = fs.mkdtempSync(path.join(tmp, 's1-'));
  assert.strictEqual(new Settings(path.join(dir, 'fresh.json'), dir).get().queues[0].maxConcurrent, 1, 'new install');
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ maxConcurrent: 3 }));
  assert.strictEqual(new Settings(path.join(dir, 'old.json'), dir).get().queues[0].maxConcurrent, 1, '0.1.0 default (3) becomes 1');

  const s5 = await startServer(makeData(512 * 1024, 6), { bytesPerSec: 1024 * 1024 });
  const { m } = makeManager({ maxConcurrent: undefined, connections: 2 });
  const dls = [1, 2, 3].map((i) => m.add({ url: `${s5.base}/file/one${i}.bin`, mode: 'queue' }));
  let peak = 0;
  const iv = setInterval(() => (peak = Math.max(peak, dls.filter((d) => d.running).length)), 10);
  const done = new Promise((r) => m.once('queue-done', r));
  m.startQueue();
  await done;
  clearInterval(iv);
  assert.strictEqual(peak, 1, 'never more than one at once');
  assert.ok(dls.every((d) => d.d.status === 'completed'));
  s5.server.close();
  await m.shutdown();
});

test('browser cookies are never saved as plain text', async () => {
  const COOKIE = 'session=SECRET-123; theme=dark';
  const secrets = { encrypt: (t) => 'enc:' + Buffer.from(t).toString('base64'), decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString() };
  const dir = fs.mkdtempSync(path.join(tmp, 'c-'));
  const settings = { downloadDir: dir, categorize: false, connections: 2, maxRetries: 1, speedLimit: 0 };
  const file = path.join(dir, 'downloads.json');

  const m = new Manager({ file, getSettings: () => settings, secrets });
  const dl = m.add({ url: 'http://127.0.0.1:9/a.bin', cookies: COOKIE, mode: 'paused' });
  m.saveNow();
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes('SECRET-123'), 'not readable in downloads.json');
  assert.ok(disk.includes('cookiesEnc'));
  const m2 = new Manager({ file, getSettings: () => settings, secrets });
  m2.load();
  assert.strictEqual(m2.get(dl.id).d.cookies, COOKIE, 'restored after a restart');

  // no OS key store: kept in memory only
  const m3 = new Manager({ file: path.join(dir, 'plain.json'), getSettings: () => settings });
  m3.add({ url: 'http://127.0.0.1:9/b.bin', cookies: COOKIE, mode: 'paused' });
  m3.saveNow();
  assert.ok(!fs.readFileSync(path.join(dir, 'plain.json'), 'utf8').includes('SECRET'));

  // a file written by an older version is re-saved protected right away
  const old = path.join(dir, 'old.json');
  fs.writeFileSync(old, JSON.stringify([{ id: 'x', url: 'http://127.0.0.1:9/c.bin', filename: 'c.bin', dir, savePath: path.join(dir, 'c.bin'), status: 'paused', size: -1, segments: [], cookies: COOKIE }]));
  const m4 = new Manager({ file: old, getSettings: () => settings, secrets });
  m4.load();
  assert.ok(!fs.readFileSync(old, 'utf8').includes('SECRET'));
  assert.strictEqual(m4.get('x').d.cookies, COOKIE);
});

test('cookies are dropped once a download has finished', async () => {
  const { m } = makeManager({ connections: 2 });
  const dl = m.add({ url: `${srv.base}/file/c.bin`, cookies: 'session=abc', mode: 'now' });
  await waitFor(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(dl.d.cookies, '');
  await m.shutdown();
});
