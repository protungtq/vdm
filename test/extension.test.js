'use strict';

// Runs the browser extension's background script against a stand-in `chrome` API and checks which
// browser downloads are handed to VDM. Regression test: when the browser starts, it reports the
// downloads in its history too, and those must not open VDM windows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadExtension() {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  const store = {};
  const sent = [];
  const sentBodies = [];
  let scriptResult = [];
  const chrome = {
    runtime: { id: 'vdm-ext', onInstalled: on('installed'), onMessage: on('message'), onStartup: on('startup') },
    downloads: {
      onCreated: on('created'),
      onChanged: on('changed'),
      cancel: async () => {},
      erase: async () => {},
      download: () => {},
      search: async () => [],
    },
    storage: {
      local: {
        get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : k && typeof k === 'object' ? { ...k, ...store } : { ...store }),
        set: async (o) => Object.assign(store, o),
      },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: on('storage'),
    },
    cookies: { getAll: async ({ url = '' } = {}) => (url.includes('://a.com/') ? [{ name: 'session', value: 'A-SECRET' }] : []) },
    contextMenus: { create: () => {}, removeAll: (cb) => cb && cb(), onClicked: on('menu') },
    tabs: { onRemoved: on('tabRemoved'), onUpdated: on('tabUpdated'), query: async () => [], sendMessage: async () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {} },
    webRequest: { onHeadersReceived: on('headers'), onBeforeRequest: on('before') },
    scripting: { executeScript: async () => scriptResult },
  };
  const fetch = async (url, opts = {}) => {
    if (url.endsWith('/ping')) return { ok: true, json: async () => ({ app: 'download-manager', enabled: true }) };
    const body = JSON.parse(opts.body);
    sentBodies.push(body);
    sent.push(body.url);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const ctx = { importScripts: (f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8'), ctx), chrome, fetch, navigator: { userAgent: 'test' }, console, setTimeout, clearTimeout, AbortController, URL, Date, Promise, JSON, Math, Set, Map };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8'), ctx);
  return { created: listeners.created, sent, sentBodies, menu: listeners.menu, setScriptResult: (v) => (scriptResult = v) };
}

const item = (id, over = {}) => ({
  id,
  url: `https://example.com/file${id}.zip`,
  state: 'in_progress',
  startTime: new Date().toISOString(),
  totalBytes: 50 * 1024 * 1024,
  mime: 'application/zip',
  filename: '',
  ...over,
});

test('a new browser download is handed to VDM once', async () => {
  const ext = loadExtension();
  await ext.created(item(1));
  await ext.created(item(1)); // the browser reporting the same download again
  assert.deepStrictEqual(ext.sent, ['https://example.com/file1.zip']);
});

test('downloads from the browser history are ignored when the browser starts', async () => {
  const ext = loadExtension();
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  await ext.created(item(2, { state: 'complete', startTime: yesterday }));
  await ext.created(item(3, { state: 'interrupted', startTime: yesterday }));
  await ext.created(item(4, { state: 'in_progress', startTime: yesterday })); // resumed old download
  await ext.created(item(5, { startTime: undefined }));
  assert.deepStrictEqual(ext.sent, []);
  await ext.created(item(6));
  assert.deepStrictEqual(ext.sent, ['https://example.com/file6.zip'], 'a real new download still works');
});

test('download-all sends the first link\'s cookies only when every link shares its host', async () => {
  const ext = loadExtension();
  const tab = { id: 7, url: 'https://a.com/page' };
  ext.setScriptResult([{ result: ['https://a.com/one.zip', 'https://a.com/two.zip'] }]);
  await ext.menu({ menuItemId: 'dm-all' }, tab);
  assert.strictEqual(ext.sentBodies.length, 1);
  assert.strictEqual(ext.sentBodies[0].cookies, 'session=A-SECRET');

  ext.setScriptResult([{ result: ['https://a.com/one.zip', 'https://b.com/two.zip'] }]);
  await ext.menu({ menuItemId: 'dm-all' }, tab);
  assert.strictEqual(ext.sentBodies.length, 2);
  assert.strictEqual(ext.sentBodies[1].cookies, '', 'cookies of one site must not ride along to another');
});
