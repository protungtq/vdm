// Takes the screenshots used in README.md (docs/screenshots/). Everything is local:
// files come from a test HTTP server and yt-dlp is the stand-in test double.
// Usage: xvfb-run -a node scripts/readme-shots.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { _electron: electron, chromium } = require('playwright');
const { makeData, startServer } = require('../test/helpers');

const root = path.join(__dirname, '..');
const out = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// stand-in tools folder (yt-dlp test double + dummy ffmpeg)
const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-tools-'));
fs.copyFileSync(path.join(root, 'test/fixtures/fake-ytdlp.js'), path.join(tools, 'yt-dlp'));
fs.chmodSync(path.join(tools, 'yt-dlp'), 0o755);
fs.writeFileSync(path.join(tools, 'ffmpeg'), '');

async function launch(theme = 'light') {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-shots-'));
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ theme, notifications: false, clipboardWatch: false, showProgressWindow: false, connections: 8, videoQuality: '1080', lastSeenVersion: require('../package.json').version }));
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [root, '--no-sandbox', '--force-device-scale-factor=2'],
    env: { ...process.env, DM_USER_DATA: ud, DM_DOWNLOADS: path.join(ud, 'Downloads'), DM_TOOLS_DIR: tools },
  });
  const main = await app.firstWindow();
  await main.waitForLoadState('domcontentloaded');
  await sleep(700);
  return { app, main };
}

async function newWindow(app, action) {
  const n = (await app.windows()).length;
  await action();
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    const ws = await app.windows();
    if (ws.length > n) {
      const w = ws[ws.length - 1];
      await w.waitForLoadState('domcontentloaded');
      await sleep(300);
      return w;
    }
  }
  throw new Error('window did not open');
}

// Show Windows-style paths and a neutral host instead of the test machine's temp folders.
const cosmetic = (page) =>
  page.evaluate(() => {
    const fix = (t) =>
      t
        .replace(/\/tmp\/vdm-shots-[^/\s]+\/Downloads([^\s]*)/g, (_, rest) => 'C:\\Users\\You\\Downloads' + rest.replace(/\//g, '\\'))
        .replace(/http:\/\/127\.0\.0\.1:\d+\/file\//g, 'https://dl.example.com/')
        .replace(/^127\.0\.0\.1$/, 'dl.example.com');
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) if (/vdm-shots|127\.0\.0\.1/.test(w.currentNode.nodeValue)) w.currentNode.nodeValue = fix(w.currentNode.nodeValue);
    for (const i of document.querySelectorAll('input')) if (/vdm-shots|127\.0\.0\.1/.test(i.value)) i.value = fix(i.value);
  }).catch(() => {});

const shot = async (page, name) => {
  await page.mouse.move(1, 1).catch(() => {});
  await cosmetic(page);
  await sleep(250);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log('saved', name);
};

(async () => {
  const slow = await startServer(makeData(64 * 1024 * 1024, 5), { bytesPerSec: 260 * 1024 });
  const fast = await startServer(makeData(3 * 1024 * 1024, 9));
  let { app, main } = await launch('day');
  const add = (o) => main.evaluate((x) => window.api.invoke('downloads:add', x), o);
  const act = (id, action) => main.evaluate((x) => window.api.invoke('downloads:action', x), { id, action });

  await add({ url: `${fast.base}/file/Ubuntu-24.04-desktop-amd64.iso`, mode: 'now' });
  await add({ url: `${fast.base}/file/Podcast.Episode.112.mp3`, mode: 'now' });
  await sleep(1500);
  const a = await add({ url: `${slow.base}/file/Fast.X.2023.720p.WEB-DL.x265.SoftSub.mkv`, mode: 'now' });
  const b = await add({ url: `${slow.base}/file/Silo.S01E07.720p.10bit.WEB-DL.x265.mkv`, mode: 'now' });
  await add({ url: `${slow.base}/file/Blender-4.2-windows-x64.zip`, mode: 'now' });
  await sleep(3500);
  await act(b.id, 'pause');
  await sleep(1200);
  await shot(main, 'main-light');

  await main.click('[data-view-mode="compact"]');
  await sleep(400);
  await shot(main, 'main-compact');
  await main.click('[data-view-mode="cards"]');

  // every theme on the same list
  for (const t of ['light', 'dark', 'day', 'night', 'paper', 'mint', 'ocean', 'neon', 'jungle', 'retro']) {
    await main.evaluate((theme) => window.api.invoke('settings:set', { theme }), t);
    await sleep(500);
    await shot(main, `theme-${t}`);
  }
  await main.evaluate(() => window.api.invoke('settings:set', { theme: 'day' }));
  await sleep(400);

  // queue + scheduler
  for (const n of ['Windows11_24H2_x64.iso', 'Android.Studio.2025.dmg', 'Lecture.07.Algorithms.mp4']) await add({ url: `http://127.0.0.1:9/later/${n}`, filename: n, mode: 'queue' });
  await main.click('.nav-item[data-view="scheduled"]');
  await sleep(500);
  await shot(main, 'queue');

  await main.click('.nav-item[data-view="settings"]');
  await sleep(500);
  await shot(main, 'settings');
  // proxy settings: manual proxy filled in so the fields are visible
  await main.evaluate(() => window.api.invoke('settings:set', { proxy: { mode: 'manual', type: 'socks5', host: '127.0.0.1', port: 1080, username: '', password: '' } }));
  await sleep(500);
  await main.evaluate(() => document.getElementById('set-proxy').scrollIntoView({ block: 'start' }));
  await sleep(500);
  await shot(main, 'settings-proxy');
  await main.evaluate(() => window.api.invoke('settings:set', { proxy: { mode: 'none' } }));
  await main.click('.nav-item[data-view="all"]');
  // "What's new" window
  const wn = await newWindow(app, () => main.evaluate(() => window.api.invoke('whatsnew:open')));
  await sleep(500);
  await shot(wn, 'whats-new');
  await wn.close().catch(() => {});

  // add link -> file info
  let d = await newWindow(app, () => main.click('#addLink'));
  await d.fill('#address', `${slow.base}/file/Silo.S01E08.1080p.WEB-DL.x265.mkv`);
  await d.click('#addOk');
  await d.waitForSelector('#paneInfo:not([hidden])', { timeout: 15000 });
  await sleep(700);
  await shot(d, 'dialog-info');
  await d.click('#infoDownload');

  // progress window with the connection map
  const p = await newWindow(app, () => act(a.id, 'progress'));
  await sleep(1500);
  await p.click('#detailsBtn');
  await sleep(1800);
  await shot(p, 'progress-details');
  await p.close().catch(() => {});

  // video downloader
  d = await newWindow(app, () => main.click('#addLink'));
  await d.fill('#address', 'https://www.youtube.com/watch?v=Silo-trailer');
  await d.click('#addOk');
  await d.waitForSelector('#mediaReady:not([hidden])', { timeout: 15000 });
  await sleep(600);
  await shot(d, 'video-dialog');
  await d.close().catch(() => {});

  // batch / pattern downloads
  d = await newWindow(app, () => main.click('#addLink'));
  await d.fill('#address', `${slow.base}/file/Silo.S01.part[01-06].rar`);
  await d.click('#addOk');
  await d.waitForSelector('#paneBatch:not([hidden])', { timeout: 5000 });
  await sleep(400);
  await shot(d, 'batch-dialog');
  await d.close().catch(() => {});

  // dark hero
  await main.evaluate(() => window.api.invoke('settings:set', { theme: 'dark' }));
  await sleep(600);
  await shot(main, 'main-dark');
  await app.close();

  // browser: video button + extension popup
  ({ app, main } = await launch('day'));
  const site = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Silo S01E08 - Watch online</title></head>
        <body style="margin:0;overflow:hidden;padding:32px 40px;background:#141414;color:#eee;font:15px system-ui,sans-serif">
        <h2 style="margin:0 0 16px">Silo S01E08</h2>
        <div style="position:relative;width:640px;height:360px;border-radius:10px;overflow:hidden;background:linear-gradient(135deg,#2b3a4a,#0e1116)">
          <video id="v" src="/media/episode.webm" style="width:640px;height:360px"></video>
          <svg viewBox="0 0 24 24" width="72" height="72" style="position:absolute;left:284px;top:144px;opacity:.85"><circle cx="12" cy="12" r="12" fill="rgba(255,255,255,.18)"/><path d="M9.5 7.5v9l7-4.5z" fill="#fff"/></svg>
          <div style="position:absolute;left:0;right:0;bottom:0;height:6px;background:rgba(255,255,255,.15)"><div style="width:34%;height:100%;background:#e53935"></div></div>
          <div style="position:absolute;inset:0"></div>
        </div><script>fetch('/hls/master.m3u8')</script></body></html>`);
    }
    if (req.url === '/hls/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\n720.m3u8\n');
    }
    if (req.url.startsWith('/media/')) {
      res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': 900 * 1024 });
      return res.end(Buffer.alloc(900 * 1024, 1));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const ext = path.join(root, 'extension');
  const browser = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-chrome-')), {
    headless: false,
    viewport: { width: 720, height: 450 },
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let [sw] = browser.serviceWorkers();
  if (!sw) sw = await browser.waitForEvent('serviceworker', { timeout: 10000 });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${site.address().port}/`);
  await sleep(1500);
  const box = await page.locator('#v').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(500);
  await page.screenshot({ path: path.join(out, 'browser-button.png') });
  console.log('saved browser-button');

  // popup, opened as a page so it can be captured (tab id of the video page is passed in)
  const extId = sw.url().split('/')[2];
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1/*' }))[0].id);
  const pop = await browser.newPage();
  await pop.setViewportSize({ width: 322, height: 470 });
  await pop.addInitScript((id) => {
    const q = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (o) => (o && o.active ? [{ id }] : q(o));
  }, tabId);
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await sleep(1200);
  const h = await pop.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
  await pop.setViewportSize({ width: 322, height: h });
  await sleep(200);
  await pop.screenshot({ path: path.join(out, 'browser-popup.png') });
  console.log('saved browser-popup');
  await browser.close();
  await app.close();
  site.close();

  // themes collage
  const b2 = await chromium.launch();
  const cp = await b2.newPage({ viewport: { width: 1600, height: 100 }, deviceScaleFactor: 1 });
  const names = { light: 'Light', dark: 'Dark', day: 'Day', night: 'Night', paper: 'Paper', mint: 'Mint', ocean: 'Ocean', neon: 'Neon', jungle: 'Jungle', retro: 'Retro 95' };
  const cells = Object.entries(names)
    .map(([k, n]) => `<figure><img src="data:image/png;base64,${fs.readFileSync(path.join(out, `theme-${k}.png`)).toString('base64')}"><figcaption>${n}</figcaption></figure>`)
    .join('');
  await cp.setContent(`<style>body{margin:0;padding:28px;background:#f3f3f5;font:600 22px system-ui,sans-serif;color:#333}
    .g{display:grid;grid-template-columns:repeat(5,1fr);gap:24px}figure{margin:0}img{width:100%;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.18)}
    figcaption{text-align:center;margin-top:10px}</style><div class="g">${cells}</div>`);
  await sleep(300);
  await cp.screenshot({ path: path.join(out, 'themes.png'), fullPage: true });
  await b2.close();
  for (const k of Object.keys(names)) fs.rmSync(path.join(out, `theme-${k}.png`));
  console.log('saved themes');
  slow.server.close();
  fast.server.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
