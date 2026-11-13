// End-to-end check of the browser video grabber: real Chromium + extension + VDM
// (with the stand-in yt-dlp). A test page plays a video file and loads an HLS
// playlist; hovering the video shows "Download video"; clicking it must open
// VDM's video dialog with the detected stream.
// Usage: xvfb-run -a node scripts/grabber-check.js <outDir> <fakeToolsDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { chromium, _electron: electron } = require('playwright');

const [out, toolsDir] = process.argv.slice(2).map((p) => path.resolve(p));
const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const blob = Buffer.alloc(900 * 1024, 1); // only the headers matter to the sniffer
  const site = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Silo S01E08 — Watch online</title></head>
        <body style="margin:0;padding:40px;background:#111;color:#eee;font:14px sans-serif">
        <h2>Silo S01E08</h2>
        <div style="position:relative;width:640px;height:360px">
          <video id="v" src="/media/episode.webm" style="width:640px;height:360px;background:#000"></video>
          <div style="position:absolute;inset:0" title="player overlay"></div>
        </div>
        <script>fetch('/hls/master.m3u8').then(r => r.text());</script>
        </body></html>`);
    }
    if (req.url === '/hls/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\n720.m3u8\n');
    }
    if (req.url.startsWith('/media/')) {
      res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': blob.length });
      return res.end(blob);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-g-'));
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ notifications: false, clipboardWatch: false, showProgressWindow: false }));
  const app = await electron.launch({ executablePath: require('electron'), args: [root, '--no-sandbox'], env: { ...process.env, DM_USER_DATA: ud, DM_DOWNLOADS: path.join(ud, 'D'), DM_TOOLS_DIR: toolsDir } });
  const main = await app.firstWindow();
  await main.waitForLoadState('domcontentloaded');
  await sleep(800);

  const ext = path.join(root, 'extension');
  const browser = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-chrome-')), {
    headless: false,
    viewport: { width: 760, height: 520 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let [sw] = browser.serviceWorkers();
  if (!sw) sw = await browser.waitForEvent('serviceworker', { timeout: 10000 });
  const page = await browser.newPage();
  await page.goto(base + '/');
  await sleep(1500);

  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({}))[0 + (await chrome.tabs.query({})).length - 1].id);
  const found = await sw.evaluate(async (id) => (await chrome.storage.session.get(`media:${id}`))[`media:${id}`] || [], tabId);
  console.log('sniffed:', found.map((x) => `${x.kind}:${x.url.replace(base, '')}`).join(', '));
  console.log('badge:', await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId));

  // hover the video (through the player overlay) -> the button appears top-right
  const box = await page.locator('#v').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(400);
  await page.screenshot({ path: `${out}/browser-video-button.png` });

  const before = (await app.windows()).length;
  await page.mouse.move(box.x + box.width - 152 + 60, box.y + 10 + 15);
  await sleep(150);
  await page.mouse.click(box.x + box.width - 152 + 60, box.y + 10 + 15);
  let dlg;
  for (let i = 0; i < 80 && !dlg; i++) {
    await sleep(100);
    const ws = await app.windows();
    if (ws.length > before) dlg = ws[ws.length - 1];
  }
  if (!dlg) throw new Error('VDM did not open the video dialog');
  await dlg.waitForSelector('#mediaReady:not([hidden])', { timeout: 15000 });
  await sleep(500);
  console.log('dialog title field:', await dlg.inputValue('#mediaTitle'));
  console.log('dialog meta:', await dlg.textContent('#mediaMeta'));
  await page.screenshot({ path: `${out}/browser-video-button-sent.png` });
  await dlg.screenshot({ path: `${out}/video-dialog-from-browser.png` });
  await dlg.click('#mediaDownload');
  await sleep(2500);
  const list = await main.evaluate(() => window.api.invoke('downloads:list'));
  console.log('download:', list.map((d) => `${d.status} ${d.filename} <- ${d.url.replace(base, '')}`).join(' | '));
  await browser.close();
  await app.close();
  site.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
