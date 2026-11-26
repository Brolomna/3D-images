/**
 * End-to-end test of the real UI in Chromium (run with `npm run test:e2e`).
 *
 *  - uploads generated PNG + TIFF photos, waits for automatic depth analysis
 *    (downloads the depth model from Hugging Face on first run), exports and
 *    verifies the PNG is byte-identical to the same pipeline run in Node
 *  - exports every stereo format (half-SBS, over/under, anaglyph, wiggle GIF
 *    + video, MPO) and validates the files
 *  - batch ZIP, share links, presets, view modes, mobile layout
 *  - production build: service worker + manifest (offline / installable)
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer, preview } from 'vite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode } from 'fast-png';
import { unzipSync } from 'fflate';
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

// Route the browser through the sandbox's HTTPS proxy when there is one.
const proxy = process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } } : {};
const browser = await chromium.launch(proxy);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
// The dev server may re-optimise dependencies and reload once on first visit.
await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(() => localStorage.clear()).catch(() => {});
await page.reload({ waitUntil: 'networkidle' });

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };

async function waitRender() {
  await page.waitForFunction(() => window.__stereo?.info, null, { timeout: 30000 });
  await page.waitForTimeout(100);
  await page.waitForFunction(() => window.__stereo.idle, null, { timeout: 120000, polling: 50 });
}
async function waitDepth() {
  try {
    await page.waitForFunction(() => ['ready', 'error'].includes(window.__stereo.depth), null, { timeout: 300000, polling: 200 });
  } catch (e) {
    console.log('depth wait timed out:', await page.evaluate(() => [window.__stereo?.depth, document.getElementById('depth-status').textContent]), errors);
    throw e;
  }
  await waitRender();
}
async function exportFile(name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#btn-export')]);
  const path = join(out, name ?? dl.suggestedFilename());
  await dl.saveAs(path);
  await page.waitForFunction(() => window.__stereo.idle, null, { timeout: 60000 });
  return { path, name: dl.suggestedFilename(), bytes: readFileSync(path) };
}
/** Count image frames by walking the GIF block structure. */
function gifFrameCount(b) {
  let p = 13;
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
  const skipSub = () => { while (b[p] !== 0) p += b[p] + 1; p++; };
  let frames = 0;
  while (p < b.length) {
    const id = b[p++];
    if (id === 0x3b) break;
    if (id === 0x21) { p++; skipSub(); continue; }
    if (id === 0x2c) {
      frames++;
      const flags = b[p + 8];
      p += 9;
      if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
      p++; // LZW minimum code size
      skipSub();
      continue;
    }
    return -1;
  }
  return frames;
}
async function chooseStyle(format) {
  await page.click(`.style-card[data-value="${format}"]`);
  await waitRender();
}
async function setSelect(id, value) {
  await page.selectOption(id, value);
  await waitRender();
}

// ── 1. Default pipeline with automatic depth: browser export == Node reference ──
for (const c of [...cases, tiff]) {
  await page.setInputFiles('#file-input', c.file);
  await page.waitForFunction((n) => document.getElementById('image-info').textContent.includes(n), c.name === 'tiff' ? 'sample' : c.name, { timeout: 30000 });
  await waitDepth();
  const state = await page.evaluate(() => window.__stereo.depth);
  check(state === 'ready', `${c.name}: depth map estimated automatically (${state})`);
  const info = await page.evaluate(() => window.__stereo.info);
  check(info.fullWidth === 1080 && info.fullHeight === 1920, `${c.name}: default output 1080×1920`);
  check(info.dx === 14 && info.dy === 0 && info.depthUsed, `${c.name}: defaults 14 px / 0 px with depth`);

  const file = await exportFile(`${c.name}_export.png`);
  const png = decode(file.bytes);
  check(png.width === 1080 && png.height === 1920, `${c.name}: exported PNG is 1080×1920`);

  const dm = await page.evaluate(() => { const m = window.__stereo.depthMap; return { width: m.width, height: m.height, data: Array.from(m.data) }; });
  const p = new StereoPipeline();
  p.setSource({ width: c.w, height: c.h, data: new Uint8ClampedArray(c.data) });
  p.setDepth({ width: dm.width, height: dm.height, data: Float32Array.from(dm.data) });
  const ref = p.render(cloneSettings(DEFAULT_SETTINGS), 1).output.data;
  const got = png.data, ch = png.channels;
  let diff = 0;
  for (let i = 0, j = 0; i < ref.length; i += 4, j += ch) {
    if (ref[i] !== got[j] || ref[i + 1] !== got[j + 1] || ref[i + 2] !== got[j + 2]) diff++;
  }
  check(diff === 0, `${c.name}: browser export identical to Node reference (${diff} differing pixels)`);
  await page.screenshot({ path: join(out, `${c.name}_ui.png`) });
}
await page.click('#view-mode button[data-value="depth"]');
await waitRender();
await page.screenshot({ path: join(out, 'depth_view.png') });
await page.click('#view-mode button[data-value="sbs"]');

// ── 2. Interactivity: offset change re-uses the cached frame ──
await page.fill('#h-offset-num', '30');
await page.dispatchEvent('#h-offset-num', 'input');
await waitRender();
let info = await page.evaluate(() => window.__stereo.info);
check(info.dx === 30 && info.baseReused, `offset change re-uses cached frame (${Math.round(info.ms)} ms)`);

// ── 3. Every export format ──
await page.click('#depth-enabled + span'); // depth off → exact zero test
await page.fill('#h-offset-num', '0'); await page.dispatchEvent('#h-offset-num', 'input');
await waitRender();
{
  const png = decode((await exportFile('zero_export.png')).bytes);
  const w = png.width, ch = png.channels, half = w / 2;
  let diff = 0;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < half; x++) for (let k = 0; k < 3; k++) {
    if (png.data[(y * w + x) * ch + k] !== png.data[(y * w + x + half) * ch + k]) diff++;
  }
  check(diff === 0, 'zero displacement: both halves identical');
}
await page.click('#depth-enabled + span'); // depth back on
await page.fill('#h-offset-num', '14'); await page.dispatchEvent('#h-offset-num', 'input');
await waitDepth();

for (const [format, w, h] of [['half-sbs', 1080, 1920], ['ou', 1080, 1920], ['half-ou', 1080, 1920], ['anaglyph', 1080, 1920]]) {
  await chooseStyle(format);
  const f = await exportFile();
  const png = decode(f.bytes);
  check(png.width === w && png.height === h && f.name.includes(format), `${format}: ${f.name} is ${png.width}×${png.height}`);
  await page.screenshot({ path: join(out, `format_${format}.png`) });
}
await chooseStyle('mpo');
{
  const f = await exportFile();
  const b = f.bytes;
  const starts = [];
  for (let i = 0; i < b.length - 1; i++) if (b[i] === 0xff && b[i + 1] === 0xd8) starts.push(i);
  const hasMpf = b.includes(Buffer.from('MPF\0'));
  check(f.name.endsWith('.mpo') && starts.length >= 2 && hasMpf, `mpo: ${f.name} contains ${starts.length} JPEG images with MPF index`);
}
await chooseStyle('wiggle');
await setSelect('#wiggle-frames', '6');
{
  const f = await exportFile();
  check(f.name.endsWith('.gif') && f.bytes.subarray(0, 6).toString() === 'GIF89a', `wiggle GIF: ${f.name} (${(f.bytes.length / 1e6).toFixed(1)} MB)`);
}
await page.click('.seg[data-setting="wiggleFile"] button[data-value="video"]');
await waitRender();
{
  const res = await Promise.race([
    exportFile().then((f) => ({ f })),
    page.waitForSelector('#toast.error:not(.hidden)', { timeout: 180000 }).then(async () => ({ err: await page.textContent('#toast') })),
  ]);
  if (res.f) {
    const isMp4 = res.f.bytes.subarray(4, 8).toString() === 'ftyp';
    const isWebm = res.f.bytes.readUInt32BE(0) === 0x1a45dfa3;
    check((isMp4 && res.f.name.endsWith('.mp4')) || (isWebm && res.f.name.endsWith('.webm')), `wiggle video: ${res.f.name} (${isMp4 ? 'MP4/H.264' : 'WebM'})`);
  } else {
    check(/WebCodecs|cannot encode/.test(res.err), `wiggle video unsupported in this browser build, clear message shown: "${res.err}"`);
  }
}
// 3D photo motion (depth-driven camera animation): MP4 and GIF.
await chooseStyle('motion');
await page.waitForTimeout(600);
await page.screenshot({ path: join(out, 'style_motion.png') });
{
  const f = await exportFile();
  const isMp4 = f.bytes.subarray(4, 8).toString() === 'ftyp';
  check(f.name.includes('motion') && (isMp4 || f.bytes.readUInt32BE(0) === 0x1a45dfa3), `motion video: ${f.name} (${(f.bytes.length / 1e6).toFixed(2)} MB)`);
}
await page.click('.seg[data-setting="motionPath"] button[data-value="zoom"]');
await page.click('.seg[data-setting="motionFile"] button[data-value="gif"]');
await waitRender();
{
  const f = await exportFile();
  const frames = gifFrameCount(f.bytes);
  check(f.name.endsWith('.gif') && frames === 45, `motion GIF (zoom): ${f.name}, ${frames} frames`);
}
// Stereogram: export and verify it repeats every pattern width.
await chooseStyle('stereogram');
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, 'style_stereogram.png') });
{
  const f = await exportFile();
  const png = decode(f.bytes);
  const P = Math.round(png.width / 6), ch = png.channels;
  // Flat background stretches repeat exactly every pattern width: find the
  // longest run of pixels that equal the pixel one pattern width further on.
  let bestRun = 0;
  for (let y = 60; y < png.height; y += 10) {
    let run = 0;
    for (let x = 0; x + P < png.width; x++) {
      const a = (y * png.width + x) * ch, b = a + P * ch;
      if (png.data[a] === png.data[b] && png.data[a + 1] === png.data[b + 1] && png.data[a + 2] === png.data[b + 2]) {
        run++;
        bestRun = Math.max(bestRun, run);
      } else run = 0;
    }
  }
  check(f.name.includes('stereogram') && png.width === 1080 && bestRun >= 2 * P,
    `stereogram: ${f.name}, background repeats every ${P} px (longest exact run ${bestRun} px)`);
}
await page.click('#view-mode button[data-value="sketch"]');
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, 'stereogram_sketch.png') });
const sketchShown = await page.evaluate(() => {
  const c = document.getElementById('stage-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let paper = 0;
  for (let i = 0; i < d.length; i += 16) if (d[i] === 244 && d[i + 1] === 241 && d[i + 2] === 234) paper++;
  return paper > 100;
});
check(sketchShown, 'stereogram sketch view shows the line drawing');
await page.click('#view-mode button[data-value="sbs"]');
const thumbsDrawn = await page.evaluate(() => [...document.querySelectorAll('.style-card canvas')].every((c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
  return false;
}));
check(thumbsDrawn, 'all 8 style cards show a live thumbnail');
await chooseStyle('sbs');

// ── 3b. 3D Scene: new depth background + subject pop ──
{
  const before = decode((await exportFile('scene_before.png')).bytes);
  await page.click('#scene-enabled + span');
  await page.click('#scene-grid .scene-card[data-value="space"]');
  await page.waitForFunction(() => document.getElementById('scene-status').textContent.includes('Scene ready'), null, { timeout: 120000 });
  await waitRender();
  const after = decode((await exportFile('scene_after.png')).bytes);
  let diff = 0;
  for (let i = 0; i < before.data.length; i += 97) if (before.data[i] !== after.data[i]) diff++;
  check(after.width === before.width && diff > 1000, `3D Scene changes the export (${diff} sampled pixels differ)`);
  await page.click('#view-mode button[data-value="crop"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'scene_space.png') });
  await page.click('#view-mode button[data-value="sbs"]');
  await page.click('#scene-enabled + span');
  await page.waitForFunction(() => document.getElementById('scene-status').textContent === '', null, { timeout: 60000 });
  await waitRender();
}

// ── 3c. Layered 3D card: split a card into frame / character / background ──
{
  // Procedural card: dark frame, window with a soft backdrop and a clear
  // character (head + body), a name banner with a dark top border.
  const W = 470, H = 836, d = new Uint8Array(W * H * 4);
  const win = [49, 60, 421, 770];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let c = [58, 22, 24];
    if (x >= win[0] && x < win[2] && y >= win[1] && y < win[3]) c = [40 + y / 12, 90 + x / 10, 120];
    const head = Math.hypot(x - 235, y - 230) < 70;
    const body = Math.abs(x - 235) < 110 - Math.max(0, 330 - y) * 0.4 && y > 290 && y < 760;
    if (head || body) c = head ? [235, 190, 160] : [200, 60, 140];
    if (y >= 538 && y < 545) c = [20, 8, 8];
    if (y >= 545 && y < 620 && x > 20 && x < W - 20) c = [225, 60, 50];
    d.set([...c, 255], (y * W + x) * 4);
  }
  const cardFile = join(out, 'e2e-card.png');
  writeFileSync(cardFile, encode({ width: W, height: H, data: d, channels: 4, depth: 8 }));
  await page.setInputFiles('#file-input', cardFile);
  await page.waitForFunction(() => document.getElementById('image-info').textContent.includes('e2e-card'));
  await chooseStyle('card');
  await page.click('#card-winauto');
  for (const [id, v] of [['#card-wx0', 49 / W * 100], ['#card-wy0', 60 / H * 100], ['#card-wx1', 421 / W * 100], ['#card-wy1', 770 / H * 100]]) {
    await page.fill(id, String(Math.round(v * 10) / 10));
    await page.dispatchEvent(id, 'change');
  }
  await page.click('#card-split');
  await page.waitForFunction(() => /^✓|Could not/.test(document.getElementById('card-status').textContent), null, { timeout: 600000 });
  const st = await page.textContent('#card-status');
  check(st.startsWith('✓'), `layered 3D card split: ${st}`);
  const box = await page.locator('.card3d').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height * 0.5, { steps: 6 });
  await page.waitForTimeout(600);
  const tr = await page.evaluate(() => document.querySelector('.card3d-char').style.transform);
  await page.mouse.up();
  check(/translate3d\(-[1-9]/.test(tr), `dragging tilts the character layer (${tr})`);
  await page.screenshot({ path: join(out, 'layered_card.png') });
  const f = await exportFile();
  const z = unzipSync(f.bytes);
  const names = Object.keys(z).sort().join(',');
  const info = JSON.parse(new TextDecoder().decode(z['layers.json']));
  check(/bg\.(webp|png),char\.(webp|png),frame\.(webp|png),layers\.json,preview\.png,viewer\.html/.test(names) && info.size[0] === W,
    `card ZIP has the 3 layers, layers.json, preview and viewer (${names})`);
  await chooseStyle('sbs');
}

// ── 3d. More downloads: depth maps, eye views, wiggle frames, all parts ──
{
  const grab = async (sel) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click(sel)]);
    const path = join(out, dl.suggestedFilename());
    await dl.saveAs(path);
    await page.waitForFunction(() => window.__stereo.idle, null, { timeout: 60000 });
    return { name: dl.suggestedFilename(), bytes: readFileSync(path) };
  };
  const depthZip = unzipSync((await grab('#dl-depth')).bytes);
  const dp = decode(depthZip['depth.png']);
  check(dp.depth === 16 && dp.channels === 1 && !!depthZip['depth_full_photo.png'], `depth map download: 16-bit grayscale (${Object.keys(depthZip).join(', ')})`);
  const views = unzipSync((await grab('#dl-views')).bytes);
  check(!!views['left.png'] && !!views['right.png'], 'left + right views download');
  await chooseStyle('wiggle');
  const n = await page.evaluate(() => window.__stereo.settings.wiggleFrames);
  const frames = unzipSync((await grab('#dl-frames')).bytes);
  const fnames = Object.keys(frames).filter((k) => k.startsWith('wiggle_frame_'));
  check(fnames.length === n, `wiggle frames download: ${fnames.length} pictures (${fnames.join(', ')})`);
  const parts = unzipSync((await grab('#dl-parts')).bytes);
  const pk = Object.keys(parts);
  check(['left.png', 'right.png', 'depth.png', 'depth_full_photo.png'].every((k) => pk.includes(k)) && pk.filter((k) => k.startsWith('wiggle_frame_')).length === n,
    `all parts download (${pk.length} files)`);
  await chooseStyle('sbs');
}

// ── 4. Batch → ZIP ──
{
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 300000 }),
    page.setInputFiles('#batch-input', [cases[0].file, cases[1].file, tiff.file]),
  ]);
  const path = join(out, 'batch.zip');
  await dl.saveAs(path);
  const entries = unzipSync(readFileSync(path));
  const names = Object.keys(entries);
  const ok = names.length === 3 && names.every((n) => decode(entries[n]).width === 1080);
  check(ok, `batch ZIP has 3 PNG exports (${names.join(', ')})`);
  await page.waitForFunction(() => window.__stereo.idle, null, { timeout: 60000 });
}

// ── 5. Presets, share links, modes, crop, reset ──
for (const [aspect, res, w, h] of [['16:9', '4k', 3840, 2160], ['1:1', '720p', 720, 720], ['4:3', '1080p', 1440, 1080]]) {
  await page.click(`.seg[data-setting="aspect"] button[data-value="${aspect}"]`);
  await setSelect('#resolution', res);
  info = await page.evaluate(() => window.__stereo.info);
  check(info.fullWidth === w && info.fullHeight === h, `${aspect} @ ${res} → ${info.fullWidth}×${info.fullHeight}`);
}
await page.fill('#h-offset-num', '22'); await page.dispatchEvent('#h-offset-num', 'input');
await waitRender();
await page.waitForTimeout(500);
const hash = await page.evaluate(() => location.hash);
const fresh = await context.newPage();
await fresh.goto(`http://localhost:5199/${hash}`);
const restored = await fresh.evaluate(() => [window.__stereo.settings.horizontalOffset, window.__stereo.settings.output.aspect]);
check(hash.startsWith('#s=') && restored[0] === 22 && restored[1] === '4:3', `share link restores settings (${hash.length} chars)`);
await fresh.close();

await page.click('.seg[data-setting="fit"] button[data-value="fit"]'); await waitRender();
for (const m of ['compare', 'wiggle', 'diff', 'anaglyph', 'depth', 'crop']) {
  await page.click(`#view-mode button[data-value="${m}"]`);
  await page.waitForTimeout(150);
}
await page.click('.seg[data-setting="fit"] button[data-value="manual"]'); await waitRender();
await page.screenshot({ path: join(out, 'manual_crop.png') });
await page.click('#btn-reset'); await waitRender();
info = await page.evaluate(() => window.__stereo.info);
check(info.fullWidth === 1080 && info.dx === 14 && info.dy === 0, 'reset restores defaults');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, 'mobile.png'), fullPage: true });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 0, `mobile layout has no horizontal scroll (${overflow}px)`);
for (const tab of ['photo', 'style', 'adjust', 'export']) {
  await page.click(`#mobile-tabs button[data-tab="${tab}"]`);
  await page.waitForTimeout(150);
  const vis = await page.evaluate(() => [...document.querySelectorAll('.group')].filter((g) => g.offsetParent !== null).map((g) => g.dataset.tab));
  check(vis.length > 0 && vis.every((t) => t === tab), `mobile tab "${tab}" shows only its ${vis.length} section(s)`);
}
const pinned = await page.evaluate(() => {
  window.scrollTo(0, 400);
  const r = document.querySelector('.stage-wrap').getBoundingClientRect();
  return r.top >= 0 && r.top < 80 && r.height > 200;
});
check(pinned, 'mobile preview stays pinned while scrolling the controls');
await page.screenshot({ path: join(out, 'mobile_export_tab.png') });
await page.click('#mobile-tabs button[data-tab="photo"]');
check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await server.close();

// ── 6. Production build: installable + offline ──
// Build in a separate process: the dev server above set NODE_ENV=development.
execSync('npx vite build --logLevel error', { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
const prev = await preview({ root, preview: { port: 5198, strictPort: true }, logLevel: 'error' });
{
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto('http://localhost:5198/', { waitUntil: 'load' });
  let sw = false;
  for (let i = 0; i < 40 && !sw; i++) {
    sw = await p2.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).some((r) => r.active?.state === 'activated'));
    if (!sw) await p2.waitForTimeout(500);
  }
  const manifest = await p2.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
  check(sw, 'service worker active (offline support)');
  check(manifest.icons.length >= 2 && manifest.display === 'standalone', 'web app manifest is installable');
  await ctx2.setOffline(true);
  const title = await p2.reload().then(() => p2.title(), (e) => `failed: ${e.message.split('\n')[0]}`);
  check(title === 'Stereo 3D Photo Generator', `app loads offline (title "${title}")`);
  await ctx2.close();
}
await prev.close();
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll e2e checks passed');
process.exit(failures ? 1 : 0);
