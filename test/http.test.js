'use strict';

// Redirects to another host must not carry the original site's Cookie or Referer along;
// redirects on the same host keep them.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { request } = require('../src/main/engine/http');

function serve(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: { ...req.headers } });
    handler(req, res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

test('redirects to another host drop Cookie and Referer', async () => {
  const target = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 4 });
    res.end('data');
  });
  const source = await serve((req, res) => {
    res.writeHead(302, { Location: `${target.base}/file.bin` });
    res.end();
  });
  try {
    const { req, res, url } = await request(`${source.base}/go`, { headers: { Referer: 'https://example.com/page', Cookie: 'session=abc' } });
    res.resume();
    req.destroy();
    assert.strictEqual(url, `${target.base}/file.bin`);
    assert.strictEqual(source.seen.length, 1);
    assert.strictEqual(source.seen[0].headers.referer, 'https://example.com/page');
    assert.strictEqual(source.seen[0].headers.cookie, 'session=abc');
    assert.strictEqual(target.seen.length, 1);
    assert.strictEqual(target.seen[0].headers.referer, undefined, 'Referer must not leak to another host');
    assert.strictEqual(target.seen[0].headers.cookie, undefined, 'Cookie must not leak to another host');
  } finally {
    source.server.close();
    target.server.close();
  }
});

test('redirects on the same host keep Cookie and Referer', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/go') {
      res.writeHead(302, { Location: '/file.bin' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 4 });
    res.end('data');
  });
  try {
    const { req, res } = await request(`${srv.base}/go`, { headers: { Referer: 'https://example.com/page', Cookie: 'session=abc' } });
    res.resume();
    req.destroy();
    assert.strictEqual(srv.seen.length, 2);
    assert.strictEqual(srv.seen[1].headers.referer, 'https://example.com/page');
    assert.strictEqual(srv.seen[1].headers.cookie, 'session=abc');
  } finally {
    srv.server.close();
  }
});
