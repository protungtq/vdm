'use strict';

// Proxy support, tested against stand-in proxies on this computer (no internet needed).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const proxyConfig = require('../src/main/engine/proxy');
const { request, testConnection } = require('../src/main/engine/http');
const { Manager } = require('../src/main/engine/manager');
const { Settings } = require('../src/main/settings');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-proxy-'));
test.after(() => {
  proxyConfig.configure({ getConfig: () => null, resolveSystem: null });
  fs.rmSync(tmp, { recursive: true, force: true });
});

const BODY = Buffer.alloc(300_000, 9);

/** An HTTP proxy that answers every address with BODY, and can demand a username + password. */
async function httpProxy({ user, pass } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    if (user) {
      const want = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
      if (req.headers['proxy-authorization'] !== want) {
        res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' });
        return res.end();
      }
    }
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : BODY.length - 1;
    const part = BODY.subarray(start, end + 1);
    res.writeHead(range ? 206 : 200, {
      'Content-Length': part.length,
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${BODY.length}` } : {}),
    });
    res.end(part);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, seen };
}

/** A SOCKS5 proxy (no login, or username + password) that connects wherever it is told. */
async function socksProxy({ user, pass } = {}) {
  const targets = [];
  const srv = net.createServer((c) => {
    let stage = 'greet';
    let buf = Buffer.alloc(0);
    c.on('error', () => {});
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 'greet' && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        if (user) {
          if (!methods.includes(2)) return c.end(Buffer.from([5, 0xff]));
          c.write(Buffer.from([5, 2]));
          stage = 'auth';
        } else {
          c.write(Buffer.from([5, 0]));
          stage = 'request';
        }
      }
      if (stage === 'auth' && buf.length >= 2 && buf.length >= 3 + buf[1] + buf[2 + buf[1]]) {
        const ul = buf[1];
        const u = buf.subarray(2, 2 + ul).toString();
        const pl = buf[2 + ul];
        const p = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        if (u !== user || p !== pass) return c.end(Buffer.from([1, 1]));
        c.write(Buffer.from([1, 0]));
        stage = 'request';
      }
      if (stage === 'request' && buf.length >= 7) {
        let host;
        let off;
        if (buf[3] === 1) {
          host = [...buf.subarray(4, 8)].join('.');
          off = 8;
        } else if (buf[3] === 3) {
          host = buf.subarray(5, 5 + buf[4]).toString();
          off = 5 + buf[4];
        } else return c.end();
        const port = buf.readUInt16BE(off);
        targets.push(`${host}:${port}`);
        const rest = buf.subarray(off + 2);
        stage = 'pipe';
        // the test "internet": every name leads to the stand-in server given by the test
        const upstream = net.connect(srv.dest, '127.0.0.1', () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length) upstream.write(rest);
          c.pipe(upstream);
          upstream.pipe(c);
        });
        upstream.on('error', () => c.destroy());
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, targets };
}

const close = (s) => new Promise((r) => (s.closeAllConnections && s.closeAllConnections(), s.close(r)));

test('PAC-style answers from the system are understood', () => {
  assert.deepStrictEqual(proxyConfig.parsePac('PROXY 10.0.0.1:8080; DIRECT'), { type: 'http', host: '10.0.0.1', port: 8080 });
  assert.deepStrictEqual(proxyConfig.parsePac('SOCKS5 127.0.0.1:1080'), { type: 'socks5', host: '127.0.0.1', port: 1080 });
  assert.deepStrictEqual(proxyConfig.parsePac('HTTPS proxy.example.com:443; DIRECT'), { type: 'http', host: 'proxy.example.com', port: 443 });
  assert.strictEqual(proxyConfig.parsePac('DIRECT'), null);
  assert.strictEqual(proxyConfig.parsePac(''), null);
});

test('this computer never goes through a proxy; "manual" and "system" follow the settings', async () => {
  let cfg = { mode: 'manual', type: 'http', host: 'p.example', port: 3128, username: 'u', password: 'p' };
  proxyConfig.configure({ getConfig: () => cfg, resolveSystem: async () => 'SOCKS5 10.1.1.1:1080; DIRECT' });
  assert.strictEqual(await proxyConfig.forUrl('http://127.0.0.1:17842/ping'), null);
  assert.strictEqual(await proxyConfig.forUrl('http://localhost/x'), null);
  assert.deepStrictEqual(await proxyConfig.forUrl('https://example.com/f.zip'), { type: 'http', host: 'p.example', port: 3128, username: 'u', password: 'p' });
  cfg = { mode: 'system' };
  assert.deepStrictEqual(await proxyConfig.forUrl('https://example.com/f.zip'), { type: 'socks5', host: '10.1.1.1', port: 1080 });
  cfg = { mode: 'none' };
  assert.strictEqual(await proxyConfig.forUrl('https://example.com/f.zip'), null);
  cfg = { mode: 'manual', host: '', port: 0 };
  assert.strictEqual(await proxyConfig.forUrl('https://example.com/f.zip'), null, 'incomplete manual setting = direct');
});

test('yt-dlp gets the same proxy (and "none" means really direct)', async () => {
  let cfg = { mode: 'manual', type: 'http', host: '10.0.0.2', port: 8118, username: 'me', password: 'p@ss w' };
  proxyConfig.configure({ getConfig: () => cfg });
  assert.deepStrictEqual(await proxyConfig.ytdlpArgs(), ['--proxy', 'http://me:p%40ss%20w@10.0.0.2:8118']);
  cfg = { mode: 'manual', type: 'socks5', host: '10.0.0.2', port: 1080 };
  assert.deepStrictEqual(await proxyConfig.ytdlpArgs(), ['--proxy', 'socks5h://10.0.0.2:1080']);
  cfg = { mode: 'none' };
  assert.deepStrictEqual(await proxyConfig.ytdlpArgs(), ['--proxy', '']);
});

test('requests go through an HTTP proxy, with its username and password', async () => {
  const p = await httpProxy({ user: 'vdm', pass: 's3cret' });
  const good = { type: 'http', host: '127.0.0.1', port: p.port, username: 'vdm', password: 's3cret' };
  const { res } = await request('http://files.example.test/a.bin', { proxy: good });
  assert.strictEqual(res.statusCode, 200);
  let n = 0;
  for await (const c of res) n += c.length;
  assert.strictEqual(n, BODY.length);
  assert.deepStrictEqual(p.seen, ['http://files.example.test/a.bin'], 'the proxy saw the full address');

  const bad = await request('http://files.example.test/a.bin', { proxy: { ...good, password: 'wrong' } });
  assert.strictEqual(bad.res.statusCode, 407);
  bad.res.resume();
  await close(p.srv);
});

test('requests go through a SOCKS5 proxy (with and without a login)', async () => {
  const web = http.createServer((q, r) => r.end('hello via socks'));
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  for (const login of [undefined, { user: 'vdm', pass: 'pw' }]) {
    const s = await socksProxy(login);
    s.srv.dest = web.address().port;
    const proxy = { type: 'socks5', host: '127.0.0.1', port: s.port, username: login && login.user, password: login && login.pass };
    const { res } = await request('http://files.example.test:8080/x', { proxy });
    let text = '';
    for await (const c of res) text += c;
    assert.strictEqual(text, 'hello via socks');
    assert.deepStrictEqual(s.targets, ['files.example.test:8080'], 'the name is resolved by the proxy, not here');
    await close(s.srv);
  }
  // wrong login is refused
  const s = await socksProxy({ user: 'vdm', pass: 'pw' });
  await assert.rejects(request('http://files.example.test/x', { proxy: { type: 'socks5', host: '127.0.0.1', port: s.port, username: 'vdm', password: 'no' } }));
  await close(s.srv);
  await close(web);
});

test('a real download runs through the proxy from the settings', async () => {
  const p = await httpProxy();
  proxyConfig.configure({ getConfig: () => ({ mode: 'manual', type: 'http', host: '127.0.0.1', port: p.port, username: '', password: '' }) });
  const dir = fs.mkdtempSync(path.join(tmp, 'dl-'));
  const settings = { downloadDir: dir, categorize: false, connections: 3, maxRetries: 1, speedLimit: 0 };
  const m = new Manager({ file: path.join(dir, 'd.json'), getSettings: () => settings });
  const dl = m.add({ url: 'http://files.example.test/big.bin', mode: 'now' });
  await new Promise((resolve) => {
    const check = () => ['completed', 'error'].includes(dl.d.status) && !dl.running;
    if (check()) return resolve();
    dl.on('stopped', function on() {
      if (check()) resolve();
    });
  });
  assert.strictEqual(dl.d.status, 'completed', dl.d.error);
  assert.strictEqual(fs.statSync(path.join(dir, 'big.bin')).size, BODY.length);
  assert.ok(p.seen.length >= 1 && p.seen.every((u) => u === 'http://files.example.test/big.bin'));
  await m.shutdown();
  await close(p.srv);
  proxyConfig.configure({ getConfig: () => null });
});

test('"Test" tells a working proxy from a broken one', async () => {
  const p = await httpProxy();
  const ok = await testConnection({ type: 'http', host: '127.0.0.1', port: p.port }, 'http://gen.example.test/generate_204');
  assert.strictEqual(ok.ok, true);
  assert.ok(ok.ms >= 0);
  await close(p.srv);
  await assert.rejects(testConnection({ type: 'http', host: '127.0.0.1', port: p.port }, 'http://gen.example.test/x', 1500));
});

test('proxy settings are cleaned up, and the password is encrypted on disk', () => {
  const secrets = { encrypt: (t) => 'enc:' + Buffer.from(t).toString('base64'), decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString() };
  const dir = fs.mkdtempSync(path.join(tmp, 's-'));
  const file = path.join(dir, 'settings.json');
  const s = new Settings(file, dir, secrets);
  assert.strictEqual(s.get().proxy.mode, 'none');
  s.set({ proxy: { mode: 'manual', type: 'socks5', host: 'https://proxy.example.com:1080/path', port: 99999, username: 'me', password: 'TOP-SECRET' } });
  const p = s.get().proxy;
  assert.deepStrictEqual([p.mode, p.type, p.host, p.port], ['manual', 'socks5', 'proxy.example.com', 65535]);
  s.set({ proxy: { host: 'http://10.0.0.5:3128/', port: 0 } });
  assert.deepStrictEqual([s.get().proxy.host, s.get().proxy.port], ['10.0.0.5', 3128], 'port taken from a pasted address');
  s.set({ proxy: { mode: 'bogus', type: 'ftp' } });
  assert.deepStrictEqual([s.get().proxy.mode, s.get().proxy.type], ['manual', 'socks5'], 'invalid values are ignored');

  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes('TOP-SECRET'), 'no plain text password on disk');
  assert.ok(disk.includes('passwordEnc'));
  const again = new Settings(file, dir, secrets);
  assert.strictEqual(again.get().proxy.password, 'TOP-SECRET', 'restored after a restart');
  const view = again.forRenderer();
  assert.deepStrictEqual([view.proxy.password, view.proxy.hasPassword], ['', true], 'windows never get the password');

  // without an OS key store the password is simply not saved
  const f2 = path.join(dir, 'plain.json');
  const s2 = new Settings(f2, dir);
  s2.set({ proxy: { mode: 'manual', host: 'h', port: 1, password: 'NOPE' } });
  assert.ok(!fs.readFileSync(f2, 'utf8').includes('NOPE'));
});
