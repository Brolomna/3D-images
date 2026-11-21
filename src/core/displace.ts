/**
 * Modules 5 & 6 — Horizontal and Vertical Displacement Processors.
 *
 * Translate an image by a (possibly fractional) number of *output* pixels.
 * Integer displacements are exact pixel copies; fractional displacements use
 * the selected interpolation kernel (same weights for every pixel, so the
 * operation is a pure translation). Samples that fall outside the input are
 * edge-extended — no blank pixels are ever introduced. Callers normally pass
 * an over-scanned input (frame + margins) so real image content is used.
 */
import { clampInt, computeTaps } from './kernels';
import { createImage, type Interpolation, type RGBAImage } from './types';

/**
 * out(x, y) = input(x + originX − dx, y), for x in [0, outW).
 * Positive dx moves content to the right.
 */
export function displaceHorizontal(
  input: RGBAImage,
  dx: number,
  originX: number,
  outW: number,
  interpolation: Interpolation,
  hasAlpha: boolean,
): RGBAImage {
  const { width: w, height: h, data: src } = input;
  const out = createImage(outW, h);
  const od = out.data;
  const u0 = originX - dx; // continuous source coordinate of output column 0
  const ip = Math.floor(u0);
  const frac = u0 - ip;
  const rel = relativeTaps(frac, interpolation);
  if (rel.offsets.length === 1) {
    // Pure integer translation → exact copy (with edge extension).
    const off = rel.offsets[0] + ip;
    // Columns x in [x0, x1) map inside the input and are copied as one block.
    const x0 = Math.min(outW, Math.max(0, -off));
    const x1 = Math.max(x0, Math.min(outW, w - off));
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      const orow = y * outW * 4;
      if (x1 > x0) od.set(src.subarray(row + (x0 + off) * 4, row + (x1 + off) * 4), orow + x0 * 4);
      for (let x = 0; x < outW; x = x === x0 - 1 ? Math.max(x1, x + 1) : x + 1) {
        if (x >= x0 && x < x1) continue;
        const p = row + clampInt(x + off, 0, w - 1) * 4;
        const o = orow + x * 4;
        od[o] = src[p]; od[o + 1] = src[p + 1]; od[o + 2] = src[p + 2]; od[o + 3] = src[p + 3];
      }
    }
    return out;
  }
  applySeparable1D(src, w, h, od, outW, h, rel, ip, true, hasAlpha);
  return out;
}

/**
 * out(x, y) = input(x, y + originY − dy), for y in [0, outH).
 * Positive dy moves content down.
 */
export function displaceVertical(
  input: RGBAImage,
  dy: number,
  originY: number,
  outH: number,
  interpolation: Interpolation,
  hasAlpha: boolean,
): RGBAImage {
  const { width: w, height: h, data: src } = input;
  const out = createImage(w, outH);
  const od = out.data;
  const u0 = originY - dy;
  const ip = Math.floor(u0);
  const frac = u0 - ip;
  const rel = relativeTaps(frac, interpolation);
  if (rel.offsets.length === 1) {
    const rowBytes = w * 4;
    for (let y = 0; y < outH; y++) {
      const sy = clampInt(y + ip + rel.offsets[0], 0, h - 1);
      od.set(src.subarray(sy * rowBytes, sy * rowBytes + rowBytes), y * rowBytes);
    }
    return out;
  }
  applySeparable1D(src, w, h, od, w, outH, rel, ip, false, hasAlpha);
  return out;
}

interface RelTaps {
  offsets: Int32Array;
  weights: Float32Array;
}

/** Kernel taps relative to floor(u) for a fractional position `frac` ∈ [0,1). */
export function relativeTaps(frac: number, interpolation: Interpolation): RelTaps {
  // Sample in a large virtual signal centred far from the edges, then subtract.
  const C = 1 << 20;
  const t = computeTaps(C + frac, 1 << 30, interpolation);
  const offsets = new Int32Array(t.indices.length);
  for (let k = 0; k < offsets.length; k++) offsets[k] = t.indices[k] - C;
  return { offsets, weights: t.weights };
}

function applySeparable1D(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  od: Uint8ClampedArray,
  outW: number,
  outH: number,
  rel: RelTaps,
  ip: number,
  horizontal: boolean,
  hasAlpha: boolean,
): void {
  const n = rel.offsets.length;
  const wts = Float64Array.from(rel.weights);
  if (horizontal) {
    // Precompute clamped byte offsets of every tap for every output column.
    const cols = new Int32Array(outW * n);
    for (let x = 0; x < outW; x++) {
      for (let k = 0; k < n; k++) cols[x * n + k] = clampInt(x + ip + rel.offsets[k], 0, w - 1) * 4;
    }
    for (let y = 0; y < outH; y++) {
      const row = y * w * 4;
      let o = y * outW * 4;
      for (let x = 0; x < outW; x++, o += 4) {
        let R = 0, G = 0, B = 0, A = 0;
        const c = x * n;
        if (hasAlpha) {
          for (let k = 0; k < n; k++) {
            const p = row + cols[c + k];
            const wa = wts[k] * src[p + 3];
            R += wa * src[p]; G += wa * src[p + 1]; B += wa * src[p + 2]; A += wa;
          }
          writeAlpha(od, o, R, G, B, A);
        } else {
          for (let k = 0; k < n; k++) {
            const p = row + cols[c + k];
            const wk = wts[k];
            R += wk * src[p]; G += wk * src[p + 1]; B += wk * src[p + 2];
          }
          od[o] = R; od[o + 1] = G; od[o + 2] = B; od[o + 3] = 255;
        }
      }
    }
    return;
  }
  // Vertical: each output row is a weighted sum of whole input rows.
  const rowBytes = w * 4;
  const rows = new Int32Array(n);
  const acc = new Float64Array(rowBytes);
  for (let y = 0; y < outH; y++) {
    for (let k = 0; k < n; k++) rows[k] = clampInt(y + ip + rel.offsets[k], 0, h - 1) * rowBytes;
    const o = y * rowBytes;
    if (!hasAlpha) {
      acc.fill(0);
      for (let k = 0; k < n; k++) {
        const base = rows[k];
        const wk = wts[k];
        for (let i = 0; i < rowBytes; i++) acc[i] += wk * src[base + i];
      }
      for (let i = 0; i < rowBytes; i += 4) {
        od[o + i] = acc[i]; od[o + i + 1] = acc[i + 1]; od[o + i + 2] = acc[i + 2]; od[o + i + 3] = 255;
      }
    } else {
      for (let x = 0; x < w; x++) {
        let R = 0, G = 0, B = 0, A = 0;
        const xo = x * 4;
        for (let k = 0; k < n; k++) {
          const p = rows[k] + xo;
          const wa = wts[k] * src[p + 3];
          R += wa * src[p]; G += wa * src[p + 1]; B += wa * src[p + 2]; A += wa;
        }
        writeAlpha(od, o + xo, R, G, B, A);
      }
    }
  }
}

function writeAlpha(od: Uint8ClampedArray, o: number, R: number, G: number, B: number, A: number): void {
  if (A > 1e-6) {
    od[o] = R / A; od[o + 1] = G / A; od[o + 2] = B / A; od[o + 3] = A;
  } else {
    od[o] = 0; od[o + 1] = 0; od[o + 2] = 0; od[o + 3] = 0;
  }
}
