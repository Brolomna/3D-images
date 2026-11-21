/**
 * Depth-based view synthesis (DIBR).
 *
 * The depth map is estimated automatically by the app (see src/depth). Here it
 * is normalised, smoothed and aligned to the eye frame with exactly the same
 * mapping as the photo, then used to give every pixel its own horizontal
 * disparity. The displaced view is produced by inverse-mapping each output
 * pixel to a sub-pixel source position in the shared base frame:
 *
 *  - occlusions: when two surfaces land on the same pixel the nearer one wins
 *  - disocclusions (holes): filled by continuing the farther (background) side
 *
 * Only real pixels of the photo are resampled — nothing is generated.
 * With zero depth strength the result equals the uniform shift exactly.
 */
import { KERNELS } from './kernels';
import type { Mapping } from './layout';
import { createImage, type Interpolation, type RGBAImage } from './types';

/** Segments stretched beyond this many output pixels are treated as depth edges. */
const MAX_STRETCH = 1.5;

/** Single-channel float depth map. 0 = far, 1 = near once normalised. */
export interface DepthMap {
  width: number;
  height: number;
  data: Float32Array;
}

/**
 * Normalise a raw relative-inverse-depth prediction (larger = nearer) to
 * 0..1 using robust 1st/99th percentiles.
 */
export function normalizeDepth(raw: DepthMap, invert = false): DepthMap {
  const n = raw.data.length;
  const sorted = Float32Array.from(raw.data).sort();
  const lo = sorted[Math.floor(n * 0.01)];
  const hi = sorted[Math.min(n - 1, Math.floor(n * 0.99))];
  const range = hi - lo || 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = (raw.data[i] - lo) / range;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    out[i] = invert ? 1 - v : v;
  }
  return { width: raw.width, height: raw.height, data: out };
}

/** Separable 3-pass box blur of a float map (≈ Gaussian), edge-clamped. */
export function smoothDepth(map: DepthMap, radius: number): DepthMap {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return { width: map.width, height: map.height, data: Float32Array.from(map.data) };
  const { width: w, height: h } = map;
  const a = Float32Array.from(map.data);
  const b = new Float32Array(a.length);
  const norm = 1 / (2 * r + 1);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += a[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        b[row + x] = acc * norm;
        acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += b[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc * norm;
        acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return { width: w, height: h, data: a };
}

/**
 * Resample the depth map into the eye frame (+ margins), aligned with the
 * photo. `mapping` maps SOURCE-image pixels to the frame; the depth map covers
 * the same extent as the source, so it is rescaled accordingly. Bilinear.
 */
export function renderDepthFrame(
  depth: DepthMap,
  mapping: Mapping,
  srcW: number,
  srcH: number,
  frameW: number,
  frameH: number,
  marginX: number,
  marginY: number,
): DepthMap {
  const outW = frameW + 2 * marginX;
  const outH = frameH + 2 * marginY;
  const sx = (mapping.sx * srcW) / depth.width;
  const sy = (mapping.sy * srcH) / depth.height;
  const axis = (n: number, margin: number, s: number, off: number, len: number) => {
    const i0 = new Int32Array(n);
    const i1 = new Int32Array(n);
    const t = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      let u = (j - margin + 0.5 - off) / s - 0.5;
      u = Math.min(len - 1, Math.max(0, u));
      const f = Math.floor(u);
      i0[j] = f;
      i1[j] = Math.min(len - 1, f + 1);
      t[j] = u - f;
    }
    return { i0, i1, t };
  };
  const ax = axis(outW, marginX, sx, mapping.offX, depth.width);
  const ay = axis(outH, marginY, sy, mapping.offY, depth.height);
  const d = depth.data;
  const dw = depth.width;
  const out = new Float32Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const r0 = ay.i0[y] * dw, r1 = ay.i1[y] * dw, ty = ay.t[y];
    for (let x = 0; x < outW; x++) {
      const a = ax.i0[x], b = ax.i1[x], tx = ax.t[x];
      const top = d[r0 + a] + (d[r0 + b] - d[r0 + a]) * tx;
      const bot = d[r1 + a] + (d[r1 + b] - d[r1 + a]) * tx;
      out[y * outW + x] = top + (bot - top) * ty;
    }
  }
  return { width: outW, height: outH, data: out };
}

export interface DisparityParams {
  /** Uniform part (signed, output pixels at render scale). */
  uniform: number;
  /** Depth strength (output pixels at render scale). */
  strength: number;
  focus: number;
  /** −1 when the right eye is displaced (near → left), +1 for the left eye. */
  eyeSign: number;
}

/** Per-pixel disparity: D = uniform + eyeSign · strength · (depth − focus). */
export function disparityAt(d: number, p: DisparityParams): number {
  return p.uniform + p.eyeSign * p.strength * (d - p.focus);
}

/**
 * Horizontal depth-based warp. `base` and `depthFrame` include margins.
 * Output: eyeW × base.height, with out(x) = base(u(x)) where u solves
 * u − marginX + D(u) = x, choosing the nearest surface.
 */
export function warpHorizontal(
  base: RGBAImage,
  depthFrame: DepthMap,
  marginX: number,
  eyeW: number,
  params: DisparityParams,
  interpolation: Interpolation,
  hasAlpha: boolean,
): RGBAImage {
  const Wb = base.width;
  const H = base.height;
  if (depthFrame.width !== Wb || depthFrame.height !== H) throw new Error('Depth frame size mismatch');
  const out = createImage(eyeW, H);
  const src = base.data;
  const od = out.data;
  const zbuf = new Float64Array(eyeW);
  const ubuf = new Float64Array(eyeW);
  const dis = new Float64Array(Wb);
  const kernel = KERNELS[interpolation];
  const R = interpolation === 'nearest' ? 0 : Math.ceil(kernel.radius);
  const nTaps = 2 * R;
  const wts = new Float64Array(Math.max(1, nTaps));

  for (let y = 0; y < H; y++) {
    const drow = y * Wb;
    for (let s = 0; s < Wb; s++) dis[s] = s - marginX + disparityAt(depthFrame.data[drow + s], params);
    zbuf.fill(-Infinity);
    ubuf.fill(NaN);
    for (let s = 0; s < Wb - 1; s++) {
      const t0 = dis[s], t1 = dis[s + 1];
      if (!(t1 > t0)) continue; // fold: compressed / occluded region
      // A segment stretched over more than ~1.5 px spans a depth edge: leave
      // it as a hole so it is filled from the background, not smeared.
      if (t1 - t0 > MAX_STRETCH) continue;
      const xs = Math.max(0, Math.ceil(t0));
      const xe = Math.min(eyeW - 1, Math.ceil(t1) - 1);
      if (xe < xs) continue;
      const d0 = depthFrame.data[drow + s], d1 = depthFrame.data[drow + s + 1];
      const inv = 1 / (t1 - t0);
      for (let x = xs; x <= xe; x++) {
        const a = (x - t0) * inv;
        const z = d0 + (d1 - d0) * a;
        if (z > zbuf[x]) {
          zbuf[x] = z;
          ubuf[x] = s + a;
        }
      }
    }
    // Fill disocclusion holes from the background (farther) side.
    let x = 0;
    while (x < eyeW) {
      if (zbuf[x] !== -Infinity) { x++; continue; }
      let e = x;
      while (e < eyeW && zbuf[e] === -Infinity) e++;
      const l = x - 1, r = e; // valid neighbours (may be out of range)
      const hasL = l >= 0, hasR = r < eyeW;
      for (let k = x; k < e; k++) {
        let side: number;
        if (hasL && hasR) {
          // Interior disocclusion: mirror the background texture outwards
          // from its edge, so the occluding object is never repeated.
          side = zbuf[l] <= zbuf[r] ? l : r;
          ubuf[k] = ubuf[side] + (side - k);
        } else {
          // Frame border: continue the real image content from the margin.
          side = hasL ? l : hasR ? r : -1;
          ubuf[k] = side < 0 ? k + marginX - params.uniform : ubuf[side] + (k - side);
        }
      }
      x = e;
    }
    // Sample the base row at the sub-pixel positions.
    const row = y * Wb * 4;
    const orow = y * eyeW * 4;
    for (let k = 0; k < eyeW; k++) {
      const u = ubuf[k];
      const o = orow + k * 4;
      const ru = Math.round(u);
      if (R === 0 || Math.abs(u - ru) < 1e-7) {
        const p = row + clamp(R === 0 ? Math.floor(u + 0.5) : ru, Wb) * 4;
        od[o] = src[p]; od[o + 1] = src[p + 1]; od[o + 2] = src[p + 2]; od[o + 3] = src[p + 3];
        continue;
      }
      const first = Math.floor(u) - R + 1;
      let sum = 0;
      for (let t = 0; t < nTaps; t++) {
        const w = kernel.weight(first + t - u);
        wts[t] = w;
        sum += w;
      }
      let Rr = 0, G = 0, B = 0, A = 0;
      for (let t = 0; t < nTaps; t++) {
        const p = row + clamp(first + t, Wb) * 4;
        const w = wts[t] / sum;
        if (hasAlpha) {
          const wa = w * src[p + 3];
          Rr += wa * src[p]; G += wa * src[p + 1]; B += wa * src[p + 2]; A += wa;
        } else {
          Rr += w * src[p]; G += w * src[p + 1]; B += w * src[p + 2];
        }
      }
      if (hasAlpha) {
        if (A > 1e-6) { od[o] = Rr / A; od[o + 1] = G / A; od[o + 2] = B / A; od[o + 3] = A; }
        else { od[o] = od[o + 1] = od[o + 2] = od[o + 3] = 0; }
      } else {
        od[o] = Rr; od[o + 1] = G; od[o + 2] = B; od[o + 3] = 255;
      }
    }
  }
  return out;
}

function clamp(i: number, len: number): number {
  return i < 0 ? 0 : i >= len ? len - 1 : i;
}

/** Grayscale visualisation of a (normalised) depth map; near = bright. */
export function depthToImage(map: DepthMap): RGBAImage {
  const img = createImage(map.width, map.height);
  for (let i = 0; i < map.data.length; i++) {
    const v = Math.round(map.data[i] * 255);
    const o = i * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
    img.data[o + 3] = 255;
  }
  return img;
}
