'use strict';

// The local bridge only accepts downloads from VDM's own browser extension.
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
  const srv = startIntegrationServer({ version: 't', isEnabled: () => true, onDownload: (p) => got.push(p.url) });
  await new Promise((r) => srv.once('listening', r));
  const body = JSON.stringify({ url: 'https://example.com/a.zip' });
  const ours = `chrome-extension://${EXTENSION_IDS[0]}`;
  try {
    assert.strictEqual(await call('POST', '/download', { Origin: ours }, body), 200, 'VDM extension');
    assert.strictEqual(await call('POST', '/download', { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }, body), 403, 'another extension');
    assert.strictEqual(await call('POST', '/download', { Origin: 'https://evil.example' }, body), 403, 'a web page');
    assert.strictEqual(await call('POST', '/download', {}, body), 403, 'no origin');
    assert.strictEqual(await call('POST', '/download', { Origin: ours, Host: 'evil.example:17842' }, body), 403, 'DNS rebinding');
    assert.strictEqual(await call('GET', '/ping'), 200, 'status check from an extension');
    assert.strictEqual(await call('GET', '/ping', { Origin: 'https://evil.example' }), 403, 'status check from a web page');
    assert.deepStrictEqual(got, ['https://example.com/a.zip']);
  } finally {
    srv.close();
  }
});
