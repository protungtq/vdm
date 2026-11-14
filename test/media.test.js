'use strict';

// Video-download pipeline tests. yt-dlp is replaced by test/fixtures/fake-ytdlp.js,
// which speaks the same CLI protocol, so no external program or network is used.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { Manager } = require('../src/main/engine/manager');
const { probeMedia, isVideoPage, FORMATS_MISSING } = require('../src/main/media/media');
const { Components } = require('../src/main/media/components');

const FAKE = path.join(__dirname, 'fixtures', 'fake-ytdlp.js');
// The fixture is spawned directly (shebang), so it must be executable. Files
// pushed through the GitHub API land in git without the +x bit, which made
// every fixture-spawning test fail with EACCES on macOS/Linux.
if (process.platform !== 'win32') {
  try { fs.chmodSync(FAKE, 0o755); } catch { /* already executable */ }
}
const tools = { ready: () => true, ytdlpPath: FAKE, ffmpegPath: '/nonexistent/ffmpeg' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-media-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function makeManager(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'm-'));
  const settings = { downloadDir: dir, categorize: false, connections: 8, maxConcurrent: 2, maxRetries: 3, speedLimit: 0, ...overrides };
  const m = new Manager({ file: path.join(dir, 'downloads.json'), getSettings: () => settings, tools });
  m.startTimers();
  return { m, dir };
}

const settle = (dl) =>
  new Promise((resolve, reject) => {
    // A spawn failure that never settles used to hang the whole run until
    // GitHub's 6h timeout. Fail fast with a clear message instead.
    const timer = setTimeout(
      () => reject(new Error('download did not settle within 60s')),
      60_000,
    );
    const done = (value) => { clearTimeout(timer); resolve(value); };
    const check = () => !dl.running && ['completed', 'error', 'paused', 'canceled'].includes(dl.d.status);
    if (check()) return done(dl);
    dl.on('stopped', function on() {
      if (check()) {
        dl.off('stopped', on);
        done(dl);
      }
    });
  });

test('recognises common video sites', () => {
  assert.ok(isVideoPage('https://www.youtube.com/watch?v=abc'));
  assert.ok(isVideoPage('https://youtu.be/abc'));
  assert.ok(isVideoPage('https://x.com/user/status/1'));
  assert.ok(!isVideoPage('https://example.com/file.zip'));
});

test('probe turns yt-dlp formats into clear quality choices', async () => {
  const info = await probeMedia(FAKE, 'https://www.youtube.com/watch?v=abc', {});
  assert.strictEqual(info.title, 'Silo S01E08 – Trailer');
  assert.strictEqual(info.site, 'YouTube');
  const labels = info.options.map((o) => o.label);
  assert.deepStrictEqual(labels, ['1080p', '720p60', '360p', 'Audio only']);
  const hd = info.options[0];
  assert.match(hd.detail, /H\.264/);
  assert.strictEqual(hd.size, 40_000_000 + 2_400_000, 'video + best audio');
  assert.match(hd.format, /height<=1080/);
  assert.strictEqual(info.options[2].size, 8_000_000, 'progressive format has its own audio');
  assert.strictEqual(info.options[3].audioOnly, true);
});

test('probe reports unsupported pages and DRM clearly', async () => {
  await assert.rejects(probeMedia(FAKE, 'https://example.com/unsupported', {}), /No video found/);
  await assert.rejects(probeMedia(FAKE, 'https://example.com/drm', {}), /DRM/);
});

test('yt-dlp gets a JavaScript runtime (needed for YouTube) and clear errors', async () => {
  const log = path.join(tmp, 'args.log');
  process.env.FAKE_YTDLP_LOG = log;
  try {
    await probeMedia(FAKE, 'https://www.youtube.com/watch?v=abc', {});
    const args = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
    const i = args.indexOf('--js-runtimes');
    assert.ok(i >= 0, 'runtime passed');
    assert.strictEqual(args[i + 1], `node:${process.execPath}`);
    await assert.rejects(probeMedia(FAKE, 'https://www.youtube.com/watch?v=needs-update', {}), (e) => e.message === FORMATS_MISSING);
  } finally {
    delete process.env.FAKE_YTDLP_LOG;
  }
});

test('an outdated yt-dlp is updated at most once per period', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'tools-'));
  const log = path.join(dir, 'args.log');
  process.env.FAKE_YTDLP_LOG = log;
  try {
    fs.copyFileSync(FAKE, path.join(dir, 'yt-dlp'));
    fs.chmodSync(path.join(dir, 'yt-dlp'), 0o755);
    fs.writeFileSync(path.join(dir, 'ffmpeg'), '');
    const c = new Components(dir, 'linux');
    const old = Date.now() / 1000 - 10 * 24 * 3600;
    fs.utimesSync(path.join(dir, 'yt-dlp'), old, old);
    assert.strictEqual(await c.updateIfStale(3 * 24 * 3600 * 1000), true, 'ten days old: update');
    assert.ok(fs.readFileSync(log, 'utf8').includes('"-U"'));
    assert.strictEqual(await c.updateIfStale(3 * 24 * 3600 * 1000), false, 'just updated: skip');
  } finally {
    delete process.env.FAKE_YTDLP_LOG;
  }
});

test('video download: two streams, progress, merge stage, completion', async () => {
  const { m, dir } = makeManager();
  const dl = m.add({ type: 'media', url: 'https://www.youtube.com/watch?v=abc', title: 'Silo: Trailer?', format: 'bv*[height<=1080]+ba/b', size: 4_000_000, mode: 'now' });
  assert.strictEqual(dl.d.category, 'video');
  assert.strictEqual(path.basename(dl.d.savePath), 'Silo_ Trailer_.mp4', 'title sanitised for Windows');
  let sawSecondPhase = false;
  let sawSpeed = false;
  const iv = setInterval(() => {
    if (dl.phase === 1) sawSecondPhase = true;
    if (dl.snapshot().speed > 0) sawSpeed = true;
  }, 10);
  await settle(dl);
  clearInterval(iv);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.ok(sawSecondPhase, 'moved on to the audio stream');
  assert.ok(sawSpeed, 'speed reported');
  assert.ok(fs.existsSync(path.join(dir, 'Silo_ Trailer_.mp4')));
  assert.strictEqual(dl.d.downloaded, dl.d.size);
  await m.shutdown();
});

test('audio-only download produces an MP3', async () => {
  const { m, dir } = makeManager();
  const dl = m.add({ type: 'media', url: 'https://www.youtube.com/watch?v=abc', title: 'song', format: 'ba/b', audioOnly: true, mode: 'now' });
  assert.strictEqual(dl.d.category, 'audio');
  await settle(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(path.extname(dl.d.savePath), '.mp3');
  assert.ok(fs.existsSync(path.join(dir, 'song.mp3')));
  await m.shutdown();
});

test('pause stops yt-dlp and resume continues where it was', async () => {
  process.env.FAKE_YTDLP_DELAY = '120';
  const { m } = makeManager();
  const dl = m.add({ type: 'media', url: 'https://www.youtube.com/watch?v=abc', title: 'resume me', format: 'bv*+ba/b', mode: 'now' });
  await new Promise((r) => setTimeout(r, 700));
  await m.pause(dl.id);
  assert.strictEqual(dl.d.status, 'paused');
  const at = dl.d.downloaded;
  assert.ok(at > 0, 'some progress before pause');
  delete process.env.FAKE_YTDLP_DELAY;
  m.start(dl.id);
  // first progress after resume must not start from zero
  const firstAfter = await new Promise((r) => dl.once('progress', () => r(dl.d.downloaded)));
  assert.ok(firstAfter >= at, `resumed at ${firstAfter} (paused at ${at})`);
  await settle(dl);
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  await m.shutdown();
});

test('cancel keeps the item as Canceled; remove deletes partial files', async () => {
  process.env.FAKE_YTDLP_DELAY = '120';
  const { m, dir } = makeManager();
  const dl = m.add({ type: 'media', url: 'https://www.youtube.com/watch?v=abc', title: 'cancel me', format: 'bv*+ba/b', mode: 'now' });
  await new Promise((r) => setTimeout(r, 500));
  await m.cancel(dl.id);
  delete process.env.FAKE_YTDLP_DELAY;
  assert.strictEqual(dl.d.status, 'canceled');
  assert.ok(m.list().some((d) => d.id === dl.id));
  fs.writeFileSync(path.join(dir, 'cancel me.f137.mp4.part'), 'x');
  await m.remove(dl.id);
  assert.ok(!fs.existsSync(path.join(dir, 'cancel me.f137.mp4.part')), 'partial file removed');
  await m.shutdown();
});

test('errors from yt-dlp become readable', async () => {
  const { m } = makeManager();
  const dl = m.add({ type: 'media', url: 'https://www.youtube.com/watch?v=fail', title: 'bad', format: 'b', mode: 'now' });
  await settle(dl);
  assert.strictEqual(dl.d.status, 'error');
  assert.match(dl.d.error, /403/);
  await m.shutdown();
});

test('media downloads survive a restart and run in the queue', async () => {
  const { m } = makeManager({ maxConcurrent: 1 });
  const a = m.add({ type: 'media', url: 'https://www.youtube.com/watch?v=1', title: 'q1', format: 'b', mode: 'queue' });
  m.add({ url: 'http://127.0.0.1:9/never.bin', mode: 'paused' });
  m.saveNow();
  await m.shutdown();
  const m2 = new Manager({ file: m.file, getSettings: m.getSettings, tools });
  m2.load();
  m2.startTimers();
  const again = m2.get(a.id);
  assert.strictEqual(again.constructor.name, 'MediaDownload');
  const done = new Promise((r) => m2.once('queue-done', r));
  m2.startQueue();
  await done;
  assert.strictEqual(again.d.status, 'completed', again.d.error);
  await m2.shutdown();
});

test('component installer checks the files before using them', async () => {
  const exe = Buffer.from('#!/bin/sh\necho 2026.11.01\n');
  const ffgz = zlib.gzipSync(Buffer.alloc(300_000, 3));
  const sha = (b) => require('crypto').createHash('sha256').update(b).digest('hex');
  let tamper = false;
  const srv = http.createServer((req, res) => {
    if (req.url === '/yt/releases/latest') {
      res.writeHead(302, { Location: '/yt/releases/tag/2026.11.01' });
      return res.end();
    }
    if (req.url === '/yt/releases/tag/2026.11.01') return res.end('<html>release page</html>');
    if (req.url === '/yt/releases/download/2026.11.01/SHA2-256SUMS') return res.end(`${'0'.repeat(64)}  yt-dlp.exe\n${sha(exe)}  yt-dlp_linux\n`);
    if (req.url === '/yt/releases/download/2026.11.01/yt-dlp_linux') return res.end(tamper ? Buffer.from('#!/bin/sh\necho evil\n') : exe);
    if (req.url === '/ff.gz') return res.end(ffgz);
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const sources = () => ({
    ytdlp: { latest: `${base}/yt/releases`, asset: 'yt-dlp_linux', file: 'yt-dlp', sums: 'SHA2-256SUMS' },
    ffmpeg: { url: `${base}/ff.gz`, sha256: sha(ffgz), file: 'ffmpeg', gz: true },
  });

  const dir = path.join(tmp, 'bin');
  const c = new Components(dir, 'linux', sources());
  assert.strictEqual((await c.status()).ready, false);
  let progress = 0;
  const st = await c.install((p) => (progress = p.received));
  assert.strictEqual(st.ready, true);
  assert.ok(progress > 0);
  assert.ok(fs.readFileSync(path.join(dir, 'ffmpeg')).equals(zlib.gunzipSync(ffgz)), 'ffmpeg gunzipped');
  assert.ok(fs.readFileSync(path.join(dir, 'yt-dlp')).equals(exe));
  assert.ok(fs.statSync(path.join(dir, 'yt-dlp')).mode & 0o100, 'executable');

  // a file that doesn't match its published checksum is deleted, never kept
  tamper = true;
  const dir2 = path.join(tmp, 'bin2');
  await assert.rejects(new Components(dir2, 'linux', sources()).install(), /integrity check/);
  assert.ok(!fs.existsSync(path.join(dir2, 'yt-dlp')) && !fs.existsSync(path.join(dir2, 'yt-dlp.download')));
  const bad = { ...sources(), ytdlp: undefined };
  bad.ffmpeg.sha256 = 'f'.repeat(64);
  delete bad.ytdlp;
  await assert.rejects(new Components(path.join(tmp, 'bin3'), 'linux', { ytdlp: sources().ytdlp, ffmpeg: bad.ffmpeg }).install(), /integrity check/);
  srv.close();
});

test('every built-in ffmpeg download has a pinned checksum', () => {
  const { SOURCES } = require('../src/main/media/components');
  for (const [os, s] of Object.entries(SOURCES)) {
    assert.match(s.ffmpeg.sha256, /^[0-9a-f]{64}$/, os);
    assert.ok(s.ytdlp.latest && s.ytdlp.sums, os);
  }
});
