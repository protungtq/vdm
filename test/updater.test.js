'use strict';

// Updater tests against a local stand-in for the GitHub Releases API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Updater, compareVersions } = require('../src/main/updater');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-upd-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const installer = crypto.randomBytes(700_000);
const sha = crypto.createHash('sha256').update(installer).digest('hex');

async function server(release, { truncate = false } = {}) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/repos/me/vdm/releases/latest') {
      if (!release) {
        res.writeHead(404);
        return res.end('{}');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(release(base)));
    }
    if (req.url === '/dl/VDM-Setup-0.2.0.exe') {
      // redirect like GitHub does (to its file storage)
      res.writeHead(302, { Location: '/storage/setup' });
      return res.end();
    }
    if (req.url === '/storage/setup') {
      res.writeHead(200, { 'Content-Length': installer.length });
      return res.end(truncate ? installer.subarray(0, 1000) : installer);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { srv, base };
}

const rel = (version, digest = `sha256:${sha}`) => (base) => ({
  tag_name: `v${version}`,
  html_url: 'https://github.com/me/vdm/releases/tag/v' + version,
  draft: false,
  prerelease: false,
  assets: [
    { name: `VDM-Portable-${version}.exe`, browser_download_url: `${base}/dl/VDM-Portable-${version}.exe`, size: 5 },
    { name: `VDM-Setup-${version}.exe`, browser_download_url: `${base}/dl/VDM-Setup-${version}.exe`, size: installer.length, digest },
  ],
});

const make = (base, extra = {}) =>
  new Updater({ version: '0.1.0', repo: 'me/vdm', cacheDir: path.join(tmp, String(Math.random())), apiBase: base, allowedPrefixes: [base], ...extra });

test('version comparison is numeric', () => {
  assert.strictEqual(compareVersions('0.10.0', '0.9.9'), 1);
  assert.strictEqual(compareVersions('0.1.0', '0.1'), 0);
  assert.strictEqual(compareVersions('0.1.0', '0.2.0'), -1);
});

test('finds a newer release, downloads and verifies the installer', async () => {
  const { srv, base } = await server(rel('0.2.0'));
  const u = make(base);
  const seen = [];
  u.on('state', (s) => seen.push(s.status));
  const st = await u.check();
  assert.strictEqual(st.status, 'available');
  assert.strictEqual(st.version, '0.2.0');
  assert.strictEqual(st.asset.name, 'VDM-Setup-0.2.0.exe');
  const done = await u.download();
  assert.strictEqual(done.status, 'ready');
  assert.ok(fs.readFileSync(done.file).equals(installer));
  assert.ok(seen.includes('downloading'));
  srv.close();
  srv.closeAllConnections();
});

test('same or older version, or no releases yet: nothing to do', async () => {
  let { srv, base } = await server(rel('0.1.0'));
  assert.strictEqual((await make(base).check()).status, 'none');
  srv.close();
  srv.closeAllConnections();
  ({ srv, base } = await server(null));
  assert.strictEqual((await make(base).check()).status, 'none');
  srv.close();
  srv.closeAllConnections();
});

test('a damaged or incomplete download is rejected and not kept', async () => {
  let { srv, base } = await server(rel('0.2.0', 'sha256:' + '0'.repeat(64)));
  let u = make(base);
  await u.check();
  await assert.rejects(u.download(), /damaged/);
  assert.strictEqual(u.state.status, 'error');
  assert.deepStrictEqual(fs.readdirSync(u.cacheDir), []);
  srv.close();
  srv.closeAllConnections();
  ({ srv, base } = await server(rel('0.2.0'), { truncate: true }));
  u = make(base);
  await u.check();
  await assert.rejects(u.download(), /incomplete/);
  srv.close();
  srv.closeAllConnections();
});

test('only downloads from the project release location', async () => {
  const { srv, base } = await server(rel('0.2.0'));
  const u = make(base, { allowedPrefixes: ['https://github.com/me/vdm/releases/download/'] });
  await u.check();
  await assert.rejects(u.download(), /Unexpected download location/);
  srv.close();
  srv.closeAllConnections();
});

test('portable build points to the release page instead of downloading', async () => {
  const { srv, base } = await server(rel('0.2.0'));
  const u = make(base, { portable: true });
  const st = await u.check();
  assert.strictEqual(st.status, 'available');
  assert.strictEqual(st.asset.name, 'VDM-Portable-0.2.0.exe');
  assert.strictEqual(st.page, 'https://github.com/me/vdm/releases/tag/v0.2.0');
  await assert.rejects(u.download());
  srv.close();
  srv.closeAllConnections();
});

test('offline check reports a readable error', async () => {
  const u = make('http://127.0.0.1:9');
  const st = await u.check();
  assert.strictEqual(st.status, 'error');
  assert.match(st.error, /internet/);
});

// GitHub's API limits anonymous requests per IP (403 / 429). The update check must still work through the release pages.
async function limitedServer({ filesReady = true } = {}) {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/repos/')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end('{"message":"API rate limit exceeded"}');
    }
    if (req.url === '/me/vdm/releases/latest') {
      res.writeHead(302, { Location: '/me/vdm/releases/tag/v0.2.0' });
      return res.end();
    }
    if (req.url === '/me/vdm/releases/tag/v0.2.0') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html></html>');
    }
    if (filesReady && req.url === '/me/vdm/releases/download/v0.2.0/VDM-Setup-0.2.0.exe') {
      res.writeHead(302, { Location: '/storage/setup' });
      return res.end();
    }
    if (req.url === '/storage/setup') {
      res.writeHead(200, { 'Content-Length': installer.length });
      return res.end(installer);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}

test('when the API refuses (rate limit), the release pages are used instead', async () => {
  const { srv, base } = await limitedServer();
  const u = make(base, { webBase: base, allowedPrefixes: [base] });
  const st = await u.check();
  assert.strictEqual(st.status, 'available');
  assert.strictEqual(st.version, '0.2.0');
  assert.strictEqual(st.asset.name, 'VDM-Setup-0.2.0.exe');
  const done = await u.download();
  assert.ok(fs.readFileSync(done.file).equals(installer));
  srv.close();
  srv.closeAllConnections();
});

test('rate limit, and the installer is not published yet: no update is offered', async () => {
  const { srv, base } = await limitedServer({ filesReady: false });
  const u = make(base, { webBase: base, allowedPrefixes: [base] });
  assert.strictEqual((await u.check()).status, 'none');
  srv.close();
  srv.closeAllConnections();
});

test('rate limit and the release pages unreachable: the error says so', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(403);
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const u = make(base, { webBase: base, allowedPrefixes: [base] });
  const st = await u.check();
  assert.strictEqual(st.status, 'error');
  assert.match(st.error, /403/);
  srv.close();
  srv.closeAllConnections();
});

test('a release whose installers are still being uploaded is not offered yet', async () => {
  let ready = false;
  const { srv, base } = await server((b) => ({ ...rel('0.2.0')(b), assets: ready ? rel('0.2.0')(b).assets : [] }));
  const u = make(base);
  assert.strictEqual((await u.check()).status, 'none');
  ready = true;
  const st = await u.check();
  assert.strictEqual(st.status, 'available');
  assert.ok(st.asset, 'the installer is there now, so the app can install it itself');
  u.stop();
  srv.close();
  srv.closeAllConnections();
});

test('the release location matches whatever letter case GitHub uses for the repository', async () => {
  const { srv, base } = await server(rel('0.2.0'));
  const u = make(base, { allowedPrefixes: [base.toUpperCase()] }); // GitHub spells the repo the way it was created; the allowed prefix may use different letter case
  await u.check();
  assert.strictEqual((await u.download()).status, 'ready');
  srv.close();
  srv.closeAllConnections();
});

test('a refused download location is shown as an error, not silently ignored', async () => {
  const { srv, base } = await server(rel('0.2.0'));
  const u = make(base, { allowedPrefixes: ['https://github.com/me/vdm/releases/download/'] });
  await u.check();
  await u.download().catch(() => {});
  assert.strictEqual(u.state.status, 'error');
  assert.strictEqual(u.state.stage, 'download');
  srv.close();
  srv.closeAllConnections();
});
