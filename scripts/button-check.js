// The in-page "Download video" button must not sit on top of the page's own controls, and can be closed.
// Real Chromium + the extension, with a stand-in for VDM's local bridge (127.0.0.1:17842).
// Usage: xvfb-run -a node scripts/button-check.js [outDir]
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { PNG } = (() => { try { return require('pngjs'); } catch { return {}; } })();

const root = path.join(__dirname, '..');
const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-btn-'));
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytes = Buffer.alloc(900 * 1024, 1);

(async () => {
  const bridge = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/ping' ? JSON.stringify({ app: 'download-manager', enabled: true, videoButton: true }) : '{"ok":true}');
  });
  await new Promise((r, j) => bridge.once('error', j).listen(17842, '127.0.0.1', r));

  // a light video box with the page's own "Close" and "Details" buttons in its top-right corner (like a media modal)
  const site = http.createServer((req, res) => {
    if (req.url.startsWith('/media/')) {
      res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': bytes.length });
      return res.end(bytes);
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Modal</title></head><body style="margin:0;padding:30px;background:#f4f4f4;font:13px sans-serif">
      <div style="position:relative;width:560px;height:315px;background:#e8e8e8">
        <video id="v" src="/media/a.webm" style="width:560px;height:315px;background:#e8e8e8"></video>
        <button id="details" style="position:absolute;right:56px;top:10px;height:30px;padding:0 12px">OPEN DETAILS</button>
        <button id="close" style="position:absolute;right:10px;top:10px;width:30px;height:30px;border-radius:15px">×</button>
      </div>
      <script>window.clicked=[];for(const id of ['details','close'])document.getElementById(id).addEventListener('click',()=>clicked.push(id));</script>
      </body></html>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;

  const ext = path.join(root, 'extension');
  const browser = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-bc-')), {
    headless: false,
    viewport: { width: 700, height: 420 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let [sw] = browser.serviceWorkers();
  if (!sw) sw = await browser.waitForEvent('serviceworker', { timeout: 10000 });
  const page = await browser.newPage();
  await page.goto(`${base}/`);
  await sleep(1200);

  const results = [];
  const check = (name, ok, extra) => {
    results.push(ok);
    console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(extra));
  };

  // where is the dark button bar? (the page is light, the bar is near-black)
  const bar = async (name) => {
    const file = path.join(out, `${name}.png`);
    await page.screenshot({ path: file });
    const png = PNG.sync.read(fs.readFileSync(file));
    // the bar's colour is a solid dark grey; text in the page's own buttons is thin, so look for wide dark runs
    const dark = (x, y) => {
      const i = (y * png.width + x) * 4;
      return png.data[i] < 70 && png.data[i + 1] < 70 && png.data[i + 2] < 80 && png.data[i] > 5;
    };
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < png.height; y++) {
      let run = 0;
      for (let x = 0; x <= png.width; x++) {
        if (x < png.width && dark(x, y)) run++;
        else {
          if (run >= 80) { if (x - run < x0) x0 = x - run; if (x - 1 > x1) x1 = x - 1; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          run = 0;
        }
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  };

  const vb = await page.locator('#v').boundingBox();
  await page.mouse.move(vb.x + 60, vb.y + 120);
  await page.mouse.move(vb.x + 200, vb.y + 160);
  await sleep(700);
  const b1 = await bar('button');
  check('the button appears', !!b1, b1);
  // the page's own buttons are at the top right: the bar must not overlap them
  const det = await page.locator('#details').boundingBox();
  const overlaps = b1 && !(b1.x + b1.w < det.x || b1.x > vb.x + vb.width || b1.y + b1.h < det.y || b1.y > det.y + det.height);
  check('the button is not on top of the page\'s own buttons', b1 && !overlaps, { b1, det });
  await page.mouse.click(det.x + 10, det.y + 10);
  await page.mouse.click(vb.x + vb.width - 25, vb.y + 25);
  check('the page\'s own buttons still get the clicks', JSON.stringify(await page.evaluate(() => window.clicked)) === '["details","close"]', await page.evaluate(() => window.clicked));

  // close it with ×
  await page.mouse.move(vb.x + 200, vb.y + 160);
  await sleep(700);
  const b2 = await bar('button2');
  await page.mouse.move(b2.x + 20, b2.y + b2.h / 2); // onto the button, so it stays
  await page.mouse.click(b2.x + b2.w - 12, b2.y + b2.h / 2);
  await sleep(300);
  await page.mouse.move(vb.x + 300, vb.y + 200);
  await sleep(900);
  await page.mouse.move(vb.x + 320, vb.y + 220);
  await sleep(600);
  const b3 = await bar('after-close');
  check('× hides the button for that video', !b3, b3);

  // turn it off / on for the site from the toolbar popup setting
  await sw.evaluate(() => chrome.storage.local.set({ hiddenSites: ['127.0.0.1'] }));
  await page.reload();
  await sleep(1500);
  await page.mouse.move(vb.x + 60, vb.y + 120);
  await page.mouse.move(vb.x + 200, vb.y + 160);
  await sleep(800);
  check('button turned off for the site: never shown', !(await bar('site-off')));
  await sw.evaluate(() => chrome.storage.local.set({ hiddenSites: [] }));
  await sleep(800);
  await page.mouse.move(vb.x + 210, vb.y + 170);
  await sleep(800);
  check('turned on again: shown without reloading the page', !!(await bar('site-on')));

  await browser.close();
  bridge.close();
  site.close();
  console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED', out);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
