// End-to-end: real Chromium with the extension + the real app. Clicking a
// download link in the browser must open the app's "Download File Info" window.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { chromium, _electron: electron } = require('playwright');
const { makeData } = require('../test/helpers');

const root = path.join(__dirname, '..');
const out = path.resolve(process.argv[2] || 'shots');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const data = makeData(4 * 1024 * 1024, 3);
  const site = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><body><h1>Files</h1><a id="dl" href="/get/Silo.S01E07.720p.10bit.WEB-DL.2CH.x265.HEVC.NightMovie.mkv">Download episode</a></body></html>');
    }
    if (req.url.startsWith('/get/')) {
      res.writeHead(200, {
        'Content-Type': 'video/x-matroska',
        'Content-Length': data.length,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename="${req.url.split('/').pop()}"`,
      });
      return res.end(data);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-ext-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ notifications: false, clipboardWatch: false }));
  const app = await electron.launch({ executablePath: require('electron'), args: [root, '--no-sandbox'], env: { ...process.env, DM_USER_DATA: userData, DM_DOWNLOADS: path.join(userData, 'dl') } });
  await app.firstWindow();
  await sleep(800);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-chrome-'));
  const ext = path.join(root, 'extension');
  const browser = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    acceptDownloads: true,
  });
  let [sw] = browser.serviceWorkers();
  if (!sw) sw = await browser.waitForEvent('serviceworker', { timeout: 10000 });
  console.log('extension loaded:', sw.url().split('/')[2]);
  const page = await browser.newPage();
  await page.goto(base + '/');
  const before = (await app.windows()).length;
  await page.click('#dl');
  let dlg;
  for (let i = 0; i < 80 && !dlg; i++) {
    await sleep(100);
    const ws = await app.windows();
    if (ws.length > before) dlg = ws[ws.length - 1];
  }
  if (!dlg) throw new Error('app did not open a window for the browser download');
  await dlg.waitForSelector('#paneInfo:not([hidden])');
  await sleep(1200);
  const name = await dlg.inputValue('#infoName');
  const size = await dlg.textContent('#infoSize');
  console.log('app caught download:', name, '|', size);
  await dlg.screenshot({ path: path.join(out, 'browser-capture.png') });
  // browser download list should be empty (it was cancelled + erased)
  const browserDownloads = await sw.evaluate(() => new Promise((r) => chrome.downloads.search({}, (l) => r(l.map((d) => d.state)))));
  console.log('browser download entries left:', JSON.stringify(browserDownloads));
  await dlg.click('#infoDownload');
  await sleep(1500);
  const list = await (await app.firstWindow()).evaluate(() => window.api.invoke('downloads:list'));
  console.log(list.map((d) => `${d.status} ${d.filename} ${d.downloaded}/${d.size}`).join('\n'));
  await browser.close();
  await app.close();
  site.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
