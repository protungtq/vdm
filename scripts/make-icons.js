// Renders the app logo (src/renderer/assets/icons/logo.svg, from Figma) to
// PNGs and packs build/icon.ico, tray icons and the browser-extension icons.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const icons = path.join(root, 'src/renderer/assets/icons');
const out = path.join(root, 'build');

(async () => {
  const pngToIco = (await import('png-to-ico')).default;
  const logo = fs.readFileSync(path.join(icons, 'logo.svg'), 'utf8');
  const svg16 = logo;
  const svg30 = logo;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const render = async (svg, size, file) => {
    const src = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${src}" style="width:${size}px;height:${size}px;display:block"></body></html>`);
    await page.waitForFunction(() => document.images[0].complete);
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    return file;
  };
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const files = [];
  for (const s of sizes) files.push(await render(s <= 24 ? svg16 : svg30, s, path.join(out, `icon-${s}.png`)));
  await render(svg30, 512, path.join(out, 'icon.png'));
  // Tray icons: the single-colour glyph, white for a dark taskbar and
  // near-black for a light one (the app picks the matching pair at runtime).
  const mono = fs.readFileSync(path.join(icons, 'logo-mono.svg'), 'utf8');
  const monoDark = mono.replace(/#F6F6F6/gi, '#1B1B1F');
  await render(mono, 16, path.join(root, 'src/renderer/assets/tray-light-16.png'));
  await render(mono, 32, path.join(root, 'src/renderer/assets/tray-light-32.png'));
  await render(monoDark, 16, path.join(root, 'src/renderer/assets/tray-dark-16.png'));
  await render(monoDark, 32, path.join(root, 'src/renderer/assets/tray-dark-32.png'));
  await render(svg30, 256, path.join(root, 'src/renderer/assets/app-256.png'));
  // Browser-extension icons
  fs.mkdirSync(path.join(root, 'extension/icons'), { recursive: true });
  for (const s of [16, 32, 48, 128]) await render(s <= 24 ? svg16 : svg30, s, path.join(root, `extension/icons/${s}.png`));
  await browser.close();
  fs.writeFileSync(path.join(out, 'icon.ico'), await pngToIco(files));
  for (const f of files) fs.unlinkSync(f);
  console.log('icons written');
})().catch((e) => { console.error(e); process.exit(1); });
