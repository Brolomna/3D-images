/**
 * Interpolation kernels used by both the resizer and the sub-pixel
 * displacement processors.
 */
import type { Interpolation } from './types';

export interface Kernel {
  /** Support radius in source pixels at scale 1. */
  radius: number;
  /** Kernel weight at signed distance x (in source pixels). */
  weight(x: number): number;
}

const bilinear: Kernel = {
  radius: 1,
  weight(x) {
    const a = Math.abs(x);
    return a < 1 ? 1 - a : 0;
  },
};

/** Keys cubic convolution, a = -0.5 (Catmull-Rom) — sharp and ringing-free in practice. */
const bicubic: Kernel = {
  radius: 2,
  weight(x) {
    const A = -0.5;
    const t = Math.abs(x);
    if (t <= 1) return ((A + 2) * t - (A + 3)) * t * t + 1;
    if (t < 2) return ((A * t - 5 * A) * t + 8 * A) * t - 4 * A;
    return 0;
  },
};

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** Lanczos-3: the preferred high-quality resampling filter. */
const lanczos: Kernel = {
  radius: 3,
  weight(x) {
    const a = Math.abs(x);
    if (a >= 3) return 0;
    // Exact zeros at non-zero integers keep aligned sampling bit-exact.
    if (a !== 0 && Number.isInteger(a)) return 0;
    return sinc(a) * sinc(a / 3);
  },
};

/** Nearest is handled specially by callers; the box kernel is a fallback. */
const nearest: Kernel = {
  radius: 0.5,
  weight(x) {
    return x >= -0.5 && x < 0.5 ? 1 : 0;
  },
};

export const KERNELS: Record<Interpolation, Kernel> = { nearest, bilinear, bicubic, lanczos };

export function getKernel(kind: Interpolation): Kernel {
  const k = KERNELS[kind];
  if (!k) throw new Error(`Unknown interpolation ${kind}`);
  return k;
}

/** One-dimensional tap list: sample = Σ weights[k] * src[indices[k]]. */
export interface Taps {
  indices: Int32Array;
  weights: Float32Array;
}

/**
 * Compute normalised taps for sampling a 1-D signal of length `len` at the
 * continuous pixel-centre coordinate `u` (pixel i has its centre at u = i).
 * `filterScale` ≥ 1 widens the kernel for anti-aliased down-scaling.
 * Indices are clamped to the valid range (edge extension).
 */
export function computeTaps(u: number, len: number, kind: Interpolation, filterScale = 1): Taps {
  if (kind === 'nearest') {
    const i = clampInt(Math.floor(u + 0.5), 0, len - 1);
    return { indices: Int32Array.of(i), weights: Float32Array.of(1) };
  }
  // Snap to integers when extremely close: guarantees exact copies for aligned sampling.
  const r = Math.round(u);
  if (Math.abs(u - r) < 1e-7 && filterScale === 1) {
    return { indices: Int32Array.of(clampInt(r, 0, len - 1)), weights: Float32Array.of(1) };
  }
  const kernel = KERNELS[kind];
  const support = kernel.radius * filterScale;
  const first = Math.ceil(u - support);
  const last = Math.floor(u + support);
  const n = Math.max(1, last - first + 1);
  const idx = new Int32Array(n);
  const w = new Float64Array(n);
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const i = first + k;
    const wk = kernel.weight((i - u) / filterScale);
    idx[k] = clampInt(i, 0, len - 1);
    w[k] = wk;
    sum += wk;
  }
  const out = new Float32Array(n);
  if (sum === 0) {
    // Degenerate (should not happen) — fall back to nearest.
    return { indices: Int32Array.of(clampInt(Math.floor(u + 0.5), 0, len - 1)), weights: Float32Array.of(1) };
  }
  for (let k = 0; k < n; k++) out[k] = w[k] / sum;
  return { indices: idx, weights: out };
}

export function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
