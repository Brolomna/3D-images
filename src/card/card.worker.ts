/// <reference lib="webworker" />
/**
 * Layered 3D card worker: runs the BiRefNet_lite segmentation model with
 * ONNX Runtime Web (WebGPU when available, else WebAssembly) to get the
 * character matte, then splits the card into frame / char / bg layers.
 * The model is downloaded once and kept in the browser's Cache Storage.
 */
import * as ort from 'onnxruntime-web/webgpu';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { findWindow } from '../core/cardlayers';
import { autoStack, manualStack, type CardStack } from '../core/cardstack';
import type { DepthMap } from '../core/depth';
import type { RGBAImage } from '../core/types';
import { guidedFilter } from '../core/scene';
import { CARD_MODELS, type CardModel, type CardRequest, type CardResponse } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ort.env.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href };
if (!(self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated) ort.env.wasm.numThreads = 1;

const CACHE = 'stereo3d-models-v1';
let session: { s: ort.InferenceSession; name: string } | null = null;

async function dropSession() {
  if (!session) return;
  try { await session.s.release(); } catch { /* already gone */ }
  session = null;
}

function post(msg: CardResponse, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

/** Fetch a model with download progress, using Cache Storage when available. */
async function fetchModel(url: string, onProgress: (loaded: number, total: number) => void): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try { cache = await caches.open(CACHE); } catch { /* no cache storage */ }
  const hit = cache ? await cache.match(url) : undefined;
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  try { await cache?.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* quota */ }
  return bytes;
}

async function providers(): Promise<string[]> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (gpu) {
    try { if (await gpu.requestAdapter()) return ['webgpu', 'wasm']; } catch { /* no adapter */ }
  }
  return ['wasm'];
}

/** fp32 → fp16 bits (round to nearest). */
function toHalf(v: number): number {
  const f = new Float32Array([v]);
  const x = new Uint32Array(f.buffer)[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e <= 0) { if (e < -10) return sign; m = (m | 0x800000) >> (1 - e); return sign | ((m + 0x1000) >> 13); }
  if (e >= 31) return sign | 0x7c00;
  const h = sign | (e << 10) | ((m + 0x1000) >> 13);
  return h;
}
function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** Foreground probability (0..1) for an RGBA crop, at the crop's size. */
/** Normalised model input (1×3×S×S) for the crop. */
function modelInput(crop: RGBAImage, S: number): Float32Array {
  const c0 = new OffscreenCanvas(crop.width, crop.height);
  c0.getContext('2d')!.putImageData(new ImageData(crop.data as Uint8ClampedArray<ArrayBuffer>, crop.width, crop.height), 0, 0);
  const c1 = new OffscreenCanvas(S, S);
  const g1 = c1.getContext('2d', { willReadFrequently: true })!;
  g1.imageSmoothingQuality = 'high';
  g1.drawImage(c0, 0, 0, S, S);
  const px = g1.getImageData(0, 0, S, S).data;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const input = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) for (let q = 0; q < 3; q++) input[q * S * S + i] = (px[i * 4 + q] / 255 - mean[q]) / std[q];
  return input;
}

/** Sharpen an upscaled matte so its edges follow the photo (guided filter). */
function refine(m: Float32Array, crop: RGBAImage): Float32Array {
  const n = crop.width * crop.height;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    gray[i] = (0.299 * crop.data[o] + 0.587 * crop.data[o + 1] + 0.114 * crop.data[o + 2]) / 255;
  }
  const r = Math.max(2, Math.round(Math.max(crop.width, crop.height) / 300));
  const q = guidedFilter(gray, m, crop.width, crop.height, r, 1e-4);
  // Keep confident interior / exterior from the model, refine the band between.
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = m[i] > 0.97 || m[i] < 0.03 ? m[i] : q[i];
  return out;
}

async function matte(crop: RGBAImage, id: number): Promise<{ m: Float32Array; model: string }> {

  let lastErr: unknown = null;
  const eps = await providers();
  // Half precision needs a GPU (WebGPU); CPU-only browsers use full precision.
  const candidates: CardModel[] = eps[0] === 'webgpu' ? CARD_MODELS : CARD_MODELS.filter((m) => !m.gpuOnly);
  for (const spec of candidates) {
    const S = spec.size;
    const input = modelInput(crop, S);
    try {
      if (!session || session.name !== spec.name) {
        await dropSession();
        post({ type: 'progress', id, stage: `Loading ${spec.name} (${spec.mb} MB, first time only)` });
        let bytes: Uint8Array | null = await fetchModel(spec.url, (loaded, total) => post({ type: 'progress', id, stage: 'Downloading cut-out model', loaded, total }));
        post({ type: 'progress', id, stage: 'Starting cut-out model' });
        const s = await ort.InferenceSession.create(bytes, {
          executionProviders: spec.gpuOnly ? ['webgpu'] : eps,
          // Lower peak memory on the WebAssembly backend.
          enableCpuMemArena: false,
          enableMemPattern: false,
          graphOptimizationLevel: 'all',
        });
        bytes = null;
        session = { s, name: spec.name };
      }
      post({ type: 'progress', id, stage: 'Finding the character' });
      const s = session.s;
      const inName = s.inputNames[0];
      const half = spec.name.includes('fp16') && (s as unknown as { inputMetadata?: { type?: string }[] }).inputMetadata?.[0]?.type === 'float16';
      const run32 = () => s.run({ [inName]: new ort.Tensor('float32', input, [1, 3, S, S]) });
      const run16 = () => {
        const h = new Uint16Array(input.length);
        for (let i = 0; i < input.length; i++) h[i] = toHalf(input[i]);
        return s.run({ [inName]: new ort.Tensor('float16', h, [1, 3, S, S]) });
      };
      let out: ort.InferenceSession.OnnxValueMapType;
      try {
        out = half ? await run16() : await run32();
      } catch (e) {
        // Some fp16 exports take half-precision input.
        if (!spec.name.includes('fp16') || half) throw e;
        out = await run16();
      }
      const t = out[s.outputNames[0]];
      const raw = t.type === 'float16' ? Float32Array.from(t.data as Uint16Array, fromHalf) : (t.data as Float32Array);
      const dims = t.dims;
      const oh = dims[dims.length - 2], ow = dims[dims.length - 1];
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < ow * oh; i++) { mn = Math.min(mn, raw[i]); mx = Math.max(mx, raw[i]); }
      const prob = new Float32Array(ow * oh);
      const logits = mn < 0 || mx > 1;
      for (let i = 0; i < prob.length; i++) prob[i] = logits ? 1 / (1 + Math.exp(-raw[i])) : raw[i];
      // Back to the crop size (bilinear via canvas on an 8-bit map, like the tool).
      const pm = new ImageData(ow, oh);
      for (let i = 0; i < prob.length; i++) { const v = Math.round(prob[i] * 255); pm.data.set([v, v, v, 255], i * 4); }
      const c2 = new OffscreenCanvas(ow, oh);
      c2.getContext('2d')!.putImageData(pm, 0, 0);
      const c3 = new OffscreenCanvas(crop.width, crop.height);
      const g3 = c3.getContext('2d', { willReadFrequently: true })!;
      g3.imageSmoothingQuality = 'high';
      g3.drawImage(c2, 0, 0, crop.width, crop.height);
      const back = g3.getImageData(0, 0, crop.width, crop.height).data;
      const m = new Float32Array(crop.width * crop.height);
      for (let i = 0; i < m.length; i++) m[i] = back[i * 4] / 255;
      return { m: spec.size < 1024 ? refine(m, crop) : m, model: spec.name };
    } catch (e) {
      lastErr = e;
      await dropSession();
      post({ type: 'progress', id, stage: `${spec.name} unavailable here, trying the next model` });
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Cut-out mattes per card (the model is the slow part; threshold changes reuse it). */
const matteCache = new Map<string, { m: Float32Array | null; model: string | null }>();

const img = (r: { width: number; height: number; buffer: ArrayBuffer }): RGBAImage => ({ width: r.width, height: r.height, data: new Uint8ClampedArray(r.buffer) });
const dmap = (r: { width: number; height: number; buffer: ArrayBuffer } | null): DepthMap | null => (r ? { width: r.width, height: r.height, data: new Float32Array(r.buffer) } : null);

function sendStack(id: number, t0: number, model: string | null, stack: CardStack) {
  const transfer: Transferable[] = [];
  const layers = stack.layers.map((l) => {
    const data = l.image.data.slice();
    transfer.push(data.buffer);
    return { id: l.id, name: l.name, role: l.role, still: l.still, motion: l.motion, depth: l.depth, image: { width: l.image.width, height: l.image.height, buffer: data.buffer as ArrayBuffer } };
  });
  post({ type: 'stack', id, ms: performance.now() - t0, model, stack: { ...stack, layers } }, transfer);
}

ctx.onmessage = async (ev: MessageEvent<CardRequest>) => {
  const msg = ev.data;
  const t0 = performance.now();
  try {
    if (msg.type === 'auto') {
      const card = img(msg.card);
      const bg = msg.bg ? img(msg.bg) : null;
      const depth = dmap(msg.depth);
      const win = findWindow(card, msg.settings.window);
      const key = `${msg.key}|${win.join(',')}`;
      let cached = matteCache.get(key);
      if (!cached) {
        const [x0, y0, x1, y1] = win;
        const crop: RGBAImage = { width: x1 - x0, height: y1 - y0, data: new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4) };
        for (let y = y0; y < y1; y++) crop.data.set(card.data.subarray((y * card.width + x0) * 4, (y * card.width + x1) * 4), (y - y0) * (x1 - x0) * 4);
        try {
          const r = await matte(crop, msg.id);
          cached = { m: r.m, model: r.model };
        } catch (e) {
          // No cut-out model here: fall back to the depth map alone.
          if (!depth) throw e;
          post({ type: 'progress', id: msg.id, stage: 'Cut-out model unavailable — using depth only' });
          cached = { m: null, model: null };
        }
        matteCache.clear(); // keep one card's matte
        matteCache.set(key, cached);
      }
      post({ type: 'progress', id: msg.id, stage: 'Building the layers' });
      sendStack(msg.id, t0, cached.model, autoStack(card, cached.m, depth, msg.settings, msg.auto, bg));
    } else if (msg.type === 'manual') {
      const card = img(msg.card);
      post({ type: 'progress', id: msg.id, stage: 'Building the layers' });
      const paint = msg.layers.map((l) => ({ ...l, mask: new Uint8Array(l.mask) }));
      sendStack(msg.id, t0, null, manualStack(card, paint, msg.mw, msg.mh, dmap(msg.depth), msg.settings));
    }
  } catch (e) {
    post({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) });
  }
};
