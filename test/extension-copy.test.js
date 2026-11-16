'use strict';

// The extension copy that survives restarts (the portable build's own folder is temporary).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { syncExtension } = require('../src/main/extension-copy');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-extcopy-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('copies the extension, refreshes changed files and removes ones that are gone', () => {
  const src = path.join(tmp, 'bundled');
  const dst = path.join(tmp, 'data', 'extension');
  fs.mkdirSync(path.join(src, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(src, 'manifest.json'), '{"version":"1"}');
  fs.writeFileSync(path.join(src, 'old.js'), 'old');
  fs.writeFileSync(path.join(src, 'icons', '16.png'), 'png');
  assert.strictEqual(syncExtension(src, dst), dst);
  assert.strictEqual(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'), '{"version":"1"}');
  assert.ok(fs.existsSync(path.join(dst, 'icons', '16.png')));

  // the next VDM version ships a changed manifest, no old.js, and a new file
  fs.writeFileSync(path.join(src, 'manifest.json'), '{"version":"2"}');
  fs.rmSync(path.join(src, 'old.js'));
  fs.writeFileSync(path.join(src, 'new.js'), 'new');
  syncExtension(src, dst);
  assert.strictEqual(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'), '{"version":"2"}');
  assert.ok(!fs.existsSync(path.join(dst, 'old.js')));
  assert.ok(fs.existsSync(path.join(dst, 'new.js')));
});

test('the bundled extension is copied completely', () => {
  const dst = path.join(tmp, 'real');
  syncExtension(path.join(__dirname, '..', 'extension'), dst);
  for (const f of ['manifest.json', 'background.js', 'grabber.js', 'popup.html', path.join('icons', '128.png')]) assert.ok(fs.existsSync(path.join(dst, f)), f);
});
