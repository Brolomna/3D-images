/**
 * Application controller: binds the editor UI to the settings model, drives
 * the depth + processing workers and the preview renderer, and runs exports.
 */
import './styles.css';
import { unzipSync, zipSync } from 'fflate';
import type { DepthMap } from './core/depth';
import { composeLayout } from './core/formats';
import { defaultCrop, resolveOutputSize, type FitMode, type StereoFormat } from './core/layout';
import { DEFAULT_WINDOW } from './core/cardlayers';
import {
  cloneSettings, DEFAULT_SETTINGS, effectiveOffsets,
  type AnaglyphMethod, type StereoSettings,
} from './core/settings';
import { motionTiming, type MotionPath } from './core/motion';
import type { StereogramPalette, StereogramPattern, StereogramShape } from './core/autostereogram';
import { downscale, extractPalette, generateBackground, type SceneBackground } from './core/scene';
import { deleteBackground, getBackground, listBackgrounds, saveBackground, type SavedBackground } from './io/backgrounds';
import type { Interpolation, RGBAImage } from './core/types';
import { DepthClient, type DepthProgress } from './depth/client';
import { ACCEPT_ATTR, createSampleImage, importFile, type ImportedImage } from './io/import';
import { PreviewRenderer, type ViewMode } from './ui/preview';
import { deepMerge, settingsFromHash, shareUrl } from './ui/share';
import { StereoWorkerClient } from './worker/client';
import { CardClient, type CardProgress, type CardResult } from './card/client';
import { CardEditor, type PaintTool } from './card/editor';
import { normaliseRaw } from './core/parts';
import { stackToPaint } from './core/cardstack';
import { cardZip } from './card/export';
import { CardViewer } from './card/viewer';
import type { RenderInfo } from './worker/protocol';

const STORAGE_KEY = 'stereo3d.settings.v2';
/** Max pixels per eye rendered for the live preview; export is always full resolution. */
const PREVIEW_MAX_EYE_PIXELS = 2_300_000;
/** Motion-style preview: frames per loop and max pixels per frame. */
const MOTION_PREVIEW_FRAMES = 24;
const MOTION_PREVIEW_PIXELS = 320_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ───────────────────────── state ─────────────────────────

function loadSettings(): StereoSettings {
  const fromLink = settingsFromHash(location.hash);
  if (fromLink) return fromLink;
  const s = cloneSettings(DEFAULT_SETTINGS);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // Migration: settings saved before the sketch stage existed adopt its defaults.
      if (saved?.stereogram && !saved.stereogram.sketch) {
        delete saved.stereogram.shape;
        delete saved.stereogram.cutoff;
      }
      return deepMerge(s, saved);
    }
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
let lastMotionFrame: RGBAImage | null = null;
let lastStereogram: RGBAImage | null = null;
let customTextureLoaded = false;

/** Depth is needed for depth-based stereo and always for the motion style. */
function depthWanted(s = settings): boolean {
  return s.depth.enabled || s.format === 'motion' || s.format === 'stereogram' || s.format === 'card' || s.scene.enabled;
}
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

worker.onRender = ({ left, right, depth, info, motion, special }) => {
  lastInfo = info;
  // Compose the selected format with the same code the exporter uses.
  const output = special ?? composeLayout(left, right, settings.format, settings.arrangement, settings.anaglyphMethod, settings.resizeInterpolation);
  lastStereogram = special;
  preview.setSketch(special?.sketch ?? null);
  let anim: { frames: RGBAImage[]; frameMs: number } | null = null;
  if (settings.format === 'wiggle') anim = { frames: [left, right], frameMs: settings.wiggleFrameMs };
  else if (settings.format === 'motion' && motion) anim = { frames: motion.frames, frameMs: settings.motion.durationMs / motion.frames.length };
  lastMotionFrame = motion?.frames[0] ?? null;
  preview.setWiggleSpeed(settings.wiggleFrameMs);
  preview.setViews(left, right, depth, output, anim);
  updateStyleThumbs(left, right);
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
  if (!current || !depthWanted()) return Promise.resolve(null);
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
    if (cardEditorToken === imageToken) cardEditor.setDepth(normaliseRaw(map));
    void syncScene();
    scheduleRender();
    return map;
  }, (e: Error) => {
    if (token !== imageToken) return null;
    depthState = { kind: 'error', message: e.message };
    syncDepthStatus();
    toast(`Depth analysis failed: ${e.message}. ${settings.format === 'motion' ? 'The 3D photo motion needs depth.' : 'Using the uniform shift.'}`, true);
    return null;
  });
  depthState = { kind: 'running', progress: null, promise };
  syncDepthStatus();
  return promise;
}

function syncDepthStatus() {
  const el = $('depth-status');
  el.className = 'depth-status';
  const on = depthWanted();
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

// ───────────────────────── Layered 3D card ─────────────────────────

const cardClient = new CardClient();
const cardViewer = new CardViewer($('stage'));
const cardEditor = new CardEditor($('stage'));
let cardResult: (CardResult & { key: string }) | null = null;
let cardUrls: string[] = [];
let cardBg: { name: string; image: RGBAImage } | null = null;
let cardBusy = false;
let cardStage: 'paint' | 'preview' = 'paint';
let cardEditorToken = -1;
let cardAutoTimer = 0;
let cardAutoRan = false; // the model has run for this card (threshold changes re-split live)

function cardKey(): string {
  return JSON.stringify({ c: settings.card, m: settings.cardMode, a: settings.cardMode === 'auto' ? settings.cardAuto : null, t: imageToken, bg: cardBg?.name ?? null });
}

/** Depth map of the card normalised to 0..1 (for Auto and magic select). */
function cardDepth(): DepthMap | null {
  return depthState.kind === 'ready' ? normaliseRaw(depthState.map) : null;
}

/** Show the tilt viewer or the paint editor in the Output view for the Layered 3D card style. */
function syncCardView() {
  const on = settings.format === 'card' && preview.mode === 'sbs' && !!current;
  const painting = on && settings.cardMode === 'manual' && cardStage === 'paint';
  if (painting && current && cardEditorToken !== imageToken) {
    cardEditor.setCard(current.image, cardDepth());
    cardEditorToken = imageToken;
  }
  cardEditor.setVisible(painting);
  cardViewer.setVisible(on && !painting);
  if (!on || painting) return;
  if (!cardResult) {
    cardViewer.setLayers(null);
    cardViewer.setMessage(cardBusy ? 'Building the layers…'
      : settings.cardMode === 'auto' ? 'Press “✨ Split automatically” to build the 3D card.'
        : 'Paint the layers, then press “Build 3D card”.');
  } else {
    cardViewer.setMessage(cardResult.key === cardKey() ? '' : 'Settings changed — build again to update.');
  }
}

function syncCardStatus(text = '') {
  const status = $('card-status');
  if (text) return;
  if (!cardBusy && cardResult) {
    const st = cardResult.stack;
    status.className = 'depth-status ok';
    const how = st.mode === 'auto'
      ? `${st.source === 'matte+depth' ? 'cut-out + depth' : st.source === 'matte' ? 'cut-out only' : 'depth only'}${cardResult.model ? ` (${cardResult.model})` : ''}`
      : 'from your painting';
    status.textContent = `✓ ${st.layers.length} layers ${how} · ${(cardResult.ms / 1000).toFixed(1)} s`;
  }
}

function showProgress(p: CardProgress) {
  const status = $('card-status');
  status.className = 'depth-status';
  if (p.total) {
    const pct = Math.round((100 * (p.loaded ?? 0)) / p.total);
    status.innerHTML = `<span>${p.stage} ${pct}%</span><span class="bar"><i style="width:${pct}%"></i></span>`;
  } else {
    status.innerHTML = `<span class="spinner"></span><span>${p.stage}…</span>`;
  }
}

async function toUrl(img: RGBAImage): Promise<string> {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));
  return URL.createObjectURL(blob);
}

async function showStack(r: CardResult, key: string) {
  cardUrls.forEach((u) => URL.revokeObjectURL(u));
  cardUrls = await Promise.all(r.stack.layers.map((l) => toUrl(l.image)));
  cardResult = { ...r, key };
  cardViewer.setLayers({
    win: r.stack.win, size: r.stack.size,
    layers: r.stack.layers.map((l, i) => ({ url: cardUrls[i], role: l.role, still: l.still, motion: l.motion })),
  });
  if (r.stack.threshold != null && settings.cardAuto.threshold == null) {
    $<HTMLInputElement>('card-thr').value = String(r.stack.threshold);
    $('card-thr-out').textContent = `auto (${Math.round(r.stack.threshold * 100)}%)`;
  }
}

/** ✨ Auto split (first run downloads the cut-out model; later runs reuse it). */
async function runCardAuto(): Promise<CardResult | null> {
  if (!current || cardBusy) return null;
  cardBusy = true;
  syncCardView();
  $<HTMLButtonElement>('card-split').disabled = true;
  try {
    if (depthState.kind !== 'ready' && depthState.kind !== 'error') {
      showProgress({ stage: 'Analysing depth' });
      await ensureDepth();
    }
    const key = cardKey();
    const r = await cardClient.auto(String(imageToken), current.image, cardBg?.image ?? null, cardDepth(), settings.card, settings.cardAuto, showProgress);
    await showStack(r, key);
    cardAutoRan = true;
    return r;
  } catch (e) {
    const status = $('card-status');
    status.className = 'depth-status err';
    status.textContent = `Could not split the card: ${(e as Error).message}`;
    toast(`Layered 3D card failed: ${(e as Error).message}`, true);
    return null;
  } finally {
    cardBusy = false;
    $<HTMLButtonElement>('card-split').disabled = false;
    syncCardStatus();
    syncCardView();
  }
}

/** Re-split live when Auto settings change (only once the model has run for this card). */
function scheduleCardAuto() {
  if (settings.format !== 'card' || settings.cardMode !== 'auto' || !cardAutoRan) return;
  clearTimeout(cardAutoTimer);
  cardAutoTimer = window.setTimeout(() => void runCardAuto(), 250);
}

/** ✏️ Build the stack from the painted masks. */
async function runCardManual() {
  if (!current || cardBusy) return;
  if (!cardEditor.painted()) { toast('Paint at least one layer first (or use “Start from Auto”).', true); return; }
  cardBusy = true;
  showProgress({ stage: 'Building the layers' });
  try {
    const key = cardKey();
    const r = await cardClient.manual(current.image, cardEditor.layers, cardEditor.mw, cardEditor.mh, cardDepth(), settings.card);
    await showStack(r, key);
    cardStage = 'preview';
  } catch (e) {
    toast(`Could not build the card: ${(e as Error).message}`, true);
  } finally {
    cardBusy = false;
    syncCardStatus();
    syncUI();
  }
}

function renderLayerList() {
  const box = $('card-layer-list');
  box.innerHTML = '';
  cardEditor.layers.forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'layer-item';
    row.setAttribute('role', 'radio');
    row.setAttribute('aria-checked', String(i === cardEditor.active));
    row.innerHTML = `<span class="sw" style="background:rgb(${l.color.join(',')})"></span><span>${escapeHtml(l.name)}</span>`
      + `<label title="This layer stays still"><input type="checkbox" ${l.still ? 'checked' : ''}> still</label>`
      + (l.role === 'mid' ? '<button title="Remove layer" aria-label="Remove layer">×</button>' : '<span></span>');
    row.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT') { cardEditor.setStill(i, (t as HTMLInputElement).checked); return; }
      if (t.tagName === 'BUTTON') { cardEditor.removeLayer(i); return; }
      cardEditor.active = i;
      renderLayerList();
    });
    box.appendChild(row);
  });
  $<HTMLButtonElement>('card-undo').disabled = !cardEditor.canUndo();
  $<HTMLButtonElement>('card-redo').disabled = !cardEditor.canRedo();
}
cardEditor.onChange = () => renderLayerList();

// ───────────────────────── 3D Scene ─────────────────────────

let sceneKey = '';
let sceneTimer = 0;
let loadedBgId: string | null = null;
let savedBgs: SavedBackground[] = [];
let sceneShown = false;

function scheduleSceneSync() {
  clearTimeout(sceneTimer);
  sceneTimer = window.setTimeout(() => void syncScene(), 250);
}

/** Send the scene settings to the worker when they (or the photo / depth) change. */
async function syncScene() {
  if (!current) return;
  const sc = settings.scene;
  const key = JSON.stringify({ sc: sc.enabled ? sc : false, t: imageToken, d: depthState.kind === 'ready' });
  if (key === sceneKey) return;
  sceneKey = key;
  const status = $('scene-status');
  if (sc.enabled && depthState.kind !== 'ready') {
    status.innerHTML = '<span class="spinner"></span><span>Waiting for the depth map…</span>';
    return;
  }
  try {
    if (sc.enabled && sc.background === 'custom' && sc.customId && sc.customId !== loadedBgId) {
      const bg = savedBgs.find((b) => b.id === sc.customId) ?? (await getBackground(sc.customId));
      if (bg) {
        await worker.setSceneBackground({ image: bg.image, depth: bg.depth });
        loadedBgId = bg.id;
      }
    }
    if (sc.enabled) setBusy(true, 'Building 3D scene…');
    const r = await worker.setScene(sc);
    if (r.applied && r.preview) {
      const bmp = await createImageBitmap(new ImageData(r.preview.data as Uint8ClampedArray<ArrayBuffer>, r.preview.width, r.preview.height));
      preview.setOriginal(bmp);
      sceneShown = true;
      status.className = 'depth-status ok';
      status.textContent = `✓ Scene ready (${(r.ms / 1000).toFixed(1)} s)`;
    } else {
      if (sceneShown && current) preview.setOriginal(current.bitmap);
      sceneShown = false;
      status.className = 'depth-status';
      status.textContent = '';
    }
  } catch (e) {
    toast(`3D Scene failed: ${(e as Error).message}`, true);
  } finally {
    setBusy(false);
    scheduleRender();
  }
}

function drawSceneSwatches() {
  const palette = current ? extractPalette(downscale(current.image, 200), () => 1) : null;
  document.querySelectorAll<HTMLButtonElement>('#scene-grid .scene-card').forEach((card) => {
    const kind = card.dataset.value as SceneBackground;
    const c = card.querySelector('canvas')!;
    const g = c.getContext('2d')!;
    if (kind === 'original') {
      g.fillStyle = '#0b0c0f';
      g.fillRect(0, 0, c.width, c.height);
      if (current) {
        const k = Math.max(c.width / current.bitmap.width, c.height / current.bitmap.height);
        g.drawImage(current.bitmap, (c.width - current.bitmap.width * k) / 2, (c.height - current.bitmap.height * k) / 2, current.bitmap.width * k, current.bitmap.height * k);
      }
      return;
    }
    const pal = palette ?? [[40, 50, 40], [80, 110, 70], [140, 160, 110], [200, 190, 150], [240, 235, 210]];
    const layer = generateBackground(kind as Exclude<SceneBackground, 'custom' | 'original'>, c.width, c.height, pal as [number, number, number][], 1);
    g.putImageData(new ImageData(layer.image.data as Uint8ClampedArray<ArrayBuffer>, c.width, c.height), 0, 0);
  });
}

function renderCustomBackgrounds() {
  const box = $('scene-custom');
  box.innerHTML = '';
  for (const bg of savedBgs) {
    const b = document.createElement('button');
    b.className = 'scene-card';
    b.dataset.id = bg.id;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(settings.scene.background === 'custom' && settings.scene.customId === bg.id));
    b.innerHTML = `<img alt="" src="${bg.thumb}"><span title="${escapeHtml(bg.name)}">${escapeHtml(bg.name)}</span>`;
    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Delete this background';
    del.textContent = '×';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteBackground(bg.id);
      savedBgs = savedBgs.filter((x) => x.id !== bg.id);
      if (settings.scene.customId === bg.id) { settings.scene.customId = null; settings.scene.background = 'auto'; }
      renderCustomBackgrounds();
      commit();
    });
    b.appendChild(del);
    b.addEventListener('click', () => {
      settings.scene.background = 'custom';
      settings.scene.customId = bg.id;
      commit();
    });
    box.appendChild(b);
  }
}

async function addCustomBackgrounds(files: File[]) {
  for (const f of files) {
    try {
      setBusy(true, `Adding background "${f.name}"…`);
      const imported = await importFile(f);
      imported.bitmap.close();
      const img = downscale(imported.image, 1600);
      setBusy(true, `Analysing depth of "${f.name}"…`);
      const depth = await depthClient.estimate(img);
      const saved = await saveBackground(imported.name, img, depth);
      savedBgs.push(saved);
      settings.scene.background = 'custom';
      settings.scene.customId = saved.id;
    } catch (e) {
      toast(`Could not add ${f.name}: ${(e as Error).message}`, true);
    }
  }
  setBusy(false);
  settings.scene.enabled = true;
  renderCustomBackgrounds();
  commit();
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
  let motion: { frames: number; scale: number } | null = null;
  if (settings.format === 'motion') {
    const s = outputSize();
    const cap = Math.sqrt(MOTION_PREVIEW_PIXELS / (s.eyeWidth * s.eyeHeight));
    motion = { frames: MOTION_PREVIEW_FRAMES, scale: Math.min(previewScale(), cap) };
  }
  worker.requestRender(settings, previewScale(), preview.mode === 'depth', motion);
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
  if (depthWanted() && current) void ensureDepth();
  scheduleSceneSync();
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
  anaglyph: 'Anaglyph', wiggle: 'Wiggle', mpo: 'MPO', motion: '3D photo motion', stereogram: 'Stereogram', card: 'Layered 3D card',
};

// ───────────────────────── 3D style picker ─────────────────────────

/** Downscale an RGBA image to a small canvas-backed RGBA (for style thumbnails). */
function shrink(img: RGBAImage, maxH: number): RGBAImage {
  const s = Math.min(1, maxH / img.height);
  // Even sizes so half-width / half-height styles split exactly.
  const w = Math.max(2, 2 * Math.round((img.width * s) / 2)), h = Math.max(2, 2 * Math.round((img.height * s) / 2));
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  const dst = new OffscreenCanvas(w, h);
  const g = dst.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  return { width: w, height: h, data: g.getImageData(0, 0, w, h).data };
}

let thumbTimer = 0;
/** Live thumbnails of the photo in every 3D style (throttled). */
function updateStyleThumbs(left: RGBAImage, right: RGBAImage) {
  clearTimeout(thumbTimer);
  thumbTimer = window.setTimeout(() => {
    const l = shrink(left, 120), r = shrink(right, 120);
    document.querySelectorAll<HTMLButtonElement>('.style-card').forEach((card) => {
      const f = card.dataset.value as StereoFormat;
      let img: RGBAImage;
      if (f === 'wiggle') img = l;
      else if (f === 'motion') img = lastMotionFrame ? shrink(lastMotionFrame, 120) : l;
      else if (f === 'stereogram') img = lastStereogram ? shrink(lastStereogram, 120) : l;
      else if (f === 'card') img = l;
      else img = composeLayout(l, r, f === 'mpo' ? 'sbs' : f, settings.arrangement, settings.anaglyphMethod, 'bilinear');
      const c = card.querySelector('canvas')!;
      const g = c.getContext('2d')!;
      g.clearRect(0, 0, c.width, c.height);
      // Contain-fit the composed style into the card.
      const tmp = new OffscreenCanvas(img.width, img.height);
      tmp.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
      const k = Math.min(c.width / img.width, c.height / img.height);
      const w = img.width * k, h = img.height * k;
      g.imageSmoothingQuality = 'high';
      g.drawImage(tmp, (c.width - w) / 2, (c.height - h) / 2, w, h);
      if (f === 'wiggle' || f === 'motion' || f === 'mpo' || f === 'card') {
        g.font = '600 15px system-ui, sans-serif';
        const tag = f === 'wiggle' ? 'L ⇄ R' : f === 'motion' ? '▶ motion' : f === 'card' ? '3 layers' : '2 JPEGs';
        const tw = g.measureText(tag).width + 12;
        g.fillStyle = 'rgba(14,15,18,0.85)';
        g.fillRect(c.width - tw - 6, c.height - 26, tw, 20);
        g.fillStyle = '#e7e9ee';
        g.textBaseline = 'middle';
        g.fillText(tag, c.width - tw, c.height - 16);
      }
    });
  }, 250);
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
  setSeg('wiggleFile', s.wiggleFile);

  $('custom-aspect').classList.toggle('hidden', s.output.aspect !== 'custom' || s.output.resolution === 'custom');
  $<HTMLInputElement>('aspect-w').value = String(s.output.customAspectW);
  $<HTMLInputElement>('aspect-h').value = String(s.output.customAspectH);
  $<HTMLSelectElement>('resolution').value = s.output.resolution;
  $('custom-size').classList.toggle('hidden', s.output.resolution !== 'custom');
  $<HTMLInputElement>('custom-w').value = String(s.output.customWidth);
  $<HTMLInputElement>('custom-h').value = String(s.output.customHeight);

  const size = outputSize();
  const multi = s.format === 'wiggle' || s.format === 'motion' ? 'Each frame' : s.format === 'mpo' ? 'Each image' : 'Output';
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

  // 3D Scene
  const sc = s.scene;
  $<HTMLInputElement>('scene-enabled').checked = sc.enabled;
  $('scene-enabled').parentElement!.querySelector('em')!.textContent = sc.enabled ? 'On' : 'Off';
  $('scene-controls').classList.toggle('hidden', !sc.enabled);
  document.querySelectorAll<HTMLElement>('#scene-grid .scene-card').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.value === sc.background)));
  document.querySelectorAll<HTMLElement>('#scene-custom .scene-card').forEach((c) => c.setAttribute('aria-checked', String(sc.background === 'custom' && c.dataset.id === sc.customId)));
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  $<HTMLInputElement>('scene-bgdepth').value = String(sc.backgroundDepth); $('scene-bgdepth-out').textContent = pct(sc.backgroundDepth);
  $<HTMLInputElement>('scene-pop').value = String(sc.subjectPop); $('scene-pop-out').textContent = pct(sc.subjectPop);
  $<HTMLInputElement>('scene-sep').value = String(sc.separation); $('scene-sep-out').textContent = pct(sc.separation);
  $<HTMLInputElement>('scene-edge').value = String(sc.edge); $('scene-edge-out').textContent = pct(sc.edge);
  $<HTMLInputElement>('scene-thr').value = String(sc.threshold);
  $('scene-thr-out').textContent = Math.abs(sc.threshold) < 0.005 ? 'auto' : `auto ${sc.threshold > 0 ? '+' : '−'}${Math.round(Math.abs(sc.threshold) * 100)}`;
  $<HTMLInputElement>('scene-shadow').checked = sc.shadow;

  // Depth
  const d = s.depth;
  $<HTMLInputElement>('depth-enabled').checked = d.enabled;
  $('depth-enabled').parentElement!.querySelector('em')!.textContent = d.enabled ? 'On' : 'Off';
  $('depth-controls').classList.toggle('hidden', !d.enabled);
  $<HTMLInputElement>('depth-strength').value = String(d.strength);
  $('depth-strength-out').textContent = `${fmt(d.strength, 1)} px`;
  $<HTMLInputElement>('depth-focus').value = String(d.focus);
  $('depth-focus-out').textContent = d.focus <= 0.02 ? 'far' : d.focus >= 0.98 ? 'near' : `${Math.round(d.focus * 100)}%`;
  $<HTMLInputElement>('depth-contrast').value = String(d.contrast ?? 0);
  $('depth-contrast-out').textContent = (d.contrast ?? 0) === 0 ? 'off' : `${Math.round((d.contrast ?? 0) * 100)}%`;
  {
    // Warn when the disparity exceeds what most viewers can fuse comfortably.
    const eyeW = outputSize().eyeWidth;
    const total = d.strength * Math.max(d.focus, 1 - d.focus) + Math.abs(s.horizontalOffset);
    const pct = (100 * total) / eyeW;
    const w = $('depth-warning');
    const stereo = !['motion', 'stereogram'].includes(s.format);
    w.classList.toggle('hidden', !(d.enabled && stereo && pct > 6));
    w.textContent = pct > 12
      ? `Extreme depth (up to ${Math.round(total)} px ≈ ${Math.round(pct)}% of the eye width): dramatic in Wiggle, Anaglyph and VR, but hard to fuse by free-viewing. Edges around the subject may stretch.`
      : `Strong depth (up to ${Math.round(total)} px ≈ ${Math.round(pct)}% of the eye width): above the usual comfort range (~3–6%).`;
  }
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

  // 3D style + export
  const still = s.format !== 'wiggle' && s.format !== 'mpo' && s.format !== 'motion';
  document.querySelectorAll<HTMLElement>('.style-card').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.value === s.format)));
  setSeg('motionPath', s.motion.path);
  setSeg('motionFile', s.motion.file);
  $('motion-options').classList.toggle('hidden', s.format !== 'motion');
  const cd = s.card;
  $('card-options').classList.toggle('hidden', s.format !== 'card');
  setSeg('cardMode', s.cardMode);
  $('card-auto').classList.toggle('hidden', s.cardMode !== 'auto');
  $('card-manual').classList.toggle('hidden', s.cardMode !== 'manual');
  setSeg('cardExtra', String(s.cardAuto.extraLayers));
  if (s.cardAuto.threshold != null) {
    $<HTMLInputElement>('card-thr').value = String(s.cardAuto.threshold);
    $('card-thr-out').textContent = `${Math.round(s.cardAuto.threshold * 100)}%`;
  } else if (!cardResult?.stack.threshold) {
    $('card-thr-out').textContent = 'auto';
  }
  setSeg('cardStage', cardStage);
  setSeg('cardTool', cardEditor.tool);
  $('card-tol-field').classList.toggle('hidden', cardEditor.tool !== 'magic');
  $('card-size-field').classList.toggle('hidden', cardEditor.tool === 'magic');
  $('card-soft-field').classList.toggle('hidden', cardEditor.tool === 'magic');
  $<HTMLInputElement>('card-size').value = String(cardEditor.size);
  $('card-size-out').textContent = `${cardEditor.size} px`;
  $<HTMLInputElement>('card-soft').value = String(cardEditor.softness);
  $('card-soft-out').textContent = `${Math.round(cardEditor.softness * 100)}%`;
  $<HTMLInputElement>('card-tol').value = String(cardEditor.tolerance);
  $('card-tol-out').textContent = `${Math.round(cardEditor.tolerance * 100)}%`;
  renderLayerList();
  $<HTMLInputElement>('card-banner').checked = !cd.noBanner;
  $('card-band-row').classList.toggle('hidden', cd.noBanner);
  $<HTMLInputElement>('card-band0').value = String(Math.round(cd.bannerBand[0] * 1000) / 10);
  $<HTMLInputElement>('card-band1').value = String(Math.round(cd.bannerBand[1] * 1000) / 10);
  $<HTMLInputElement>('card-drophue').checked = !!cd.dropHue;
  $<HTMLInputElement>('card-winauto').checked = !cd.window;
  $('card-win-row').classList.toggle('hidden', !cd.window);
  const wv = cd.window ?? DEFAULT_WINDOW;
  (['card-wx0', 'card-wy0', 'card-wx1', 'card-wy1'] as const).forEach((id, i) => { $<HTMLInputElement>(id).value = String(Math.round(wv[i] * 1000) / 10); });
  $<HTMLInputElement>('card-ext0').value = String(cd.extend[0]);
  $<HTMLInputElement>('card-ext1').value = String(cd.extend[1]);
  $('card-bg-name').textContent = cardBg ? `Using “${cardBg.name}”` : 'None — the area behind the character is filled automatically.';
  $<HTMLButtonElement>('card-bg-clear').disabled = !cardBg;
  syncCardView();
  const sg = s.stereogram;
  $('stereogram-options').classList.toggle('hidden', s.format !== 'stereogram');
  setSeg('sgPattern', sg.pattern);
  setSeg('sgShape', sg.shape);
  setSeg('sgViewing', sg.viewing);
  $<HTMLSelectElement>('sg-palette').value = sg.palette;
  $<HTMLInputElement>('sg-repeats').value = String(sg.repeats);
  $('sg-repeats-out').textContent = `${sg.repeats}× · ${Math.round(outputSize().width / sg.repeats)} px`;
  $<HTMLInputElement>('sg-depth').value = String(sg.depth);
  $('sg-depth-out').textContent = `${Math.round(sg.depth * 100)}%`;
  $('sg-depth-warning').classList.toggle('hidden', sg.depth <= 0.5);
  $<HTMLInputElement>('sg-cutoff').value = String(sg.cutoff);
  $('sg-cutoff-out').textContent = `${Math.round(sg.cutoff * 100)}%`;
  const sketchMode = sg.shape === 'sketch';
  $('sketch-controls').classList.toggle('hidden', !sketchMode);
  $('sg-cutoff-field').classList.toggle('hidden', sketchMode);
  const sub = sg.sketch.subject ?? 0;
  $<HTMLInputElement>('sk-subject').value = String(sub);
  $('sk-subject-out').textContent = Math.abs(sub) < 0.005 ? 'auto' : `auto ${sub > 0 ? '+' : '−'}${Math.round(Math.abs(sub) * 100)}`;
  const sk = sg.sketch;
  setSeg('skMode', sk.lineMode);
  $<HTMLInputElement>('sk-thick').value = String(sk.thickness);
  $('sk-thick-out').textContent = `${fmt(sk.thickness, 1)} px`;
  $<HTMLInputElement>('sk-detail').value = String(sk.detail);
  $('sk-detail-out').textContent = `${Math.round(sk.detail * 100)}%`;
  $<HTMLInputElement>('sk-height').value = String(sk.lineHeight);
  $('sk-height-out').textContent = `${Math.round(sk.lineHeight * 100)}%`;
  $<HTMLInputElement>('sk-round').value = String(sk.rounding);
  $('sk-round-out').textContent = `${Math.round(sk.rounding * 100)}%`;
  $<HTMLInputElement>('sg-guides').checked = sg.guides;
  $<HTMLInputElement>('motion-amount').value = String(s.motion.amplitude);
  $('motion-amount-out').textContent = `${s.motion.amplitude} px`;
  $<HTMLInputElement>('motion-duration').value = String(s.motion.durationMs);
  $('motion-duration-out').textContent = `${fmt(s.motion.durationMs / 1000, 2)} s`;
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
  const timing = motionTiming(s.motion);
  const detail = s.format === 'wiggle'
    ? `${s.wiggleFrames} frames · ${s.wiggleFrameMs} ms${s.wiggleFile === 'video' ? ' · ≥3 s loop' : ''}`
    : s.format === 'motion'
      ? `${timing.count} frames · ${fmt(s.motion.durationMs / 1000, 2)} s loop · ${s.motion.file === 'gif' ? 'GIF' : 'MP4'}`
      : lossy ? `quality ${Math.round(s.exportQuality * 100)}%` : 'lossless';
  $('export-readout').innerHTML = `<b>${exportName()}</b><br>${FORMAT_LABEL[s.format]} · ${size.width} × ${size.height} · ${detail}`;

  const has = !!current;
  $<HTMLButtonElement>('btn-export').disabled = !has || exporting;
  $<HTMLButtonElement>('btn-export-top').disabled = !has || exporting;
  $<HTMLButtonElement>('btn-batch').disabled = exporting;
  for (const id of ['dl-depth', 'dl-views', 'dl-frames', 'dl-parts']) $<HTMLButtonElement>(id).disabled = !has || exporting;
  $('dl-frames').classList.toggle('hidden', s.format !== 'wiggle' && s.format !== 'motion');
  $('dl-frames').textContent = s.format === 'motion' ? `Motion frames as pictures (${motionTiming(s.motion).count})` : `Wiggle frames as pictures (${s.wiggleFrames})`;
  $('dl-hint').textContent = partsHint(s);
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
  if (s.format === 'motion') return s.motion.file === 'gif' ? 'gif' : 'mp4';
  if (s.format === 'card') return 'zip';
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
  const depth = i.depthUsed ? 'depth on' : depthWanted() ? 'depth pending' : 'uniform';
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
    sceneShown = false;
    drawSceneSwatches();
    cardResult = null;
    cardAutoRan = false;
    cardEditorToken = -1;
    cardViewer.setLayers(null);
    $('card-status').textContent = '';
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
  if (settings.format === 'card') {
    if (!cardResult) { toast('Split the card into layers first.', true); return; }
    exporting = true;
    syncUI();
    try {
      setBusy(true, 'Packing the layers…');
      const zip = await cardZip(cardResult.stack);
      const name = `${baseName(current.name)}_3d_card_layers.zip`;
      download(zip, name);
      toast(`Exported ${name} — frame, character, background, layers.json and a viewer.html`);
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`, true);
    } finally {
      exporting = false;
      setBusy(false);
      syncUI();
    }
    return;
  }
  exporting = true;
  syncUI();
  try {
    if (depthWanted() && depthState.kind !== 'ready' && depthState.kind !== 'error') {
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

/** "More downloads": the pictures behind the current style as separate files. */
async function downloadParts(kind: 'depth' | 'views' | 'frames' | 'all') {
  if (!current || exporting) return;
  exporting = true;
  syncUI();
  try {
    const needsDepth = kind === 'depth' || kind === 'all' || settings.format === 'motion' || settings.format === 'stereogram' || settings.scene.enabled;
    if (needsDepth && depthState.kind !== 'ready') {
      setBusy(true, 'Waiting for depth analysis…');
      const map = await ensureDepth();
      if (!map) throw new Error('The depth map is not available.');
    }
    setBusy(true, 'Preparing downloads…');
    const files = await worker.exportParts(settings, kind, (stage) => setBusy(true, stage));
    if (kind === 'all' && settings.format === 'card' && cardResult) {
      const zipped = unzipSync(new Uint8Array(await (await cardZip(cardResult.stack)).arrayBuffer()));
      for (const [name, bytes] of Object.entries(zipped)) files.push({ name: `card_${name}`, bytes });
    }
    const base = baseName(current.name);
    if (files.length === 1) {
      download(new Blob([files[0].bytes as BlobPart], { type: 'image/png' }), `${base}_${files[0].name}`);
      toast(`Downloaded ${base}_${files[0].name}`);
    } else {
      const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
      for (const f of files) entries[f.name] = [f.bytes, { level: /\.(png|webp|jpe?g)$/.test(f.name) ? 0 : 6 }];
      const label = { depth: 'depth_maps', views: 'views', frames: 'frames', all: 'parts' }[kind];
      const name = `${base}_3d_${label}.zip`;
      download(new Blob([zipSync(entries) as BlobPart], { type: 'application/zip' }), name);
      toast(`Downloaded ${name} (${files.length} files)`);
    }
  } catch (e) {
    toast(`Download failed: ${(e as Error).message}`, true);
  } finally {
    exporting = false;
    setBusy(false);
    syncUI();
  }
}

function partsHint(s: StereoSettings): string {
  const common = 'Depth maps are 16-bit grayscale PNGs (bright = near): one matching the output framing, one for the whole photo.';
  const extra: Record<string, string> = {
    wiggle: `Frames: the ${s.wiggleFrames} pictures the wiggle flips through — left view, ${s.wiggleFrames > 2 ? 'in-between views, ' : ''}right view.`,
    motion: `Frames: all ${motionTiming(s.motion).count} pictures of the motion loop.`,
    stereogram: 'All parts adds the stereogram, its sketch and the hidden 3D shape.',
    card: 'All parts adds the card layers (frame, character, background).',
  };
  const scene = s.scene.enabled ? ' With 3D Scene on, All parts also includes the cut-out subject (transparent PNG), the new background and the scene depth.' : '';
  return `${common} ${extra[s.format] ?? 'All parts: left and right views, the finished output and the depth maps.'}${scene}`;
}

/** Batch mode: apply the current settings to many photos and download a ZIP. */
async function runBatch(files: File[]) {
  if (exporting || !files.length) return;
  if (settings.format === 'card') { toast('Batch export is not available for Layered 3D cards — split one card at a time.', true); return; }
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
      if (depthWanted(s)) {
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
  // Layered 3D card
  $('card-split').addEventListener('click', () => void runCardAuto());
  bindSeg('cardMode', (v) => { settings.cardMode = v as 'auto' | 'manual'; cardStage = 'paint'; });
  bindSeg('cardExtra', (v) => { settings.cardAuto.extraLayers = Number(v) || 0; scheduleCardAuto(); });
  onInput('card-thr', (el) => { settings.cardAuto.threshold = num(el, 0.5); scheduleCardAuto(); });
  $('card-thr-auto').addEventListener('click', () => { settings.cardAuto.threshold = null; commit(); scheduleCardAuto(); });
  document.querySelectorAll<HTMLButtonElement>('.seg[data-setting="cardStage"] button').forEach((b) => b.addEventListener('click', () => {
    cardStage = b.dataset.value as 'paint' | 'preview';
    syncUI();
  }));
  document.querySelectorAll<HTMLButtonElement>('.seg[data-setting="cardTool"] button').forEach((b) => b.addEventListener('click', () => {
    cardEditor.tool = b.dataset.value as PaintTool;
    syncUI();
  }));
  $('card-add-layer').addEventListener('click', () => cardEditor.addLayer());
  $('card-undo').addEventListener('click', () => cardEditor.doUndo());
  $('card-redo').addEventListener('click', () => cardEditor.doRedo());
  $('card-build').addEventListener('click', () => void runCardManual());
  $('card-from-auto').addEventListener('click', async () => {
    if (!current) return;
    const r = cardResult?.stack.mode === 'auto' ? cardResult : await runCardAuto();
    if (!r) return;
    if (cardEditorToken !== imageToken) { cardEditor.setCard(current.image, cardDepth()); cardEditorToken = imageToken; }
    cardEditor.setLayers(stackToPaint(r.stack, cardEditor.mw, cardEditor.mh));
    settings.cardMode = 'manual';
    cardStage = 'paint';
    commit();
  });
  const editorInput = (id: string, apply: (v: number) => void) => $<HTMLInputElement>(id).addEventListener('input', (e) => { apply(Number((e.target as HTMLInputElement).value)); syncUI(); });
  editorInput('card-size', (v) => { cardEditor.size = v; });
  editorInput('card-soft', (v) => { cardEditor.softness = v; });
  editorInput('card-tol', (v) => { cardEditor.tolerance = v; });
  const cardBgInput = $<HTMLInputElement>('card-bg-input');
  cardBgInput.accept = ACCEPT_ATTR;
  $('card-bg-add').addEventListener('click', () => cardBgInput.click());
  cardBgInput.addEventListener('change', async () => {
    const f = cardBgInput.files?.[0];
    cardBgInput.value = '';
    if (!f) return;
    try {
      const img = await importFile(f);
      img.bitmap.close();
      cardBg = { name: img.name, image: img.image };
      syncUI();
    } catch (e) { toast((e as Error).message, true); }
  });
  $('card-bg-clear').addEventListener('click', () => { cardBg = null; syncUI(); });
  onInput('card-banner', (el) => { settings.card.noBanner = !el.checked; scheduleCardAuto(); }, 'change');
  onInput('card-band0', (el) => { settings.card.bannerBand[0] = clamp(num(el, 62), 0, 100) / 100; }, 'change');
  onInput('card-band1', (el) => { settings.card.bannerBand[1] = clamp(num(el, 69.5), 0, 100) / 100; }, 'change');
  onInput('card-drophue', (el) => { settings.card.dropHue = el.checked ? [300, 345] : null; scheduleCardAuto(); }, 'change');
  onInput('card-winauto', (el) => { settings.card.window = el.checked ? null : [...DEFAULT_WINDOW]; }, 'change');
  (['card-wx0', 'card-wy0', 'card-wx1', 'card-wy1'] as const).forEach((id, i) => {
    onInput(id, (el) => {
      const w = settings.card.window ?? [...DEFAULT_WINDOW] as [number, number, number, number];
      w[i] = clamp(num(el, w[i] * 100), 0, 100) / 100;
      settings.card.window = w;
    }, 'change');
  });
  onInput('card-ext0', (el) => { settings.card.extend[0] = clamp(Math.round(num(el, 100)), 0, 400); }, 'change');
  onInput('card-ext1', (el) => { settings.card.extend[1] = clamp(Math.round(num(el, 70)), 0, 400); }, 'change');

  // 3D Scene
  onInput('scene-enabled', (el) => { settings.scene.enabled = el.checked; }, 'change');
  document.querySelectorAll<HTMLButtonElement>('#scene-grid .scene-card').forEach((b) => {
    b.addEventListener('click', () => {
      settings.scene.background = b.dataset.value as SceneBackground;
      settings.scene.enabled = true;
      commit();
    });
  });
  const sceneBgInput = $<HTMLInputElement>('scene-bg-input');
  sceneBgInput.accept = ACCEPT_ATTR;
  $('scene-add').addEventListener('click', () => sceneBgInput.click());
  sceneBgInput.addEventListener('change', () => {
    const files = imageFiles(sceneBgInput.files);
    sceneBgInput.value = '';
    if (files.length) void addCustomBackgrounds(files);
  });
  onInput('scene-bgdepth', (el) => { settings.scene.backgroundDepth = num(el, 0.8); });
  onInput('scene-pop', (el) => { settings.scene.subjectPop = num(el, 0.5); });
  onInput('scene-sep', (el) => { settings.scene.separation = num(el, 0.5); });
  onInput('scene-edge', (el) => { settings.scene.edge = num(el, 0.3); });
  onInput('scene-thr', (el) => { settings.scene.threshold = num(el, 0); });
  onInput('scene-shadow', (el) => { settings.scene.shadow = el.checked; }, 'change');
  $('scene-shuffle').addEventListener('click', () => { settings.scene.seed = (settings.scene.seed % 9973) + 1; commit(); });

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
  onInput('depth-contrast', (el) => { settings.depth.contrast = num(el, 0); });
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
  document.querySelectorAll<HTMLButtonElement>('.style-card').forEach((card) => {
    card.addEventListener('click', () => {
      settings.format = card.dataset.value as StereoFormat;
      if (preview.mode !== 'sbs' && preview.mode !== 'crop') preview.setMode('sbs');
      commit();
    });
  });
  bindSeg('motionPath', (v) => { settings.motion.path = v as MotionPath; });
  bindSeg('sgShape', (v) => { settings.stereogram.shape = v as StereogramShape; });
  bindSeg('sgViewing', (v) => { settings.stereogram.viewing = v as 'parallel' | 'cross'; });
  document.querySelectorAll<HTMLButtonElement>('.seg[data-setting="sgPattern"] button').forEach((b) => {
    b.addEventListener('click', () => {
      const v = b.dataset.value as StereogramPattern;
      if (v === 'custom' && !customTextureLoaded) { $<HTMLInputElement>('texture-input').click(); return; }
      settings.stereogram.pattern = v;
      commit();
    });
  });
  $<HTMLInputElement>('texture-input').addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      const t = await importFile(f);
      t.bitmap.close();
      // Keep textures modest: the tile is at most the output height anyway.
      await worker.setTexture(t.image);
      customTextureLoaded = true;
      settings.stereogram.pattern = 'custom';
      commit();
      toast(`Texture "${t.name}" loaded`);
    } catch (err) {
      toast((err as Error).message, true);
    }
  });
  bindSeg('skMode', (v) => { settings.stereogram.sketch.lineMode = v as 'raised' | 'engraved'; });
  onInput('sk-thick', (el) => { settings.stereogram.sketch.thickness = num(el, 5); });
  onInput('sk-detail', (el) => { settings.stereogram.sketch.detail = num(el, 0.5); });
  onInput('sk-height', (el) => { settings.stereogram.sketch.lineHeight = num(el, 0.5); });
  onInput('sk-round', (el) => { settings.stereogram.sketch.rounding = num(el, 0.6); });
  onInput('sk-subject', (el) => { settings.stereogram.sketch.subject = num(el, 0); });
  onSelect('sg-palette', (v) => { settings.stereogram.palette = v as StereogramPalette; });
  onInput('sg-repeats', (el) => { settings.stereogram.repeats = num(el, 6); });
  onInput('sg-depth', (el) => { settings.stereogram.depth = num(el, 0.33); });
  onInput('sg-cutoff', (el) => { settings.stereogram.cutoff = num(el, 0.25); });
  onInput('sg-guides', (el) => { settings.stereogram.guides = el.checked; }, 'change');
  $('sg-shuffle').addEventListener('click', () => { settings.stereogram.seed = (settings.stereogram.seed % 9973) + 1; commit(); });
  bindSeg('motionFile', (v) => { settings.motion.file = v as 'video' | 'gif'; });
  onInput('motion-amount', (el) => { settings.motion.amplitude = num(el, 20); });
  onInput('motion-duration', (el) => { settings.motion.durationMs = num(el, 3000); });
  onSelect('anaglyph-method', (v) => { settings.anaglyphMethod = v as AnaglyphMethod; });
  onSelect('wiggle-frames', (v) => { settings.wiggleFrames = Number(v) || 2; });
  onInput('wiggle-ms', (el) => { settings.wiggleFrameMs = num(el, 140); });
  onInput('quality', (el) => { settings.exportQuality = num(el, 0.95); });

  $('btn-export').addEventListener('click', () => void doExport());
  $('dl-depth').addEventListener('click', () => void downloadParts('depth'));
  $('dl-views').addEventListener('click', () => void downloadParts('views'));
  $('dl-frames').addEventListener('click', () => void downloadParts('frames'));
  $('dl-parts').addEventListener('click', () => void downloadParts('all'));
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
  // Mobile: bottom tab bar shows one control section at a time.
  document.querySelectorAll<HTMLButtonElement>('#mobile-tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      const tab = b.dataset.tab!;
      $('app').dataset.tab = tab;
      document.querySelectorAll<HTMLButtonElement>('#mobile-tabs button').forEach((x) => {
        if (x === b) x.setAttribute('aria-current', 'page');
        else x.removeAttribute('aria-current');
      });
      // Bring the newly shown controls to the top, just under the preview.
      const first = document.querySelector<HTMLElement>(`.group[data-tab="${tab}"]`);
      if (first && window.matchMedia('(max-width: 900px)').matches) {
        const stage = document.querySelector<HTMLElement>('.stage-wrap')!;
        const offset = stage.getBoundingClientRect().bottom;
        const top = first.getBoundingClientRect().top + window.scrollY - offset;
        window.scrollTo({ top: Math.max(0, top), behavior: 'instant' as ScrollBehavior });
      }
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
drawSceneSwatches();
void listBackgrounds().then((list) => {
  savedBgs = list;
  if (settings.scene.background === 'custom' && !list.some((b) => b.id === settings.scene.customId)) {
    settings.scene.background = 'auto';
    settings.scene.customId = null;
  }
  renderCustomBackgrounds();
  syncUI();
});

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
