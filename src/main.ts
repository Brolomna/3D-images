/**
 * Application controller: binds the editor UI to the settings model, drives
 * the processing worker and the preview renderer, and runs exports.
 */
import './styles.css';
import { defaultCrop, resolveOutputSize, type FitMode } from './core/layout';
import { cloneSettings, DEFAULT_SETTINGS, effectiveOffsets, type StereoSettings } from './core/settings';
import type { Interpolation } from './core/types';
import { ACCEPT_ATTR, createSampleImage, importFile, type ImportedImage } from './io/import';
import { PreviewRenderer, type ViewMode } from './ui/preview';
import type { RenderInfo } from './worker/protocol';
import { StereoWorkerClient } from './worker/client';

const STORAGE_KEY = 'stereo3d.settings.v1';
/** Max pixels per eye rendered for the live preview; export is always full resolution. */
const PREVIEW_MAX_EYE_PIXELS = 2_300_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ───────────────────────── state ─────────────────────────

function loadSettings(): StereoSettings {
  const s = cloneSettings(DEFAULT_SETTINGS);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<StereoSettings>;
      return deepMerge(s, saved);
    }
  } catch { /* storage unavailable */ }
  return s;
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = base as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue;
    const cur = out[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) out[k] = deepMerge(cur, v);
    else if (typeof v === typeof cur) out[k] = v;
  }
  return base;
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

// ───────────────────────── services ─────────────────────────

const worker = new StereoWorkerClient();
const preview = new PreviewRenderer($('stage'), $<HTMLCanvasElement>('stage-canvas'), $('pixel-readout'), {
  original: $<HTMLCanvasElement>('thumb-original'),
  left: $<HTMLCanvasElement>('thumb-left'),
  right: $<HTMLCanvasElement>('thumb-right'),
  sbs: $<HTMLCanvasElement>('thumb-sbs'),
});

worker.onRender = ({ image, info }) => {
  lastInfo = info;
  preview.setOutput(image, settings.arrangement);
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
  if (final) saveSettings();
};
preview.onCropReset = () => {
  if (!current) return;
  const size = resolveOutputSize(settings.output);
  settings.layout.crop = defaultCrop(current.image.width, current.image.height, size.eyeWidth, size.eyeHeight);
  commit();
};

// ───────────────────────── rendering ─────────────────────────

function eyeAspect(): number {
  const s = resolveOutputSize(settings.output);
  return s.eyeWidth / s.eyeHeight;
}

function previewScale(): number {
  const s = resolveOutputSize(settings.output);
  const px = s.eyeWidth * s.eyeHeight;
  return px <= PREVIEW_MAX_EYE_PIXELS ? 1 : Math.sqrt(PREVIEW_MAX_EYE_PIXELS / px);
}

let busyTimer = 0;
function scheduleRender() {
  if (!current) return;
  worker.requestRender(settings, previewScale());
  // Only show the spinner for slow renders, avoiding flicker during drags.
  clearTimeout(busyTimer);
  busyTimer = window.setTimeout(() => setBusy(true, 'Processing…'), 180);
}

function setBusy(on: boolean, text = 'Processing…') {
  if (!on) clearTimeout(busyTimer);
  $('busy').classList.toggle('hidden', !on && !exporting);
  if (on) $('busy-text').textContent = text;
}

/** Apply settings to the UI, persist and re-render. */
function commit() {
  keepCropAspect();
  syncUI();
  saveSettings();
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

  $('custom-aspect').classList.toggle('hidden', s.output.aspect !== 'custom' || s.output.resolution === 'custom');
  $<HTMLInputElement>('aspect-w').value = String(s.output.customAspectW);
  $<HTMLInputElement>('aspect-h').value = String(s.output.customAspectH);
  $<HTMLSelectElement>('resolution').value = s.output.resolution;
  $('custom-size').classList.toggle('hidden', s.output.resolution !== 'custom');
  $<HTMLInputElement>('custom-w').value = String(s.output.customWidth);
  $<HTMLInputElement>('custom-h').value = String(s.output.customHeight);

  const size = resolveOutputSize(s.output);
  $('size-readout').innerHTML = `Output <b>${size.width} × ${size.height}</b> px<br>Each eye <b>${size.eyeWidth} × ${size.eyeHeight}</b> px`;

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

  const off = effectiveOffsets(s);
  const eye = s.shiftedEye === 'right' ? 'Right' : 'Left';
  const hx = off.dx === 0 ? 'no horizontal shift' : `${fmt(Math.abs(off.dx))} px ${off.dx > 0 ? 'right' : 'left'}`;
  const vy = off.dy === 0 ? 'no vertical shift' : `${fmt(Math.abs(off.dy))} px ${off.dy > 0 ? 'down' : 'up'}`;
  $('offset-summary').innerHTML = `${eye} image: <b>${hx}</b>, <b>${vy}</b><br>${s.shiftedEye === 'right' ? 'Left' : 'Right'} image: original`;

  $<HTMLSelectElement>('resize-interp').value = s.resizeInterpolation;
  $<HTMLSelectElement>('shift-interp').value = s.shiftInterpolation;

  $('quality-field').classList.toggle('hidden', s.exportFormat === 'png');
  $<HTMLInputElement>('quality').value = String(s.exportQuality);
  $('quality-out').textContent = `${Math.round(s.exportQuality * 100)}%`;
  $('export-readout').innerHTML = `<b>${exportName()}</b><br>${size.width} × ${size.height} · ${s.exportFormat === 'png' ? 'lossless' : `quality ${Math.round(s.exportQuality * 100)}%`}`;

  const has = !!current;
  $<HTMLButtonElement>('btn-export').disabled = !has || exporting;
  $<HTMLButtonElement>('btn-export-top').disabled = !has || exporting;
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

function exportName(): string {
  const size = resolveOutputSize(settings.output);
  const ext = settings.exportFormat === 'jpeg' ? 'jpg' : settings.exportFormat;
  const base = (current?.name ?? 'image').replace(/[^\w\-]+/g, '_').slice(0, 60);
  return `${base}_3d_${size.width}x${size.height}.${ext}`;
}

function updateStatus() {
  const i = lastInfo;
  if (!i || !current) {
    $('status').textContent = '';
    return;
  }
  const pct = Math.round(i.renderScale * 1000) / 10;
  const res = pct >= 100 ? 'full resolution' : `${pct}% scale (export is full resolution)`;
  $('status').textContent = `Preview ${res} · Δx ${fmt(i.dx, 3)} px · Δy ${fmt(i.dy, 3)} px · ${i.baseReused ? 'frame cached' : 'frame rebuilt'} · ${Math.round(i.ms)} ms`;
}

// ───────────────────────── import / export ─────────────────────────

async function loadImage(p: Promise<ImportedImage>) {
  setBusy(true, 'Decoding image…');
  try {
    const img = await p;
    current?.bitmap.close();
    current = img;
    lastInfo = null;
    const size = resolveOutputSize(settings.output);
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

async function doExport() {
  if (!current || exporting) return;
  exporting = true;
  syncUI();
  setBusy(true, 'Rendering full resolution…');
  try {
    const r = await worker.exportImage(settings, (stage) => setBusy(true, stage));
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    toast(`Exported ${a.download} (${(r.blob.size / 1048576).toFixed(2)} MB)`);
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`, true);
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

function bindAll() {
  const fileInput = $<HTMLInputElement>('file-input');
  fileInput.accept = ACCEPT_ATTR;
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void loadImage(importFile(f));
    fileInput.value = '';
  });
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
      const f = (e as DragEvent).dataTransfer?.files?.[0];
      if (f) void loadImage(importFile(f));
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

  const onInput = (id: string, apply: (el: HTMLInputElement) => void, ev = 'input') => {
    const el = $<HTMLInputElement>(id);
    el.addEventListener(ev, () => { apply(el); commit(); });
  };
  onInput('aspect-w', (el) => { settings.output.customAspectW = Math.max(0.1, num(el, 9)); }, 'change');
  onInput('aspect-h', (el) => { settings.output.customAspectH = Math.max(0.1, num(el, 16)); }, 'change');
  $<HTMLSelectElement>('resolution').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value as StereoSettings['output']['resolution'];
    if (v === 'custom') {
      const size = resolveOutputSize(settings.output);
      settings.output.customWidth = size.width;
      settings.output.customHeight = size.height;
    }
    settings.output.resolution = v;
    commit();
  });
  onInput('custom-w', (el) => { settings.output.customWidth = num(el, 1080); }, 'change');
  onInput('custom-h', (el) => { settings.output.customHeight = num(el, 1920); }, 'change');
  onInput('scale', (el) => { settings.layout.scale = num(el, 1); });
  onInput('posx', (el) => { settings.layout.posX = num(el, 0.5); });
  onInput('posy', (el) => { settings.layout.posY = num(el, 0.5); });
  $<HTMLSelectElement>('bg-kind').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    settings.background = v === 'color' ? { kind: 'color', color: '#000000' } : v === 'transparent' ? { kind: 'transparent' } : { kind: 'blur', radius: 48 };
    commit();
  });
  onInput('bg-color', (el) => { settings.background = { kind: 'color', color: el.value }; });

  onInput('h-offset', (el) => { settings.horizontalOffset = num(el, 0); });
  onInput('h-offset-num', (el) => { settings.horizontalOffset = clamp(num(el, 0), -1000, 1000); });
  onInput('v-offset', (el) => { settings.verticalOffset = num(el, 0); });
  onInput('v-offset-num', (el) => { settings.verticalOffset = clamp(num(el, 0), -100, 100); });
  onInput('v-enabled', (el) => { settings.verticalEnabled = el.checked; }, 'change');
  document.querySelectorAll<HTMLButtonElement>('[data-chips] button').forEach((b) => {
    b.addEventListener('click', () => {
      const v = Number(b.dataset.value);
      if (b.parentElement!.dataset.chips === 'h') settings.horizontalOffset = v;
      else settings.verticalOffset = v;
      commit();
    });
  });
  $<HTMLSelectElement>('resize-interp').addEventListener('change', (e) => { settings.resizeInterpolation = (e.target as HTMLSelectElement).value as Interpolation; commit(); });
  $<HTMLSelectElement>('shift-interp').addEventListener('change', (e) => { settings.shiftInterpolation = (e.target as HTMLSelectElement).value as Interpolation; commit(); });
  onInput('quality', (el) => { settings.exportQuality = num(el, 0.95); });

  $('btn-export').addEventListener('click', () => void doExport());
  $('btn-export-top').addEventListener('click', () => void doExport());
  $('btn-reset').addEventListener('click', () => {
    settings = cloneSettings(DEFAULT_SETTINGS);
    if (current) {
      const size = resolveOutputSize(settings.output);
      settings.layout.crop = defaultCrop(current.image.width, current.image.height, size.eyeWidth, size.eyeHeight);
    }
    preview.setMode('sbs');
    commit();
    toast('Restored defaults: 1080 × 1920 · 14 px · 0.6 px · PNG');
  });

  document.querySelectorAll<HTMLButtonElement>('#view-mode button').forEach((b) => {
    b.addEventListener('click', () => { preview.setMode(b.dataset.value as ViewMode); syncUI(); });
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

// Expose a tiny hook for automated end-to-end tests.
(window as unknown as { __stereo: unknown }).__stereo = {
  get settings() { return settings; },
  get info() { return lastInfo; },
  get idle() { return worker.idle && !exporting; },
};


