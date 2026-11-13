// Dev check for video + batch features. Uses a stand-in yt-dlp (test/fixtures/fake-ytdlp.js)
// via DM_TOOLS_DIR, so no external programs or sites are involved.
// Usage: xvfb-run -a node scripts/video-check.js <outDir> <fakeToolsDir> <emptyToolsDir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const { makeData, startServer } = require('../test/helpers');

const [out, fakeTools, emptyTools] = process.argv.slice(2).map((p) => path.resolve(p));
const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(toolsDir, theme = 'light') {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'vdm-v-'));
  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ theme, notifications: false, clipboardWatch: false, showProgressWindow: false, videoQuality: '720' }));
  const app = await electron.launch({ executablePath: require('electron'), args: [root, '--no-sandbox'], env: { ...process.env, DM_USER_DATA: ud, DM_DOWNLOADS: path.join(ud, 'D'), DM_TOOLS_DIR: toolsDir } });
  const main = await app.firstWindow();
  await main.waitForLoadState('domcontentloaded');
  await sleep(600);
  return { app, main };
}

async function openAdd(app, main) {
  const n = (await app.windows()).length;
  await main.click('#addLink');
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const ws = await app.windows();
    if (ws.length > n) {
      const d = ws[ws.length - 1];
      await d.waitForLoadState('domcontentloaded');
      await sleep(250);
      return d;
    }
  }
  throw new Error('no dialog');
}

(async () => {
  const srv = await startServer(makeData(3 * 1024 * 1024, 2), { bytesPerSec: 400 * 1024 });

  // 1) video page with tools installed
  let { app, main } = await launch(fakeTools);
  let d = await openAdd(app, main);
  await d.fill('#address', 'https://www.youtube.com/watch?v=Silo-trailer');
  await d.click('#addOk');
  await d.waitForSelector('#mediaReady:not([hidden]), #mediaError:not([hidden]), #mediaInstall:not([hidden])', { timeout: 15000 });
  console.log('state:', await d.evaluate(() => ['mediaLoading','mediaInstall','mediaError','mediaReady'].filter((id) => !document.getElementById(id).hidden).join(), ), '|', await d.textContent('#mediaErrorText'));
  await sleep(400);
  console.log('options:', (await d.$$eval('.q-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')))).join(' | '));
  console.log('preselected:', await d.$eval('.q-row.on .q-label', (e) => e.textContent), '(setting: 720)');
  await d.screenshot({ path: `${out}/video-dialog.png` });
  await d.click('.q-row >> nth=0');
  await d.click('#mediaDownload');
  await sleep(500);
  await main.mouse.move(5, 470);
  await sleep(300);
  await main.screenshot({ path: `${out}/video-in-list.png` });
  let list;
  for (let i = 0; i < 60; i++) {
    list = await main.evaluate(() => window.api.invoke('downloads:list'));
    if (list[0] && list[0].status === 'completed') break;
    await sleep(200);
  }
  console.log('video download:', list[0].status, list[0].filename, list[0].category, list[0].error || '');

  // 2) several links via a range pattern
  d = await openAdd(app, main);
  await d.fill('#address', `${srv.base}/file/Silo.S01.part[01-05].rar`);
  await d.click('#addOk');
  await d.waitForSelector('#paneBatch:not([hidden])', { timeout: 5000 });
  await d.click('.b-row >> nth=2'); // untick one
  await sleep(200);
  console.log('batch:', await d.textContent('#batchCount'), '|', await d.textContent('#batchStatus'));
  await d.screenshot({ path: `${out}/batch-dialog.png` });
  await d.click('#batchStart');
  await sleep(1500);
  list = await main.evaluate(() => window.api.invoke('downloads:list'));
  console.log('queued parts:', list.filter((x) => /part0/.test(x.filename)).map((x) => `${x.filename}:${x.status}`).join(', '));
  await main.click('.nav-item[data-view="settings"]');
  await sleep(300);
  await main.evaluate(() => document.querySelector('#set-video').scrollIntoView());
  await sleep(300);
  await main.screenshot({ path: `${out}/settings-video.png` });
  await app.close();

  // 3) not installed yet -> install prompt
  ({ app, main } = await launch(emptyTools, 'dark'));
  d = await openAdd(app, main);
  await d.fill('#address', 'https://x.com/someone/status/123');
  await d.click('#addOk');
  await d.waitForSelector('#mediaInstall:not([hidden])', { timeout: 10000 });
  await sleep(300);
  await d.screenshot({ path: `${out}/video-install.png` });
  await app.close();
  srv.server.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
