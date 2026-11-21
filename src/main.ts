/**
 * Application controller: binds the editor UI to the settings model, drives
 * the depth + processing workers and the preview renderer, and runs exports.
 */
import './styles.css';
import { zipSync } from 'fflate';
import type { DepthMap } from './core/depth';
import { composeLayout } from './core/formats';
import { defaultCrop, resolveOutputSize, type FitMode, type StereoFormat } from './core/layout';
import {
  cloneSettings, DEFAULT_SETTINGS, effectiveOffsets,
  type AnaglyphMethod, type StereoSettings,
} from './core/settings';
import type { Interpolation } from './core/types';
import { DepthClient, type DepthProgress } from './depth/client';
import { ACCEPT_ATTR, createSampleImage, importFile, type ImportedImage } from './io/import';
import { PreviewRenderer, type ViewMode } from './ui/preview';
import { deepMerge, settingsFromHash, shareUrl } from './ui/share';
import { StereoWorkerClient } from './worker/client';
import type { RenderInfo } from './worker/protocol';

const STORAGE_KEY = 'stereo3d.settings.v2';
/** Max pixels per eye rendered for the live preview; export is always full resolution. */
const PREVIEW_MAX_EYE_PIXELS = 2_300_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ───────────────────────── state ─────────────────────────

function loadSettings(): StereoSettings {
  const fromLink = settingsFromHash(location.hash);
  if (fromLink) return fromLink;
  const s = cloneSettings(DEFAULT_SETTINGS);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return deepMerge(s, JSON.parse(raw));
  } catch { /* storage unavailable */ }
  return s;
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

let settings = loadSettings();
let current: ImportedImage | null = null;
let lastInfo: RenderInfo | null = null;
let exporting = false;

/** Depth estimation state for the current image. */
type DepthState =
  | { kind: 'none' }
  | { kind: 'running'; progress: DepthProgress | null; promise: Promise<DepthMap | null> }
  | { kind: 'ready'; map: DepthMap; ms: number }
  | { kind: 'error'; message: string };
let depthState: DepthState = { kind: 'none' };
let imageToken = 0;

// ───────────────────────── services ─────────────────────────

const worker = new StereoWorkerClient();
const depthClient = new DepthClient();
const preview = new PreviewRenderer($('stage'), $<HTMLCanvasElement>('stage-canvas'), $('pixel-readout'), {
  original: $<HTMLCanvasElement>('thumb-original'),
  left: $<HTMLCanvasElement>('thumb-left'),
  right: $<HTMLCanvasElement>('thumb-right'),
  sbs: $<HTMLCanvasElement>('thumb-sbs'),
});

worker.onRender = ({ left, right, depth, info }) => {
  lastInfo = info;
  const animate = settings.format === 'wiggle';
  // Compose the selected format with the same code the exporter uses.
  const output = composeLayout(left, right, settings.format, settings.arrangement, settings.anaglyphMethod, settings.resizeInterpolation);
  preview.setWiggleSpeed(settings.wiggleFrameMs);
  preview.setViews(left, right, depth, output, animate);
  preview.setCropState(info.visible, settings.layout.fit === 'manual', settings.layout.crop, eyeAspect());
  setBusy(false);
  updateStatus();
};
worker.onError = (m) => {
  setBusy(false);
  toast(m, true);
};

preview.onZoomChange = (label) => { $('zoom-label').textContent = label; };
preview.onCropChange = (c, final) => {
  settings.layout.crop = c;
  scheduleRender();
  if (final) { saveSettings(); updateHash(); }
};
preview.onCropReset = () => {
  if (!current) return;
  const size = resolveOutputSize(settings.output, settings.format);
  settings.layout.crop = defaultCrop(current.image.width, current.image.height, size.eyeWidth, size.eyeHeight);
  commit();
};

// ───────────────────────── depth ─────────────────────────

/** Start (or reuse) depth estimation for the current image. */
function ensureDepth(): Promise<DepthMap | null> {
  if (!current || !settings.depth.enabled) return Promise.resolve(null);
  if (depthState.kind === 'ready') return Promise.resolve(depthState.map);
  if (depthState.kind === 'running') return depthState.promise;
  const token = imageToken;
  const img = current.image;
  const t0 = performance.now();
  const promise = depthClient.estimate(img, (p) => {
    if (token !== imageToken || depthState.kind !== 'running') return;
    depthState.progress = p;
    syncDepthStatus();
  }).then(async (map) => {
    if (token !== imageToken) return null;
    depthState = { kind: 'ready', map, ms: performance.now() - t0 };
    await worker.setDepth(map);
    syncDepthStatus();
    scheduleRender();
    return map;
  }, (e: Error) => {
    if (token !== imageToken) return null;
    depthState = { kind: 'error', message: e.message };
    syncDepthStatus();
    toast(`Depth analysis failed: ${e.message}. Using the uniform shift.`, true);
    return null;
  });
  depthState = { kind: 'running', progress: null, promise };
  syncDepthStatus();
  return promise;
}

function syncDepthStatus() {
  const el = $('depth-status');
  el.className = 'depth-status';
  const on = settings.depth.enabled;
  if (!on) {
    el.textContent = 'Off — uniform shift only';
    return;
  }
  if (!current) {
    el.textContent = 'Runs automatically when a photo is loaded';
    return;
  }
  switch (depthState.kind) {
    case 'running': {
      const p = depthState.progress;
      if (p?.total) {
        const pct = Math.round((100 * (p.loaded ?? 0)) / p.total);
        el.innerHTML = `<span>${p.stage} ${pct}%</span><span class="bar"><i style="width:${pct}%"></i></span>`;
      } else {
        el.innerHTML = `<span class="spinner"></span><span>${p?.stage ?? 'Analysing depth'}…</span>`;
      }
      break;
    }
    case 'ready':
      el.classList.add('ok');
      el.textContent = `✓ Depth map ready (${depthState.map.width}×${depthState.map.height}, ${(depthState.ms / 1000).toFixed(1)} s)`;
      break;
    case 'error':
      el.classList.add('err');
      el.textContent = `Depth unavailable: ${depthState.message}`;
      break;
    default:
      el.textContent = '';
  }
}

// ───────────────────────── rendering ─────────────────────────

function outputSize() {
  return resolveOutputSize(settings.output, settings.format);
}

function eyeAspect(): number {
  const s = outputSize();
  return s.eyeWidth / s.eyeHeight;
}

function previewScale(): number {
  const s = outputSize();
  const px = s.eyeWidth * s.eyeHeight;
  return px <= PREVIEW_MAX_EYE_PIXELS ? 1 : Math.sqrt(PREVIEW_MAX_EYE_PIXELS / px);
}

let busyTimer = 0;
function scheduleRender() {
  if (!current) return;
  worker.requestRender(settings, previewScale(), preview.mode === 'depth');
  // Only show the spinner for slow renders, avoiding flicker during drags.
  clearTimeout(busyTimer);
  busyTimer = window.setTimeout(() => setBusy(true, 'Processing…'), 180);
}

function setBusy(on: boolean, text = 'Processing…') {
  if (!on) clearTimeout(busyTimer);
  $('busy').classList.toggle('hidden', !on && !exporting);
  if (on) $('busy-text').textContent = text;
}

let hashTimer = 0;
function updateHash() {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => {
    try {
      history.replaceState(null, '', shareUrl(settings, location.href));
    } catch { /* ignore */ }
  }, 300);
}

/** Apply settings to the UI, persist and re-render. */
function commit() {
  keepCropAspect();
  syncUI();
  saveSettings();
  updateHash();
  if (settings.depth.enabled && current) void ensureDepth();
  scheduleRender();
}

/** In manual crop mode, keep the crop rectangle at the eye aspect ratio. */
function keepCropAspect() {
  if (!current || settings.layout.fit !== 'manual') return;
  const { width: ow, height: oh } = current.image;
  const ar = eyeAspect();
  const c = settings.layout.crop;
  const k = ow / oh / ar; // normalised h per normalised w
  if (Math.abs(c.h - c.w * k) < 1e-4 && c.w > 0) return;
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  const area = Math.max(1e-4, c.w * c.h);
  let w = Math.sqrt(area / k);
  w = Math.min(w, 1, 1 / k);
  const h = w * k;
  settings.layout.crop = {
    x: Math.min(1 - w, Math.max(0, cx - w / 2)),
    y: Math.min(1 - h, Math.max(0, cy - h / 2)),
    w, h,
  };
}

// ───────────────────────── UI sync ─────────────────────────

function setSeg(name: string, value: string) {
  document.querySelectorAll<HTMLElement>(`.seg[data-setting="${name}"] button`).forEach((b) => {
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(b.dataset.value === value));
  });
}

function fmt(n: number, d = 2) {
  return Number.isInteger(n) ? String(n) : n.toFixed(d).replace(/0+$/, '').replace(/\.$/, '');
}

const FORMAT_LABEL: Record<StereoFormat, string> = {
  sbs: 'Side-by-side', 'half-sbs': 'Half side-by-side', ou: 'Over/under', 'half-ou': 'Half over/under',
  anaglyph: 'Anaglyph', wiggle: 'Wiggle', mpo: 'MPO',
};

function syncUI() {
  const s = settings;
  setSeg('aspect', s.output.aspect);
  setSeg('aspectTarget', s.output.aspectTarget);
  setSeg('fit', s.layout.fit);
  setSeg('direction', String(s.direction));
  setSeg('shiftedEye', s.shiftedEye);
  setSeg('arrangement', s.arrangement);
  setSeg('edgeMode', s.edgeMode);
  setSeg('exportFormat', s.exportFormat);
  setSeg('wiggleFile', s.wiggleFile);

  $('custom-aspect').classList.toggle('hidden', s.output.aspect !== 'custom' || s.output.resolution === 'custom');
  $<HTMLInputElement>('aspect-w').value = String(s.output.customAspectW);
  $<HTMLInputElement>('aspect-h').value = String(s.output.customAspectH);
  $<HTMLSelectElement>('resolution').value = s.output.resolution;
  $('custom-size').classList.toggle('hidden', s.output.resolution !== 'custom');
  $<HTMLInputElement>('custom-w').value = String(s.output.customWidth);
  $<HTMLInputElement>('custom-h').value = String(s.output.customHeight);

  const size = outputSize();
  const multi = s.format === 'wiggle' ? 'Each frame' : s.format === 'mpo' ? 'Each image' : 'Output';
  $('size-readout').innerHTML = `${multi} <b>${size.width} × ${size.height}</b> px<br>Each eye <b>${size.eyeWidth} × ${size.eyeHeight}</b> px`
    + (s.format === 'half-sbs' || s.format === 'half-ou' ? ' (squeezed ×½)' : '');

  const manual = s.layout.fit === 'manual';
  $('manual-hint').classList.toggle('hidden', !manual);
  $('framing-controls').classList.toggle('hidden', manual);
  $('bg-controls').classList.toggle('hidden', s.layout.fit !== 'fit' && !(s.layout.scale < 1));
  $<HTMLInputElement>('scale').value = String(s.layout.scale);
  $('scale-out').textContent = `${Math.round(s.layout.scale * 100)}%`;
  $<HTMLInputElement>('posx').value = String(s.layout.posX);
  $('posx-out').textContent = `${Math.round(s.layout.posX * 100)}%`;
  $<HTMLInputElement>('posy').value = String(s.layout.posY);
  $('posy-out').textContent = `${Math.round(s.layout.posY * 100)}%`;
  $<HTMLSelectElement>('bg-kind').value = s.background.kind;
  $('bg-color-field').classList.toggle('hidden', s.background.kind !== 'color');
  if (s.background.kind === 'color') $<HTMLInputElement>('bg-color').value = s.background.color.slice(0, 7);

  // Depth
  const d = s.depth;
  $<HTMLInputElement>('depth-enabled').checked = d.enabled;
  $('depth-enabled').parentElement!.querySelector('em')!.textContent = d.enabled ? 'On' : 'Off';
  $('depth-controls').classList.toggle('hidden', !d.enabled);
  $<HTMLInputElement>('depth-strength').value = String(d.strength);
  $('depth-strength-out').textContent = `${fmt(d.strength, 1)} px`;
  $<HTMLInputElement>('depth-focus').value = String(d.focus);
  $('depth-focus-out').textContent = d.focus <= 0.02 ? 'far' : d.focus >= 0.98 ? 'near' : `${Math.round(d.focus * 100)}%`;
  $<HTMLInputElement>('depth-smooth').value = String(d.smoothing);
  $('depth-smooth-out').textContent = `${fmt(d.smoothing, 2)}%`;
  $<HTMLInputElement>('depth-invert').checked = d.invert;
  syncDepthStatus();

  const h = s.horizontalOffset;
  $<HTMLInputElement>('h-offset').value = String(Math.max(-100, Math.min(100, h)));
  if (document.activeElement !== $('h-offset-num')) $<HTMLInputElement>('h-offset-num').value = fmt(h, 2);
  document.querySelectorAll<HTMLElement>('[data-chips="h"] button').forEach((b) => b.classList.toggle('active', Number(b.dataset.value) === h));

  const v = s.verticalOffset;
  $<HTMLInputElement>('v-enabled').checked = s.verticalEnabled;
  $('v-enabled').parentElement!.querySelector('em')!.textContent = s.verticalEnabled ? 'On' : 'Off';
  $<HTMLInputElement>('v-offset').value = String(Math.max(-10, Math.min(10, v)));
  $<HTMLInputElement>('v-offset').disabled = !s.verticalEnabled;
  $<HTMLInputElement>('v-offset-num').disabled = !s.verticalEnabled;
  if (document.activeElement !== $('v-offset-num')) $<HTMLInputElement>('v-offset-num').value = fmt(v, 2);
  document.querySelectorAll<HTMLButtonElement>('[data-chips="v"] button').forEach((b) => {
    b.classList.toggle('active', s.verticalEnabled && Number(b.dataset.value) === v);
    b.disabled = !s.verticalEnabled;
  });
  $('v-warning').classList.toggle('hidden', !s.verticalEnabled || Math.abs(v) <= 2);

  $<HTMLInputElement>('edge-mask').checked = s.edgeMask;
  const off = effectiveOffsets(s);
  const eye = s.shiftedEye === 'right' ? 'Right' : 'Left';
  const hx = off.dx === 0 ? 'no base shift' : `${fmt(Math.abs(off.dx))} px ${off.dx > 0 ? 'right' : 'left'}`;
  const vy = off.dy === 0 ? 'no vertical shift' : `${fmt(Math.abs(off.dy))} px ${off.dy > 0 ? 'down' : 'up'}`;
  const dep = d.enabled ? `<br>+ depth: up to ±${fmt(d.strength * Math.max(d.focus, 1 - d.focus), 1)} px` : '';
  $('offset-summary').innerHTML = `${eye} image: <b>${hx}</b>, <b>${vy}</b>${dep}<br>${s.shiftedEye === 'right' ? 'Left' : 'Right'} image: original`;

  $<HTMLSelectElement>('resize-interp').value = s.resizeInterpolation;
  $<HTMLSelectElement>('shift-interp').value = s.shiftInterpolation;

  // Export
  const still = s.format !== 'wiggle' && s.format !== 'mpo';
  $<HTMLSelectElement>('format').value = s.format;
  $('still-options').classList.toggle('hidden', !still);
  $('anaglyph-field').classList.toggle('hidden', s.format !== 'anaglyph');
  $<HTMLSelectElement>('anaglyph-method').value = s.anaglyphMethod;
  $('wiggle-options').classList.toggle('hidden', s.format !== 'wiggle');
  $<HTMLSelectElement>('wiggle-frames').value = String(s.wiggleFrames);
  $<HTMLInputElement>('wiggle-ms').value = String(s.wiggleFrameMs);
  $('wiggle-ms-out').textContent = `${s.wiggleFrameMs} ms`;
  const lossy = s.format === 'mpo' || (still && s.exportFormat !== 'png');
  $('quality-field').classList.toggle('hidden', !lossy);
  $<HTMLInputElement>('quality').value = String(s.exportQuality);
  $('quality-out').textContent = `${Math.round(s.exportQuality * 100)}%`;
  const detail = s.format === 'wiggle'
    ? `${s.wiggleFrames} frames · ${s.wiggleFrameMs} ms${s.wiggleFile === 'video' ? ' · ≥3 s loop' : ''}`
    : lossy ? `quality ${Math.round(s.exportQuality * 100)}%` : 'lossless';
  $('export-readout').innerHTML = `<b>${exportName()}</b><br>${FORMAT_LABEL[s.format]} · ${size.width} × ${size.height} · ${detail}`;

  const has = !!current;
  $<HTMLButtonElement>('btn-export').disabled = !has || exporting;
  $<HTMLButtonElement>('btn-export-top').disabled = !has || exporting;
  $<HTMLButtonElement>('btn-batch').disabled = exporting;
  $('empty').classList.toggle('hidden', has);

  document.querySelectorAll<HTMLElement>('#view-mode button').forEach((b) => {
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(b.dataset.value === preview.mode));
  });
  document.querySelectorAll<HTMLElement>('.thumbs figure').forEach((f) => {
    const t = f.dataset.thumb;
    const m = preview.mode;
    f.classList.toggle('active', (t === 'sbs' && m === 'sbs') || (t === 'original' && m === 'crop') || ((t === 'left' || t === 'right') && m === 'compare'));
  });

  if (current) preview.setCropState(lastInfo?.visible ?? null, manual, s.layout.crop, eyeAspect());
}

function fileExt(s: StereoSettings): string {
  if (s.format === 'wiggle') return s.wiggleFile === 'gif' ? 'gif' : 'mp4';
  if (s.format === 'mpo') return 'mpo';
  return s.exportFormat === 'jpeg' ? 'jpg' : s.exportFormat;
}

function baseName(name: string) {
  return name.replace(/[^\w\-]+/g, '_').slice(0, 60) || 'image';
}

function exportName(ext = fileExt(settings), name = current?.name ?? 'image', s = settings): string {
  const size = resolveOutputSize(s.output, s.format);
  const tag = s.format === 'sbs' ? '3d' : `3d_${s.format}`;
  return `${baseName(name)}_${tag}_${size.width}x${size.height}.${ext}`;
}

function updateStatus() {
  const i = lastInfo;
  if (!i || !current) {
    $('status').textContent = '';
    return;
  }
  const pct = Math.round(i.renderScale * 1000) / 10;
  const res = pct >= 100 ? 'full resolution' : `${pct}% scale (export is full resolution)`;
  const depth = i.depthUsed ? 'depth on' : settings.depth.enabled ? 'depth pending' : 'uniform';
  $('status').textContent = `Preview ${res} · ${depth} · Δx ${fmt(i.dx, 3)} px · Δy ${fmt(i.dy, 3)} px · ${i.baseReused ? 'frame cached' : 'frame rebuilt'} · ${Math.round(i.ms)} ms`;
}

// ───────────────────────── import / export ─────────────────────────

async function loadImage(p: Promise<ImportedImage>) {
  setBusy(true, 'Decoding image…');
  try {
    const img = await p;
    current?.bitmap.close();
    current = img;
    imageToken++;
    depthState = { kind: 'none' };
    lastInfo = null;
    const size = outputSize();
    settings.layout.crop = defaultCrop(img.image.width, img.image.height, size.eyeWidth, size.eyeHeight);
    await worker.setSource(img.image);
    preview.setOriginal(img.bitmap);
    const info = $('image-info');
    info.classList.remove('hidden');
    const mp = (img.image.width * img.image.height) / 1e6;
    info.innerHTML = `<dt>File</dt><dd title="${escapeHtml(img.name)}">${escapeHtml(img.name)}</dd>`
      + `<dt>Format</dt><dd>${img.format.toUpperCase()}${img.fileSize ? ` · ${(img.fileSize / 1048576).toFixed(2)} MB` : ''}</dd>`
      + `<dt>Size</dt><dd>${img.image.width} × ${img.image.height} (${mp.toFixed(1)} MP)</dd>`;
    commit();
  } catch (e) {
    setBusy(false);
    toast((e as Error).message, true);
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function doExport() {
  if (!current || exporting) return;
  exporting = true;
  syncUI();
  try {
    if (settings.depth.enabled && depthState.kind !== 'ready' && depthState.kind !== 'error') {
      setBusy(true, 'Waiting for depth analysis…');
      await ensureDepth();
    }
    setBusy(true, 'Rendering full resolution…');
    const r = await worker.exportImage(settings, (stage) => setBusy(true, stage));
    const name = exportName(r.ext);
    download(r.blob, name);
    toast(`Exported ${name} (${(r.blob.size / 1048576).toFixed(2)} MB)`);
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`, true);
  } finally {
    exporting = false;
    setBusy(false);
    syncUI();
  }
}

/** Batch mode: apply the current settings to many photos and download a ZIP. */
async function runBatch(files: File[]) {
  if (exporting || !files.length) return;
  exporting = true;
  syncUI();
  const list = $('batch-list');
  list.classList.remove('hidden');
  list.innerHTML = files.map((f) => `<li>${escapeHtml(f.name)}</li>`).join('');
  const items = Array.from(list.children) as HTMLElement[];
  const s = cloneSettings(settings);
  if (s.layout.fit === 'manual') s.layout.fit = 'fill';
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  const used = new Set<string>();
  let ok = 0;
  for (let i = 0; i < files.length; i++) {
    const li = items[i];
    li.className = 'active';
    const status = (t: string) => { li.textContent = `${files[i].name} — ${t}`; setBusy(true, `Batch ${i + 1}/${files.length}: ${t}`); };
    try {
      status('decoding');
      const img = await importFile(files[i]);
      img.bitmap.close();
      let depth: DepthMap | null = null;
      if (s.depth.enabled) {
        status('analysing depth');
        depth = await depthClient.estimate(img.image, (p) => status(p.total ? `${p.stage} ${Math.round((100 * (p.loaded ?? 0)) / p.total)}%` : p.stage.toLowerCase()));
      }
      status('rendering');
      const r = await worker.exportItem(s, img.image, depth, (st) => status(st.toLowerCase()));
      let name = exportName(r.ext, img.name, s);
      for (let k = 2; used.has(name); k++) name = name.replace(/(\.\w+)$/, `_${k}$1`);
      used.add(name);
      entries[name] = [new Uint8Array(await r.blob.arrayBuffer()), { level: 0 }];
      li.className = 'done';
      li.textContent = `✓ ${name}`;
      ok++;
    } catch (e) {
      li.className = 'fail';
      li.textContent = `✗ ${files[i].name}: ${(e as Error).message}`;
    }
  }
  try {
    if (ok) {
      setBusy(true, 'Creating ZIP…');
      download(new Blob([zipSync(entries) as BlobPart], { type: 'application/zip' }), `stereo_3d_batch_${ok}.zip`);
      toast(`Batch done: ${ok} of ${files.length} photos exported`);
    } else {
      toast('Batch failed: no photos could be processed', true);
    }
  } finally {
    exporting = false;
    setBusy(false);
    syncUI();
  }
}

let toastTimer = 0;
function toast(msg: string, error = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.add('hidden'), error ? 6000 : 3500);
}

// ───────────────────────── bindings ─────────────────────────

function bindSeg(name: string, apply: (v: string) => void) {
  document.querySelectorAll<HTMLButtonElement>(`.seg[data-setting="${name}"] button`).forEach((b) => {
    b.addEventListener('click', () => {
      apply(b.dataset.value!);
      commit();
    });
  });
}

function num(el: HTMLInputElement, fallback: number) {
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
}

function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|tiff?)$/i.test(f.name));
}

function bindAll() {
  const fileInput = $<HTMLInputElement>('file-input');
  fileInput.accept = ACCEPT_ATTR;
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void loadImage(importFile(f));
    fileInput.value = '';
  });
  const batchInput = $<HTMLInputElement>('batch-input');
  batchInput.accept = ACCEPT_ATTR;
  batchInput.addEventListener('change', () => {
    const files = imageFiles(batchInput.files);
    batchInput.value = '';
    void runBatch(files);
  });
  $('btn-batch').addEventListener('click', () => batchInput.click());

  const dz = $('dropzone');
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  for (const target of [dz, $('stage')]) {
    target.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
    target.addEventListener('dragleave', () => dz.classList.remove('drag'));
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('drag');
      const files = imageFiles((e as DragEvent).dataTransfer?.files);
      if (files.length > 1) void runBatch(files);
      else if (files[0]) void loadImage(importFile(files[0]));
    });
  }
  window.addEventListener('paste', (e) => {
    const f = Array.from(e.clipboardData?.files ?? []).find((x) => x.type.startsWith('image/'));
    if (f) void loadImage(importFile(f));
  });
  $('btn-sample').addEventListener('click', () => void loadImage(createSampleImage()));
  $('btn-sample-empty').addEventListener('click', () => void loadImage(createSampleImage()));
  $('btn-upload-empty').addEventListener('click', () => fileInput.click());

  bindSeg('aspect', (v) => { settings.output.aspect = v as StereoSettings['output']['aspect']; if (settings.output.resolution === 'custom') settings.output.resolution = '1080p'; });
  bindSeg('aspectTarget', (v) => { settings.output.aspectTarget = v as 'output' | 'eye'; });
  bindSeg('fit', (v) => {
    const prev = settings.layout.fit;
    settings.layout.fit = v as FitMode;
    if (v === 'manual' && prev !== 'manual' && current) {
      // Start the manual crop from the currently visible region.
      settings.layout.crop = lastInfo?.visible && lastInfo.visible.w > 0 ? { ...lastInfo.visible } : settings.layout.crop;
      preview.setMode('crop');
    }
  });
  bindSeg('direction', (v) => { settings.direction = v === '-1' ? -1 : 1; });
  bindSeg('shiftedEye', (v) => { settings.shiftedEye = v as 'left' | 'right'; });
  bindSeg('arrangement', (v) => { settings.arrangement = v as 'parallel' | 'cross'; });
  bindSeg('edgeMode', (v) => { settings.edgeMode = v as 'extend' | 'crop'; });
  bindSeg('exportFormat', (v) => { settings.exportFormat = v as StereoSettings['exportFormat']; });
  bindSeg('wiggleFile', (v) => { settings.wiggleFile = v as 'gif' | 'video'; });

  const onInput = (id: string, apply: (el: HTMLInputElement) => void, ev = 'input') => {
    const el = $<HTMLInputElement>(id);
    el.addEventListener(ev, () => { apply(el); commit(); });
  };
  const onSelect = (id: string, apply: (v: string) => void) => {
    $<HTMLSelectElement>(id).addEventListener('change', (e) => { apply((e.target as HTMLSelectElement).value); commit(); });
  };
  onInput('aspect-w', (el) => { settings.output.customAspectW = Math.max(0.1, num(el, 9)); }, 'change');
  onInput('aspect-h', (el) => { settings.output.customAspectH = Math.max(0.1, num(el, 16)); }, 'change');
  onSelect('resolution', (value) => {
    const v = value as StereoSettings['output']['resolution'];
    if (v === 'custom') {
      const size = outputSize();
      settings.output.customWidth = size.width;
      settings.output.customHeight = size.height;
    }
    settings.output.resolution = v;
  });
  onInput('custom-w', (el) => { settings.output.customWidth = num(el, 1080); }, 'change');
  onInput('custom-h', (el) => { settings.output.customHeight = num(el, 1920); }, 'change');
  onInput('scale', (el) => { settings.layout.scale = num(el, 1); });
  onInput('posx', (el) => { settings.layout.posX = num(el, 0.5); });
  onInput('posy', (el) => { settings.layout.posY = num(el, 0.5); });
  onSelect('bg-kind', (v) => {
    settings.background = v === 'color' ? { kind: 'color', color: '#000000' } : v === 'transparent' ? { kind: 'transparent' } : { kind: 'blur', radius: 48 };
  });
  onInput('bg-color', (el) => { settings.background = { kind: 'color', color: el.value }; });

  onInput('depth-enabled', (el) => { settings.depth.enabled = el.checked; }, 'change');
  onInput('depth-strength', (el) => { settings.depth.strength = num(el, 16); });
  onInput('depth-focus', (el) => { settings.depth.focus = num(el, 0.5); });
  onInput('depth-smooth', (el) => { settings.depth.smoothing = num(el, 0.6); });
  onInput('depth-invert', (el) => { settings.depth.invert = el.checked; }, 'change');

  onInput('h-offset', (el) => { settings.horizontalOffset = num(el, 0); });
  onInput('h-offset-num', (el) => { settings.horizontalOffset = clamp(num(el, 0), -1000, 1000); });
  onInput('v-offset', (el) => { settings.verticalOffset = num(el, 0); });
  onInput('v-offset-num', (el) => { settings.verticalOffset = clamp(num(el, 0), -100, 100); });
  onInput('v-enabled', (el) => { settings.verticalEnabled = el.checked; }, 'change');
  onInput('edge-mask', (el) => { settings.edgeMask = el.checked; }, 'change');
  document.querySelectorAll<HTMLButtonElement>('[data-chips] button').forEach((b) => {
    b.addEventListener('click', () => {
      const v = Number(b.dataset.value);
      if (b.parentElement!.dataset.chips === 'h') settings.horizontalOffset = v;
      else settings.verticalOffset = v;
      commit();
    });
  });
  onSelect('resize-interp', (v) => { settings.resizeInterpolation = v as Interpolation; });
  onSelect('shift-interp', (v) => { settings.shiftInterpolation = v as Interpolation; });
  onSelect('format', (v) => {
    settings.format = v as StereoFormat;
    if (preview.mode !== 'sbs' && preview.mode !== 'crop') preview.setMode('sbs');
  });
  onSelect('anaglyph-method', (v) => { settings.anaglyphMethod = v as AnaglyphMethod; });
  onSelect('wiggle-frames', (v) => { settings.wiggleFrames = Number(v) || 2; });
  onInput('wiggle-ms', (el) => { settings.wiggleFrameMs = num(el, 140); });
  onInput('quality', (el) => { settings.exportQuality = num(el, 0.95); });

  $('btn-export').addEventListener('click', () => void doExport());
  $('btn-export-top').addEventListener('click', () => void doExport());
  $('btn-share').addEventListener('click', async () => {
    const url = shareUrl(settings, location.href);
    try {
      await navigator.clipboard.writeText(url);
      toast('Settings link copied — it contains the settings only, not your photo.');
    } catch {
      prompt('Copy this settings link:', url);
    }
  });
  $('btn-reset').addEventListener('click', () => {
    settings = cloneSettings(DEFAULT_SETTINGS);
    if (current) {
      const size = outputSize();
      settings.layout.crop = defaultCrop(current.image.width, current.image.height, size.eyeWidth, size.eyeHeight);
    }
    preview.setMode('sbs');
    commit();
    toast('Restored defaults: 1080 × 1920 side-by-side · depth on · 14 px · PNG');
  });
  window.addEventListener('hashchange', () => {
    const s = settingsFromHash(location.hash);
    if (s) {
      s.layout.crop = settings.layout.crop;
      settings = s;
      commit();
    }
  });

  document.querySelectorAll<HTMLButtonElement>('#view-mode button').forEach((b) => {
    b.addEventListener('click', () => {
      const wasDepth = preview.mode === 'depth';
      preview.setMode(b.dataset.value as ViewMode);
      syncUI();
      if (wasDepth !== (preview.mode === 'depth')) scheduleRender();
    });
  });
  document.querySelectorAll<HTMLElement>('.thumbs figure').forEach((f) => {
    f.addEventListener('click', () => {
      const t = f.dataset.thumb;
      preview.setMode(t === 'original' ? 'crop' : t === 'sbs' ? 'sbs' : 'compare');
      syncUI();
    });
  });
  $('zoom-in').addEventListener('click', () => preview.zoomBy(1.5));
  $('zoom-out').addEventListener('click', () => preview.zoomBy(1 / 1.5));
  $('zoom-label').addEventListener('click', () => preview.toggleFit());

  // Keyboard nudging: ←/→ horizontal (Shift = 0.1 px), ↑/↓ vertical 0.1 px.
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (!current) return;
    let handled = true;
    if (e.key === 'ArrowRight') settings.horizontalOffset = round(settings.horizontalOffset + (e.shiftKey ? 0.1 : 1));
    else if (e.key === 'ArrowLeft') settings.horizontalOffset = round(settings.horizontalOffset - (e.shiftKey ? 0.1 : 1));
    else if (e.key === 'ArrowUp' && settings.verticalEnabled) settings.verticalOffset = round(settings.verticalOffset - 0.1);
    else if (e.key === 'ArrowDown' && settings.verticalEnabled) settings.verticalOffset = round(settings.verticalOffset + 0.1);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') void doExport();
    else handled = false;
    if (handled) { e.preventDefault(); commit(); }
  });
  window.addEventListener('resize', () => preview.redrawThumbs());
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
function round(v: number) {
  return Math.round(v * 1000) / 1000;
}

bindAll();
syncUI();

// Offline support / installable app (production builds only).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support unavailable */ });
  });
}

// Expose a tiny hook for automated end-to-end tests.
(window as unknown as { __stereo: unknown }).__stereo = {
  get settings() { return settings; },
  get info() { return lastInfo; },
  get idle() { return worker.idle && !exporting; },
  get depth() { return depthState.kind; },
  get depthMap() { return depthState.kind === 'ready' ? depthState.map : null; },
};
