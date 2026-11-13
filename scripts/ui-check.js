// Launches the real Electron app (under Xvfb on Linux), drives it, and saves
// screenshots of every window for comparison with the Figma design.
// Usage: xvfb-run -a node scripts/ui-check.js <outDir> [light|dark]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const { makeData, startServer } = require('../test/helpers');

const root = path.join(__dirname, '..');
const out = path.resolve(process.argv[2] || 'shots');
const theme = process.argv[3] || 'light';
fs.mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Every app interaction gets a deadline so a stall reports *where* it happened.
const T = (name, p, ms = 15000) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`step timed out: ${name}`)), ms))]).then((v) => {
    console.log('ok', name);
    return v;
  });

(async () => {
  const data = makeData(48 * 1024 * 1024, 5);
  const slow = await startServer(data, { bytesPerSec: 220 * 1024 });
  const fast = await startServer(makeData(3 * 1024 * 1024, 9));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-ui-'));
  const downloads = path.join(userData, 'Downloads');
  fs.mkdirSync(downloads);
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ theme, showProgressWindow: false, notifications: false, clipboardWatch: false, connections: 8 })
  );

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [root, '--no-sandbox'],
    env: { ...process.env, DM_USER_DATA: userData, DM_DOWNLOADS: downloads },
  });
  app.process().stderr.on('data', (d) => process.stderr.write(`[electron] ${d}`));
  console.log('launched');
  const main = await app.firstWindow();
  console.log('got window');
  await main.waitForLoadState('domcontentloaded');
  await sleep(600);
  const shot = async (page, name) => {
    await T(`shot ${name}`, page.screenshot({ path: path.join(out, `${name}.png`) }));
    console.log('saved', name);
  };
  const add = (opts) => T(`add ${opts.url.split('/').pop()}`, main.evaluate((o) => window.api.invoke('downloads:add', o), opts));

  console.log('seeding');
  // Seed a realistic list (mirrors the Figma mock)
  await add({ url: `${fast.base}/file/Fast.X.2023.720p.WEB-DL.x265.SoftSub.NightMovie.mkv`, mode: 'now' });
  await add({ url: `${fast.base}/file/Fast.X.2023.720p.WEB-DL.x265.Dubbed.Audio.NightMovie.mp3`, mode: 'now' });
  await sleep(1500);
  const a = await add({ url: `${slow.base}/file/Fast.X.2023.720p.WEB-DL.x265.SoftSub.NightMovie.mkv`, mode: 'now', filename: 'Fast.X.2023.720p.WEB-DL.x265.SoftSub.NightMovie.mkv', filenameLocked: true });
  const b = await add({ url: `${slow.base}/file/Silo.S01E07.720p.10bit.WEB-DL.2CH.x265.HEVC.NightMovie.mkv`, mode: 'now' });
  const c = await add({ url: `${slow.base}/file/Fast.X.2023.720p.WEB-DL.x265.subtitle.zip`, mode: 'now' });
  await sleep(3500);
  await T('pause b', main.evaluate((id) => window.api.invoke('downloads:action', { id, action: 'pause' }), b.id));
  await sleep(1200);
  await shot(main, `main-${theme}`);

  // Compact list view
  await main.click('[data-view-mode="compact"]');
  await sleep(400);
  await shot(main, `main-compact-${theme}`);
  await main.click('[data-view-mode="cards"]');
  await sleep(300);

  // Scheduled + Settings views
  await main.evaluate(() => window.api.invoke('downloads:add', { url: 'http://127.0.0.1:9/later/ubuntu-24.04-desktop-amd64.iso', mode: 'queue', filename: 'ubuntu-24.04-desktop-amd64.iso' }));
  await main.click('.nav-item[data-view="scheduled"]');
  await sleep(400);
  await shot(main, `main-scheduled-${theme}`);
  await main.click('.nav-item[data-view="settings"]');
  await sleep(400);
  await shot(main, `main-settings-${theme}`);
  await main.click('.nav-item[data-view="all"]');

  // Add Link dialog -> info
  const winCount = (await app.windows()).length;
  await main.click('#addLink');
  let dialogPage;
  for (let i = 0; i < 50 && !dialogPage; i++) {
    await sleep(100);
    const ws = await app.windows();
    if (ws.length > winCount) dialogPage = ws[ws.length - 1];
  }
  await dialogPage.waitForLoadState('domcontentloaded');
  await sleep(300);
  await dialogPage.fill('#address', `${slow.base}/file/Silo.S01E07.720p.10bit.WEB-DL.2CH.x265.HEVC.NightMovie.mkv`);
  await shot(dialogPage, `dialog-add-${theme}`);
  await dialogPage.click('#addOk');
  await dialogPage.waitForSelector('#paneInfo:not([hidden])', { timeout: 15000 });
  await sleep(700);
  await shot(dialogPage, `dialog-info-${theme}`);
  await dialogPage.click('#infoDownload');
  await sleep(300);

  // Progress window for a running download
  const before = (await app.windows()).length;
  await main.evaluate((id) => window.api.invoke('downloads:action', { id, action: 'progress' }), a.id);
  let prog;
  for (let i = 0; i < 50 && !prog; i++) {
    await sleep(100);
    const ws = await app.windows();
    if (ws.length > before) prog = ws[ws.length - 1];
  }
  await prog.waitForLoadState('domcontentloaded');
  await sleep(1500);
  await shot(prog, `progress-${theme}`);
  await prog.click('#detailsBtn');
  await sleep(1500);
  await shot(prog, `progress-details-${theme}`);
  await prog.click('#toggle');
  await sleep(1200);
  await shot(prog, `progress-paused-${theme}`);

  // Completed state
  const before2 = (await app.windows()).length;
  const done = (await main.evaluate(() => window.api.invoke('downloads:list'))).find((d) => d.status === 'completed');
  await main.evaluate((id) => window.api.invoke('downloads:action', { id, action: 'progress' }), done.id);
  let prog2;
  for (let i = 0; i < 50 && !prog2; i++) {
    await sleep(100);
    const ws = await app.windows();
    if (ws.length > before2) prog2 = ws[ws.length - 1];
  }
  await sleep(800);
  await shot(prog2, `progress-complete-${theme}`);

  await sleep(500);
  await shot(main, `main-after-${theme}`);
  const list = await main.evaluate(() => window.api.invoke('downloads:list'));
  console.log(list.map((d) => `${d.status.padEnd(11)} ${d.filename} ${d.downloaded}/${d.size}`).join('\n'));
  await app.close();
  slow.server.close();
  fast.server.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
