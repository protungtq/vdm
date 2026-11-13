'use strict';

const http = require('http');

const PORT = 17842;
/**
 * Only VDM's own extension may talk to the app. Its ID is fixed by the "key" in
 * extension/manifest.json (the same on every computer); add the Chrome Web Store / Edge Add-ons
 * IDs here once the extension is published there.
 */
const EXTENSION_IDS = ['dkjdefoooidmkpekcnlllfichlmokncd'];
const ALLOWED_ORIGINS = new Set(EXTENSION_IDS.flatMap((id) => [`chrome-extension://${id}`, `extension://${id}`]));

/**
 * Local bridge for the browser extension (127.0.0.1 only).
 *   GET  /ping       -> { app, version, enabled }
 *   POST /download   -> { url | urls[], filename?, referrer?, cookies?, userAgent?, size? }
 * Only requests from VDM's own browser extension are accepted (see ALLOWED_ORIGINS).
 */
function startIntegrationServer({ version, isEnabled, onDownload, extra = () => ({}) }) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    const host = String(req.headers.host || '');
    // Only VDM's extension may send downloads: browsers always attach the extension's Origin to a
    // POST, and no web page or other extension can fake it. A plain GET /ping ("is VDM running?",
    // nothing private) arrives without an Origin from extensions and is allowed; any request that
    // does carry a foreign Origin (a web page, another extension) is refused. The Host check blocks
    // DNS rebinding.
    const pingOnly = req.method === 'GET' && req.url === '/ping' && !origin;
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || !(ALLOWED_ORIGINS.has(origin) || pingOnly)) {
      res.writeHead(403);
      return res.end();
    }
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type' } : {};
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST' });
      return res.end();
    }
    if (req.method === 'GET' && req.url === '/ping') return json(200, { app: 'download-manager', version, enabled: isEnabled(), ...extra() });
    if (req.method === 'POST' && req.url === '/download') {
      if (!/application\/json/.test(req.headers['content-type'] || '')) return json(415, { error: 'json required' });
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 2_000_000) req.destroy();
      });
      req.on('end', () => {
        if (!isEnabled()) return json(503, { error: 'integration disabled' });
        let p;
        try {
          p = JSON.parse(body);
        } catch {
          return json(400, { error: 'bad json' });
        }
        const valid = (u) => typeof u === 'string' && /^https?:\/\//i.test(u) && u.length < 8192;
        const urls = Array.isArray(p.urls) ? p.urls.filter(valid).slice(0, 500) : [];
        if (p.media) {
          // "Download this video": page URL plus any streams the extension saw
          const streams = Array.isArray(p.streams) ? p.streams.filter((x) => x && valid(x.url)).slice(0, 30) : [];
          if (!valid(p.pageUrl) && !streams.length) return json(400, { error: 'bad url' });
          onDownload({
            media: true,
            pageUrl: valid(p.pageUrl) ? p.pageUrl : '',
            frameUrl: valid(p.frameUrl) ? p.frameUrl : '',
            title: typeof p.title === 'string' ? p.title.slice(0, 300) : '',
            streams: streams.map((x) => ({ url: x.url, kind: String(x.kind || '').slice(0, 10), size: Number(x.size) || -1 })),
            referrer: typeof p.referrer === 'string' ? p.referrer.slice(0, 4096) : '',
            cookies: typeof p.cookies === 'string' ? p.cookies.slice(0, 16384) : '',
            userAgent: typeof p.userAgent === 'string' ? p.userAgent.slice(0, 512) : '',
          });
          return json(200, { ok: true });
        }
        if (!valid(p.url) && !urls.length) return json(400, { error: 'bad url' });
        onDownload({
          url: valid(p.url) ? p.url : undefined,
          urls,
          filename: typeof p.filename === 'string' ? p.filename.slice(0, 260) : '',
          referrer: typeof p.referrer === 'string' ? p.referrer.slice(0, 4096) : '',
          cookies: typeof p.cookies === 'string' ? p.cookies.slice(0, 16384) : '',
          userAgent: typeof p.userAgent === 'string' ? p.userAgent.slice(0, 512) : '',
          size: Number(p.size) > 0 ? Number(p.size) : -1,
        });
        json(200, { ok: true });
      });
      return;
    }
    json(404, { error: 'not found' });
  });
  server.on('error', (e) => console.error('[integration] server error:', e.message));
  server.listen(PORT, '127.0.0.1');
  return server;
}

module.exports = { startIntegrationServer, PORT, EXTENSION_IDS };
