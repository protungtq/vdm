// Checks the "Download complete" window: the progress window closes, a separate window opens on top.
// Usage: xvfb-run -a node scripts/complete-check.js [outDir]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const { makeData, startServer } = require('../test/helpers');

const root = path.join(__dirname, '..');
const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-complete-'));
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = await startServer(makeData(20 * 1024 * 1024, 3), { bytesPerSec: 400 * 1024 });
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-cp-'));
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ notifications: false, clipboardWatch: false, lastSeenVersion: require('../package.json').version }));
  const app = await electron.launch({ executablePath: require('electron'), args: [root, '--no-sandbox', '--force-device-scale-factor=2'], env: { ...process.env, DM_USER_DATA: ud, DM_DOWNLOADS: path.join(ud, 'Downloads') } });
  const main = await app.firstWindow();
  await main.waitForLoadState('domcontentloaded');
  await sleep(800);
  const titles = async () => Promise.all((await app.windows()).map((w) => w.url().split('/').pop().split('?')[0]));

  const dl = await main.evaluate((u) => window.api.invoke('downloads:add', { url: u, mode: 'now' }), `${srv.base}/file/Silo.S01E08.1080p.mkv`);
  await sleep(1500);
  console.log('while downloading:', await titles());
  let pages = [];
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    pages = await titles();
    if (pages.includes('complete.html')) break;
  }
  console.log('after completion:', pages);
  const ok = pages.includes('complete.html') && !pages.includes('progress.html');
  const win = (await app.windows()).find((w) => w.url().includes('complete.html'));
  await sleep(600);
  const onTop = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('complete.html')).map((w) => ({ top: w.isAlwaysOnTop(), focused: w.isFocused(), visible: w.isVisible() })));
  console.log('complete window:', JSON.stringify(onTop));
  if (win) await win.screenshot({ path: path.join(out, 'complete.png') });
  console.log(ok && onTop[0] && onTop[0].top && onTop[0].visible ? 'PASS' : 'FAIL', out);
  await app.close();
  srv.server.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
