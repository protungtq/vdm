'use strict';

// The local bridge only accepts downloads from VDM's own browser extension,
// and only with the pairing token the app shows in Settings.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { startIntegrationServer, PORT, EXTENSION_IDS } = require('../src/main/integration/server');

const call = (method, path, headers = {}, body = '') =>
  new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
    req.end(body);
  });

test('only VDM\'s extension can send downloads', async () => {
  const got = [];
  const srv = startIntegrationServer({ version: 't', isEnabled: () => true, onDownload: (p) => got.push(p.url), getToken: () => 'pair-token' });
  await new Promise((r) => srv.once('listening', r));
  const body = JSON.stringify({ url: 'https://example.com/a.zip' });
  const ours = `chrome-extension://${EXTENSION_IDS[0]}`;
  const token = { 'X-VDM-Token': 'pair-token' };
  try {
    assert.strictEqual(await call('POST', '/download', { Origin: ours, ...token }, body), 200, 'VDM extension with token');
    assert.strictEqual(await call('POST', '/download', { Origin: ours }, body), 403, 'no token');
    assert.strictEqual(await call('POST', '/download', { Origin: ours, 'X-VDM-Token': 'wrong' }, body), 403, 'wrong token');
    assert.strictEqual(await call('POST', '/download', { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', ...token }, body), 403, 'another extension');
    assert.strictEqual(await call('POST', '/download', { Origin: 'https://evil.example', ...token }, body), 403, 'a web page');
    assert.strictEqual(await call('POST', '/download', { ...token }, body), 403, 'no origin');
    assert.strictEqual(await call('POST', '/download', { Origin: ours, Host: 'evil.example:17842', ...token }, body), 403, 'DNS rebinding');
    assert.strictEqual(await call('GET', '/ping'), 200, 'status check from an extension');
    assert.strictEqual(await call('GET', '/ping', { Origin: 'https://evil.example' }), 403, 'status check from a web page');
    assert.deepStrictEqual(got, ['https://example.com/a.zip']);
  } finally {
    // Await the close: the next test binds the same fixed port, and a
    // still-closing server makes its listen fail with EADDRINUSE.
    await new Promise((r) => {
      srv.closeAllConnections?.();
      srv.close(r);
    });
  }
});

test('without a token configured the Origin check alone applies', async () => {
  const got = [];
  const srv = startIntegrationServer({ version: 't', isEnabled: () => true, onDownload: (p) => got.push(p.url) });
  await new Promise((r) => srv.once('listening', r));
  const body = JSON.stringify({ url: 'https://example.com/a.zip' });
  const ours = `chrome-extension://${EXTENSION_IDS[0]}`;
  try {
    assert.strictEqual(await call('POST', '/download', { Origin: ours }, body), 200, 'no token configured yet');
    assert.strictEqual(await call('POST', '/download', { Origin: 'https://evil.example' }, body), 403, 'a web page still refused');
    assert.deepStrictEqual(got, ['https://example.com/a.zip']);
  } finally {
    await new Promise((r) => {
      srv.closeAllConnections?.();
      srv.close(r);
    });
  }
});
