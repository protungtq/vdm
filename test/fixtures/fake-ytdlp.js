#!/usr/bin/env node
// Test double for yt-dlp: speaks the same CLI protocol VDM uses (no network,
// no external code). -J prints canned info JSON; otherwise it "downloads" by
// writing a file while printing progress lines in VDM's template format.
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const url = args[args.indexOf('--') + 1] || '';
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

if (process.env.FAKE_YTDLP_LOG) fs.appendFileSync(process.env.FAKE_YTDLP_LOG, JSON.stringify(args) + '\n');
if (args.includes('-U')) process.exit(0);
// like YouTube when its JavaScript challenge can't be solved: until "-U" ran, no formats
if (/needs-update/.test(url) && !(process.env.FAKE_YTDLP_LOG && fs.readFileSync(process.env.FAKE_YTDLP_LOG, 'utf8').includes('"-U"'))) {
  process.stderr.write('ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats\n');
  process.exit(1);
}
if (args.includes('--version')) {
  console.log('2026.11.01-fake');
  process.exit(0);
}
if (/unsupported/.test(url)) {
  process.stderr.write('ERROR: Unsupported URL: ' + url + '\n');
  process.exit(1);
}
if (/drm/.test(url)) {
  process.stderr.write('ERROR: [Generic] drm: This video is DRM protected\n');
  process.exit(1);
}
// Like yt-dlp, actually run the JavaScript runtime it was given (VDM passes its own executable).
const rt = opt('--js-runtimes');
if (rt) {
  const bin = rt.replace(/^node:/, '');
  const r = require('child_process').spawnSync(bin, ['-e', 'process.stdout.write(String(6 * 7))'], { encoding: 'utf8' });
  if (r.stdout !== '42') {
    process.stderr.write(`ERROR: [youtube] JavaScript runtime ${bin} did not work (${(r.stderr || r.error || '').toString().slice(0, 120)})\n`);
    process.exit(1);
  }
}
if (args.includes('-J')) {
  const info = {
    title: 'Silo S01E08 – Trailer',
    extractor_key: /youtube/.test(url) ? 'Youtube' : 'Generic',
    duration: 120,
    thumbnail: 'https://example.com/thumb.jpg',
    formats: [
      { format_id: '140', vcodec: 'none', acodec: 'mp4a.40.2', filesize: 2_000_000 },
      { format_id: '251', vcodec: 'none', acodec: 'opus', filesize: 2_400_000 },
      { format_id: '137', vcodec: 'avc1.640028', acodec: 'none', height: 1080, fps: 30, filesize: 40_000_000 },
      { format_id: '248', vcodec: 'vp9', acodec: 'none', height: 1080, fps: 30, filesize: 30_000_000 },
      { format_id: '136', vcodec: 'avc1.4d401f', acodec: 'none', height: 720, fps: 60, filesize: 20_000_000 },
      { format_id: '18', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, fps: 30, filesize: 8_000_000 },
    ],
  };
  process.stdout.write(JSON.stringify(info));
  process.exit(0);
}

// download mode
const tpl = opt('-o');
const audio = args.includes('-x');
const ext = audio ? 'mp3' : opt('--merge-output-format') || 'mp4';
const out = tpl.replace('%(ext)s', ext);
const twoPhase = !audio && /\+/.test(opt('-f') || '');
const phases = twoPhase ? [['f137.mp4', 3_000_000], ['f140.m4a', 1_000_000]] : [['f18.mp4', 2_000_000]];
const fail = /fail/.test(url);
const step = 250_000;
const delay = Number(process.env.FAKE_YTDLP_DELAY || 40);
let pi = 0;
let done = 0;
// --continue: resume from what a previous run wrote
const state = out + '.fake-progress';
if (args.includes('--continue') && fs.existsSync(state)) [pi, done] = JSON.parse(fs.readFileSync(state, 'utf8'));
const tick = () => {
  const [name, total] = phases[pi];
  const file = tpl.replace('%(ext)s', name);
  done = Math.min(total, done + step);
  fs.writeFileSync(state, JSON.stringify([pi, done]));
  console.log(`VDMP|${done >= total ? 'finished' : 'downloading'}|${done}|${total}|NA|1500000.5|${Math.round((total - done) / 1500000)}|${file}`);
  if (fail && pi === 0 && done >= total / 2) {
    process.stderr.write('ERROR: [youtube] abc: HTTP Error 403: Forbidden\n');
    process.exit(1);
  }
  if (done >= total) {
    pi++;
    done = 0;
    if (pi >= phases.length) {
      fs.writeFileSync(out, Buffer.alloc(1234, 7));
      fs.rmSync(state, { force: true });
      console.log(`VDMF|${out}`);
      process.exit(0);
    }
  }
  setTimeout(tick, delay);
};
tick();
