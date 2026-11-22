/**
 * Sketch stage for stereograms.
 *
 * Before the photo is hidden in a texture it is turned into a clean line
 * drawing: the subject's body shape (from the depth map), its silhouette
 * outline, and inner feature lines (eyes, markings, folds — edges found in
 * the photo with a difference-of-Gaussians filter). Each element gets its
 * own colour in the sketch preview, and its own depth in the hidden 3D
 * shape: a rounded, puffed-up body with raised (or engraved) outlines and
 * features, so the shape reads clearly once the eyes lock onto the pattern.
 */
import { smoothDepth, type DepthMap } from './depth';
import { createImage, type RGBAImage } from './types';

export interface SketchSettings {
  /** Line thickness in output pixels. */
  thickness: number;
  /** 0..1: how many inner feature lines to draw. */
  detail: number;
  /** 0..1: how far outlines and features stand out from the body. */
  lineHeight: number;
  /** Lines stand out (raised) or are carved in (engraved). */
  lineMode: 'raised' | 'engraved';
  /** 0..1: rounded, inflated body (1) vs. the photo's own relief (0). */
  rounding: number;
  /** Shift of the automatic subject/background split (−0.3 … +0.3). */
  subject: number;
}

export const DEFAULT_SKETCH: SketchSettings = {
  thickness: 5,
  detail: 0.5,
  lineHeight: 0.5,
  lineMode: 'raised',
  rounding: 0.6,
  subject: 0,
};

export interface Sketch {
  /** Coloured line drawing (preview). */
  image: RGBAImage;
  /** Hidden 3D shape (0 = background … 1 = nearest). */
  depth: DepthMap;
}

/** Sketch colours: paper, body, silhouette outline, feature lines. */
export const SKETCH_COLORS = {
  paper: [244, 241, 234],
  body: [214, 222, 234],
  outline: [255, 96, 48],
  feature: [24, 150, 210],
} as const;

/** Two-pass 3-4 chamfer distance (≈ Euclidean px / 3) from pixels outside the mask. */
function insideDistance(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i];
    // The image border is not treated as an edge of the subject.
    if (x > 0) v = Math.min(v, d[i - 1] + 3);
    if (y > 0) {
      v = Math.min(v, d[i - w] + 3);
      if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
      if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
    }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!d[i]) continue;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
    if (y < h - 1) {
      v = Math.min(v, d[i + w] + 3);
      if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
      if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
    }
    d[i] = v;
  }
  for (let i = 0; i < d.length; i++) d[i] = d[i] >= 1e9 ? 1e6 : d[i] / 3;
  return d;
}

/** Otsu split of values in 0..1: threshold and separability η (0..1). */
export function otsu(values: Float32Array): { t: number; eta: number } {
  const bins = 128;
  const hist = new Float64Array(bins);
  for (const v of values) hist[Math.min(bins - 1, Math.max(0, Math.floor(v * bins)))]++;
  const total = values.length;
  let sumAll = 0, sq = 0;
  for (let i = 0; i < bins; i++) { sumAll += i * hist[i]; sq += i * i * hist[i]; }
  const mean = sumAll / total;
  const varT = sq / total - mean * mean;
  let wB = 0, sumB = 0, best = 0, bestT = 0.5;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = (wB / total) * (wF / total) * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = (i + 1) / bins; }
  }
  return { t: bestT, eta: varT > 0 ? best / varT : 0 };
}

/** Rescale to 0..1 using robust 1st/99th percentiles. */
function normalise(v: Float32Array): Float32Array {
  const sorted = Float32Array.from(v).sort();
  const lo = sorted[Math.floor(v.length * 0.01)];
  const hi = sorted[Math.min(v.length - 1, Math.floor(v.length * 0.99))];
  const r = hi - lo || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.min(1, Math.max(0, (v[i] - lo) / r));
  return out;
}

/** Remove connected regions (8-neighbour) smaller than `minArea` pixels. */
function removeSmall(bin: Uint8Array, w: number, h: number, minArea: number): void {
  const seen = new Uint8Array(bin.length);
  const queue = new Int32Array(bin.length);
  const region: number[] = [];
  for (let start = 0; start < bin.length; start++) {
    if (!bin[start] || seen[start]) continue;
    let head = 0, tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    region.length = 0;
    while (head < tail) {
      const i = queue[head++];
      region.push(i);
      const x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (bin[j] && !seen[j]) { seen[j] = 1; queue[tail++] = j; }
      }
    }
    if (region.length < minArea) for (const i of region) bin[i] = 0;
  }
}

/**
 * Build the sketch from the reference view of the photo and its normalised
 * depth (both eye-frame sized). `threshold` shifts the automatic subject/background split;
 * `scale` = render scale (line widths are given in output pixels).
 */
export function buildSketch(
  photo: RGBAImage,
  depth: DepthMap,
  threshold: number,
  sk: SketchSettings,
  scale: number,
): Sketch {
  const W = depth.width, H = depth.height;
  if (photo.width !== W || photo.height !== H) throw new Error('Sketch inputs differ in size');
  const N = W * H;
  const px = (v: number) => Math.max(1, v * scale);

  // 1. Body shape. Photos usually show a floor / table / blanket that gets
  //    nearer towards the bottom, so "near" alone is not "subject". Model the
  //    background per row (a low percentile of that row's depth, smoothed
  //    vertically) and call the subject whatever stands out in front of it.
  //    Close-ups with no background fall back to absolute depth.
  const soft = smoothDepth(depth, Math.max(1, Math.round(W / 500)));
  const rowBg = new Float32Array(H);
  const row = new Float32Array(W);
  for (let y = 0; y < H; y++) {
    row.set(soft.data.subarray(y * W, y * W + W));
    row.sort();
    rowBg[y] = row[Math.floor(W * 0.3)];
  }
  const bgMap: DepthMap = { width: 1, height: H, data: rowBg };
  const bg = smoothDepth(bgMap, Math.max(1, Math.round(H / 25))).data;
  const prom = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) prom[y * W + x] = soft.data[y * W + x] - bg[y];
  const promN = normalise(prom);
  const sProm = otsu(promN);
  let area = 0;
  for (let i = 0; i < N; i++) if (promN[i] > sProm.t) area++;
  const absN = normalise(soft.data);
  const usable = area > N * 0.03 && area < N * 0.75 && sProm.eta > 0.45;
  const score = usable ? promN : absN;
  const t = Math.min(0.95, Math.max(0.02, (usable ? sProm.t : otsu(absN).t) + threshold));
  const raw: DepthMap = { width: W, height: H, data: new Float32Array(N) };
  for (let i = 0; i < N; i++) raw.data[i] = score[i] > t ? 1 : 0;
  const rounded = smoothDepth(raw, Math.max(1, Math.round(W / 360)));
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = rounded.data[i] > 0.5 ? 1 : 0;
  removeSmall(mask, W, H, Math.round(N * 0.002));
  const dist = insideDistance(mask, W, H);
  const thick = px(sk.thickness);
  const detail = Math.max(0, Math.min(1, sk.detail));
  const inner = (i: number) => mask[i] === 1 && dist[i] > thick * 1.2;

  // 2a. Structural feature lines: depth edges inside the body (head vs.
  //     body, ears, limbs) — where the 3D shape folds.
  const ds = smoothDepth(depth, Math.max(1, Math.round(W / 300)));
  const grad = new Float32Array(N);
  const gs: number[] = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    grad[i] = Math.hypot(ds.data[i + 1] - ds.data[i - 1], ds.data[i + W] - ds.data[i - W]);
    if (inner(i) && (i % 5) === 0) gs.push(grad[i]);
  }
  gs.sort((p, q) => p - q);
  const gThr = gs.length ? Math.max(0.004, gs[Math.floor(gs.length * (0.97 - 0.12 * detail))]) : Infinity;

  // 2b. Drawn feature lines: dark "ink" strokes from a difference of
  //     Gaussians on the photo at a coarse scale (ignores fur and grain).
  const lum: DepthMap = { width: W, height: H, data: new Float32Array(N) };
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    lum.data[i] = (0.299 * photo.data[o] + 0.587 * photo.data[o + 1] + 0.114 * photo.data[o + 2]) / 255;
  }
  const base = smoothDepth(lum, Math.max(1, Math.round(W / 400)));
  const r1 = Math.max(1, Math.round(Math.max(thick * 0.6, W / 250)));
  const g1 = smoothDepth(base, r1);
  const g2 = smoothDepth(base, Math.round(r1 * 1.8) + 1);
  const ink = new Float32Array(N);
  const is: number[] = [];
  for (let i = 0; i < N; i++) {
    ink[i] = Math.max(0, g2.data[i] - g1.data[i]); // darker than its surroundings
    if (inner(i) && (i % 5) === 0) is.push(ink[i]);
  }
  is.sort((p, q) => p - q);
  const iThr = is.length ? Math.max(0.02, is[Math.floor(is.length * (0.985 - 0.13 * detail))]) : Infinity;

  const featBin = new Uint8Array(N);
  for (let i = 0; i < N; i++) featBin[i] = inner(i) && (grad[i] > gThr || ink[i] > iThr) ? 1 : 0;
  // Keep real strokes, drop speckles.
  removeSmall(featBin, W, H, Math.max(12, Math.round(thick * thick * 6)));
  const featSoft = smoothDepth({ width: W, height: H, data: Float32Array.from(featBin) }, Math.max(1, Math.round(thick * 0.4)));
  const feature = new Float32Array(N);
  for (let i = 0; i < N; i++) feature[i] = inner(i) && featSoft.data[i] > 0.22 ? 1 : 0;

  // 3. Silhouette outline: a band of `thickness` just inside the contour.
  const outline = new Float32Array(N);
  for (let i = 0; i < N; i++) outline[i] = mask[i] && dist[i] <= thick ? 1 : 0;

  // 4. Hidden 3D shape: rounded body + raised / engraved lines.
  const R = Math.max(4, W * 0.07);
  const h = 0.32 * Math.max(0, Math.min(1, sk.lineHeight)) * (sk.lineMode === 'raised' ? 1 : -1);
  const z = new Float32Array(N);
  const relief0 = t;
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const q = Math.min(1, dist[i] / R);
    const dome = Math.sqrt(1 - (1 - q) * (1 - q));
    const relief = Math.min(1, Math.max(0, (depth.data[i] - relief0) / (1 - relief0)));
    let v = 0.42 + 0.33 * (sk.rounding * dome + (1 - sk.rounding) * relief);
    if (outline[i]) v += h;
    else if (feature[i]) v += h * 0.8;
    z[i] = Math.min(1, Math.max(0.05, v));
  }
  // Light anti-aliasing so edges do not stair-step in 3D.
  const shape = smoothDepth({ width: W, height: H, data: z }, 1);

  // 5. Coloured sketch preview.
  const image = createImage(W, H);
  const C = SKETCH_COLORS;
  for (let i = 0; i < N; i++) {
    const c = outline[i] ? C.outline : feature[i] ? C.feature : mask[i] ? C.body : C.paper;
    const o = i * 4;
    image.data[o] = c[0]; image.data[o + 1] = c[1]; image.data[o + 2] = c[2]; image.data[o + 3] = 255;
  }
  return { image, depth: shape };
}
