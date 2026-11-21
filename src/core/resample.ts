/**
 * Module 2 — Image Resizing and Cropping (pixel engine).
 *
 * A separable, streaming resampler: every output pixel of the eye frame is
 * computed from the source via the axis-aligned `Mapping`, using the chosen
 * interpolation kernel (widened for anti-aliased down-scaling). Horizontal
 * passes are cached per source row so each source row is filtered once.
 *
 * The frame can be rendered with extra margins around it ("overscan") so
 * that the displacement processors always have real neighbouring pixels to
 * pull in — no blank borders are ever introduced.
 */
import { computeTaps } from './kernels';
import type { Mapping } from './layout';
import { createImage, type Interpolation, type RGBAImage } from './types';

export type Background =
  | { kind: 'color'; rgba: [number, number, number, number] }
  | { kind: 'image'; image: RGBAImage };

export interface FrameRequest {
  source: RGBAImage;
  /** Whether the source has any non-opaque pixel (enables alpha-weighted filtering). */
  sourceHasAlpha: boolean;
  mapping: Mapping;
  /** Logical eye-frame size (used to decide which image edges get extended). */
  frameW: number;
  frameH: number;
  /** Margins rendered around the frame on each side. */
  marginX: number;
  marginY: number;
  interpolation: Interpolation;
  background: Background;
}

interface AxisPlan {
  start: Int32Array; // offset into idx/w for output j
  count: Int32Array;
  idx: Int32Array;
  w: Float32Array;
  coverage: Float32Array;
  full: boolean; // coverage == 1 everywhere
}

function planAxis(
  outLen: number,
  origin: number,
  scale: number,
  off: number,
  srcLen: number,
  frameLen: number,
  interp: Interpolation,
): AxisPlan {
  const filterScale = interp === 'nearest' ? 1 : Math.max(1, 1 / scale);
  const start = new Int32Array(outLen);
  const count = new Int32Array(outLen);
  const idxParts: Int32Array[] = [];
  const wParts: Float32Array[] = [];
  let total = 0;
  const coverage = new Float32Array(outLen);
  const eps = 1e-6;
  // Image edges that reach (or pass) the frame edge are extended to infinity,
  // so margin pixels never blend in background on a fully-covered side.
  const imgStart = off <= eps ? -Infinity : off;
  const imgEnd = off + srcLen * scale >= frameLen - eps ? Infinity : off + srcLen * scale;
  let full = true;
  for (let j = 0; j < outLen; j++) {
    const xo = j + origin;
    const u = (xo + 0.5 - off) / scale - 0.5;
    const taps = computeTaps(u, srcLen, interp, filterScale);
    start[j] = total;
    count[j] = taps.indices.length;
    idxParts.push(taps.indices);
    wParts.push(taps.weights);
    total += taps.indices.length;
    const c = Math.min(xo + 1, imgEnd) - Math.max(xo, imgStart);
    coverage[j] = c >= 1 ? 1 : c <= 0 ? 0 : c;
    if (coverage[j] !== 1) full = false;
  }
  const idx = new Int32Array(total);
  const w = new Float32Array(total);
  let o = 0;
  for (let k = 0; k < idxParts.length; k++) {
    idx.set(idxParts[k], o);
    w.set(wParts[k], o);
    o += idxParts[k].length;
  }
  return { start, count, idx, w, coverage, full };
}

/**
 * Render the eye frame (plus margins). Output size:
 *   (frameW + 2·marginX) × (frameH + 2·marginY)
 */
export function renderFrame(req: FrameRequest): RGBAImage {
  const { source, mapping, interpolation } = req;
  const outW = req.frameW + 2 * req.marginX;
  const outH = req.frameH + 2 * req.marginY;
  const out = createImage(outW, outH);
  const sw = source.width;
  const sh = source.height;
  const src = source.data;
  const alpha = req.sourceHasAlpha;

  const px = planAxis(outW, -req.marginX, mapping.sx, mapping.offX, sw, req.frameW, interpolation);
  const py = planAxis(outH, -req.marginY, mapping.sy, mapping.offY, sh, req.frameH, interpolation);

  const bg = req.background;
  const bgImg = bg.kind === 'image' ? bg.image : null;
  if (bgImg && (bgImg.width !== outW || bgImg.height !== outH)) {
    throw new Error('Background image size mismatch');
  }
  const bgC = bg.kind === 'color' ? bg.rgba : [0, 0, 0, 0];

  // Row cache of horizontally-filtered (premultiplied when alpha) source rows.
  const cache = new Map<number, Float32Array>();
  const pool: Float32Array[] = [];
  const rowLen = outW * 4;

  const hRow = (r: number): Float32Array => {
    let row = cache.get(r);
    if (row) return row;
    row = pool.pop() ?? new Float32Array(rowLen);
    const base = r * sw * 4;
    for (let j = 0; j < outW; j++) {
      const s = px.start[j];
      const n = px.count[j];
      let R = 0, G = 0, B = 0, A = 0;
      if (alpha) {
        for (let k = 0; k < n; k++) {
          const p = base + px.idx[s + k] * 4;
          const wk = px.w[s + k];
          const wa = wk * src[p + 3];
          R += wa * src[p];
          G += wa * src[p + 1];
          B += wa * src[p + 2];
          A += wa;
        }
      } else {
        for (let k = 0; k < n; k++) {
          const p = base + px.idx[s + k] * 4;
          const wk = px.w[s + k];
          R += wk * src[p];
          G += wk * src[p + 1];
          B += wk * src[p + 2];
        }
        A = 255;
      }
      const o = j * 4;
      row[o] = R;
      row[o + 1] = G;
      row[o + 2] = B;
      row[o + 3] = A;
    }
    cache.set(r, row);
    return row;
  };

  const od = out.data;
  let minNeeded = 0;
  for (let i = 0; i < outH; i++) {
    const s = py.start[i];
    const n = py.count[i];
    const covY = py.coverage[i];
    // Evict rows no longer needed (vertical taps advance monotonically).
    let lo = Infinity;
    for (let k = 0; k < n; k++) lo = Math.min(lo, py.idx[s + k]);
    if (lo > minNeeded) {
      for (const [key, buf] of cache) {
        if (key < lo) {
          cache.delete(key);
          pool.push(buf);
        }
      }
      minNeeded = lo;
    }
    const rows: Float32Array[] = new Array(n);
    for (let k = 0; k < n; k++) rows[k] = covY > 0 ? hRow(py.idx[s + k]) : (null as never);
    const orow = i * outW * 4;
    for (let j = 0; j < outW; j++) {
      const o = j * 4;
      const cov = covY * px.coverage[j];
      let R = 0, G = 0, B = 0, A = 0;
      if (cov > 0) {
        for (let k = 0; k < n; k++) {
          const wk = py.w[s + k];
          const row = rows[k];
          R += wk * row[o];
          G += wk * row[o + 1];
          B += wk * row[o + 2];
          A += wk * row[o + 3];
        }
        if (alpha) {
          // Un-premultiply (R,G,B are Σ w·a·c, A is Σ w·a).
          if (A > 1e-6) {
            R /= A; G /= A; B /= A;
          } else {
            R = G = B = 0;
          }
          A = A > 255 ? 255 : A < 0 ? 0 : A;
        } else {
          A = 255;
        }
      }
      const p = orow + o;
      if (cov >= 1) {
        // Fully covered by the photo: keep its own pixels (and alpha) untouched.
        od[p] = R; od[p + 1] = G; od[p + 2] = B; od[p + 3] = A;
        continue;
      }
      // Partially covered: the background fills only the area the photo does
      // not cover (area-weighted blend in premultiplied space).
      let bR: number, bG: number, bB: number, bA: number;
      if (bgImg) {
        const d = bgImg.data;
        bR = d[p]; bG = d[p + 1]; bB = d[p + 2]; bA = d[p + 3];
      } else {
        bR = bgC[0]; bG = bgC[1]; bB = bgC[2]; bA = bgC[3];
      }
      const fa = (cov * A) / 255;
      const ba = (bA / 255) * (1 - cov);
      const oa = fa + ba;
      if (oa <= 1e-9) {
        od[p] = 0; od[p + 1] = 0; od[p + 2] = 0; od[p + 3] = 0;
      } else {
        od[p] = (R * fa + bR * ba) / oa;
        od[p + 1] = (G * fa + bG * ba) / oa;
        od[p + 2] = (B * fa + bB * ba) / oa;
        od[p + 3] = oa * 255;
      }
    }
  }
  return out;
}
