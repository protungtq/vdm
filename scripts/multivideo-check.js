// Pages with several videos: the "Download video" button must send the video under the mouse, not another one.
// Real Chromium + the extension, with a stand-in for VDM's local bridge (127.0.0.1:17842) that records what it gets.
// Usage: xvfb-run -a node scripts/multivideo-check.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytes = Buffer.alloc(900 * 1024, 1);

(async () => {
  const received = [];
  const bridge = http.createServer((req, res) => {
    if (req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ app: 'download-manager', enabled: true, videoButton: true }));
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/download') received.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r, j) => bridge.once('error', j).listen(17842, '127.0.0.1', r));

  // Feed of three cards. Card A plays a plain file, card B an HLS-style stream through a blob: URL (like most
  // players), card C is a blob: stream too, but on a page whose cards have no links.
  const card = (n, extra) => `<article style="margin:0 0 20px"><h3>Card ${n}</h3><div style="position:relative;width:320px;height:180px">${extra}</div></article>`;
  const site = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/' || u === '/nolinks') {
      const links = u === '/';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Feed</title></head><body style="margin:0;padding:20px;background:#111;color:#eee;font:14px sans-serif">
        ${card('A', `<video id="a" src="/media/a.webm" style="width:320px;height:180px;background:#000"></video>${links ? '<a href="/watch/a" style="position:absolute;left:0;bottom:0">open A</a>' : ''}`)}
        ${card('B', `<video id="b" style="width:320px;height:180px;background:#222"></video>${links ? '<a href="/watch/b" style="position:absolute;left:0;bottom:0">open B</a>' : ''}`)}
        ${card('C', `<video id="c" style="width:320px;height:180px;background:#333"></video>${links ? '<a href="/watch/c" style="position:absolute;left:0;bottom:0">open C</a>' : ''}`)}
        <script>
          // like hls.js: fetch the playlist, then attach a blob: source to the video
          const attach = async (id, playlist, delay) => { await new Promise(r => setTimeout(r, delay)); await fetch(playlist); await new Promise(r => setTimeout(r, 150));
            document.getElementById(id).src = URL.createObjectURL(new Blob([new Uint8Array(10)], { type: 'video/mp4' })); };
          attach('b', '/hls/b/master.m3u8', 300);
          attach('c', '/hls/c/master.m3u8', 3000);
        </script></body></html>`);
    }
    if (u.endsWith('.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720.m3u8\n');
    }
    if (u.startsWith('/media/')) {
      res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': bytes.length });
      return res.end(bytes);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><title>video page</title></html>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;

  const ext = path.join(root, 'extension');
  const browser = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-mv-')), {
    headless: false,
    viewport: { width: 500, height: 900 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let [sw] = browser.serviceWorkers();
  if (!sw) sw = await browser.waitForEvent('serviceworker', { timeout: 10000 });

  const results = [];
  const click = async (page, id) => {
    received.length = 0;
    const b = await page.locator('#' + id).boundingBox();
    await page.mouse.move(b.x + 40, b.y + 40);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await sleep(500);
    // the button lives in a closed shadow root: click where it is drawn (top-right of the video)
    await page.mouse.click(b.x + b.width - 152 + 40, b.y + 10 + 14);
    for (let i = 0; i < 20 && !received.length; i++) await sleep(150);
    return received[0];
  };
  const check = (name, ok, extra) => {
    results.push(ok);
    console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(extra));
  };

  const page = await browser.newPage();
  await page.goto(`${base}/`);
  await sleep(4500); // all three players have loaded their streams

  let p = await click(page, 'a');
  check('A (plain file): its own file, its own page', p && p.streams[0].url === `${base}/media/a.webm` && p.pageUrl === `${base}/watch/a`, p);
  p = await click(page, 'b');
  check('B (blob): the link to its own page, not A or C', p && p.pageUrl === `${base}/watch/b` && p.streamsFirst === false && !p.streams.some((s) => /\/hls\/c\/|a\.webm/.test(s.url)), p);
  p = await click(page, 'c');
  check('C (blob): the link to its own page', p && p.pageUrl === `${base}/watch/c` && !p.streams.some((s) => /\/hls\/b\/|a\.webm/.test(s.url)), p);

  const page2 = await browser.newPage();
  await page2.goto(`${base}/nolinks`);
  await sleep(4500);
  p = await click(page2, 'b');
  check('no links, B: only the stream that B loaded', p && p.ordered === true && p.streams.length >= 1 && /\/hls\/b\//.test(p.streams[0].url) && !p.streams.some((s) => /\/hls\/c\//.test(s.url)), p);
  p = await click(page2, 'c');
  check('no links, C: only the stream that C loaded', p && /\/hls\/c\//.test(p.streams[0].url) && !p.streams.some((s) => /\/hls\/b\//.test(s.url)), p);

  await browser.close();
  bridge.close();
  site.close();
  console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
