/**
 * End-to-end smoke test: run with `npm run test:e2e`.
 * Starts a Vite dev server, uploads generated test images (PNG, JPEG-free formats + TIFF),
 * checks the live preview, exports a PNG and verifies it pixel-for-pixel
 * against the same pipeline executed in Node (determinism across runtimes).
 *

 */
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode } from 'fast-png';
import UTIF from 'utif';

// Use the project's Playwright if installed, else the globally available one.
const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'e2e', 'out');
mkdirSync(out, { recursive: true });

function photo(w, h, seed, k = 1) {
  const d = new Uint8Array(w * h * 4);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, n = (rnd() - 0.5) * 16;
    const c = Math.exp(-((x / w - 0.5) ** 2 + (y / h - 0.4) ** 2) * 18);
    d[o] = Math.max(0, Math.min(255, (40 + 180 * x / w + 60 * c + n) * k));
    d[o + 1] = Math.max(0, Math.min(255, (60 + 120 * y / h + 90 * c + n) * k));
    d[o + 2] = Math.max(0, Math.min(255, (150 - 100 * y / h + 40 * c + n) * k));
    d[o + 3] = 255;
  }
  // "Text": black bars
  for (let y = Math.floor(h * 0.1); y < h * 0.14; y++) for (let x = Math.floor(w * 0.2); x < w * 0.8; x++) {
    if ((x >> 3) % 3 === 0) continue;
    const o = (y * w + x) * 4; d[o] = d[o + 1] = d[o + 2] = 0;
  }
  return d;
}

const cases = [
  { name: 'portrait', w: 900, h: 1600, k: 1 },
  { name: 'landscape', w: 1600, h: 900, k: 1 },
  { name: 'dark', w: 800, h: 1200, k: 0.15 },
  { name: 'bright', w: 800, h: 1200, k: 1.7 },
];
for (const c of cases) {
  c.data = photo(c.w, c.h, 7 + c.w, c.k);
  c.file = join(out, `${c.name}.png`);
  writeFileSync(c.file, encode({ width: c.w, height: c.h, data: c.data, channels: 4, depth: 8 }));
}
const tiff = { name: 'tiff', w: 640, h: 480, k: 1 };
tiff.data = photo(tiff.w, tiff.h, 99);
tiff.file = join(out, 'sample.tif');
writeFileSync(tiff.file, Buffer.from(UTIF.encodeImage(tiff.data, tiff.w, tiff.h)));

const server = await createServer({ root, server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
const { StereoPipeline } = await server.ssrLoadModule('/src/core/pipeline.ts');
const { DEFAULT_SETTINGS, cloneSettings } = await server.ssrLoadModule('/src/core/settings.ts');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5199/');
await page.evaluate(() => localStorage.clear());
await page.reload();

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };

async function waitRender() {
  await page.waitForFunction(() => window.__stereo?.info, null, { timeout: 30000 });
  await page.waitForTimeout(100);
  await page.waitForFunction(() => window.__stereo.idle, null, { timeout: 60000, polling: 50 });
}

for (const c of [...cases, tiff]) {
  await page.setInputFiles('#file-input', c.file);
  try {
    await page.waitForFunction((n) => document.getElementById('image-info').textContent.includes(n), c.name === 'tiff' ? 'sample' : c.name, { timeout: 30000 });
  } catch (e) {
    console.log('page errors:', errors, await page.evaluate(() => document.getElementById('toast').textContent));
    throw e;
  }
  await waitRender();
  const info = await page.evaluate(() => window.__stereo.info);
  check(info.fullWidth === 1080 && info.fullHeight === 1920, `${c.name}: default output 1080×1920 (got ${info.fullWidth}×${info.fullHeight})`);
  check(Math.abs(info.dx - 14) < 1e-9 && Math.abs(info.dy - 0.6) < 1e-9, `${c.name}: default offsets 14 / 0.6 px`);

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const path = join(out, `${c.name}_export.png`);
  await dl.saveAs(path);
  const png = decode(readFileSync(path));
  check(png.width === 1080 && png.height === 1920, `${c.name}: exported PNG is 1080×1920`);

  // Same pipeline in Node on the same source pixels must give identical bytes.
  const p = new StereoPipeline();
  p.setSource({ width: c.w, height: c.h, data: new Uint8ClampedArray(c.data) });
  const ref = p.render(cloneSettings(DEFAULT_SETTINGS), 1).output.data;
  const got = png.data;
  const ch = png.channels;
  let diff = 0;
  for (let i = 0, j = 0; i < ref.length; i += 4, j += ch) {
    if (ref[i] !== got[j] || ref[i + 1] !== got[j + 1] || ref[i + 2] !== got[j + 2]) diff++;
  }
  check(diff === 0, `${c.name}: browser export identical to reference render (${diff} differing pixels)`);
  await page.screenshot({ path: join(out, `${c.name}_ui.png`) });
}

// Interactivity: change offset → only displacement re-runs (cached frame).
await page.fill('#h-offset-num', '30');
await page.dispatchEvent('#h-offset-num', 'input');
await waitRender();
let info = await page.evaluate(() => window.__stereo.info);
check(Math.abs(info.dx - 30) < 1e-9 && info.baseReused, `offset change re-uses cached frame (dx=${info.dx}, ${Math.round(info.ms)} ms)`);

// Zero displacement → halves identical (export).
await page.fill('#h-offset-num', '0'); await page.dispatchEvent('#h-offset-num', 'input');
await page.click('#v-enabled + span');
await waitRender();
{
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const path = join(out, 'zero_export.png'); await dl.saveAs(path);
  const png = decode(readFileSync(path));
  const w = png.width, ch = png.channels, half = w / 2;
  let diff = 0;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < half; x++) for (let k = 0; k < 3; k++) {
    if (png.data[(y * w + x) * ch + k] !== png.data[(y * w + x + half) * ch + k]) diff++;
  }
  check(diff === 0, 'zero displacement: both halves identical');
}

// Aspect ratio + resolution presets.
for (const [aspect, res, w, h] of [['16:9', '4k', 3840, 2160], ['1:1', '720p', 720, 720], ['4:3', '1080p', 1440, 1080]]) {
  await page.click(`.seg[data-setting="aspect"] button[data-value="${aspect}"]`);
  await page.selectOption('#resolution', res);
  await waitRender();
  info = await page.evaluate(() => window.__stereo.info);
  check(info.fullWidth === w && info.fullHeight === h, `${aspect} @ ${res} → ${info.fullWidth}×${info.fullHeight}`);
}
// Fit mode, view modes, manual crop, mobile layout screenshots.
await page.click('.seg[data-setting="fit"] button[data-value="fit"]'); await waitRender();
await page.screenshot({ path: join(out, 'fit_mode.png') });
for (const m of ['compare', 'wiggle', 'diff', 'anaglyph', 'crop']) {
  await page.click(`#view-mode button[data-value="${m}"]`);
  await page.waitForTimeout(150);
}
await page.click('.seg[data-setting="fit"] button[data-value="manual"]'); await waitRender();
await page.screenshot({ path: join(out, 'manual_crop.png') });
await page.click('#btn-reset'); await waitRender();
info = await page.evaluate(() => window.__stereo.info);
check(info.fullWidth === 1080 && info.dx === 14, 'reset restores defaults');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, 'mobile.png'), fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 0, `mobile layout has no horizontal scroll (${overflow}px)`);

check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
await server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll e2e checks passed');
process.exit(failures ? 1 : 0);
