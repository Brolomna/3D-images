/**
 * "Hidden 3D" single-image autostereograms (the Magic Eye kind).
 *
 * A texture strip is repeated across the image; wherever the hidden shape is
 * nearer, the repeat distance is shortened. When the viewer relaxes their
 * eyes so that neighbouring repeats fuse, the shorter distances are seen as
 * depth and the shape appears. Generation follows the symmetric algorithm of
 * Thimbleby, Inglis & Witten, "Displaying 3D images: algorithms for
 * single-image random-dot stereograms", IEEE Computer 27(10), 1994,
 * including hidden-surface removal, plus horizontal oversampling for smooth
 * depth and texture tiles instead of plain random dots.
 *
 * Everything is deterministic (seeded PRNG). The hidden shape is the photo's
 * estimated depth map; the texture is dots, an organic pattern, a strip of
 * the photo or a user-supplied texture image.
 */
import { smoothDepth, type DepthMap } from './depth';
import { createImage, type RGBAImage } from './types';

export type StereogramPattern = 'dots' | 'organic' | 'photo' | 'custom';
export type StereogramPalette = 'jungle' | 'ocean' | 'sunset' | 'rainbow' | 'mono' | 'original';
export type StereogramShape = 'smooth' | 'layers' | 'silhouette';

export interface StereogramSettings {
  pattern: StereogramPattern;
  palette: StereogramPalette;
  /** How many times the pattern repeats across the width (sets the pattern width). */
  repeats: number;
  /** Depth of field μ (0.1–0.5): fraction of the viewing distance the shape spans. */
  depth: number;
  shape: StereogramShape;
  /** Depths below this become a flat background (0..0.9). */
  cutoff: number;
  /** Viewing method the image is made for: parallel (wall-eyed, standard) or cross-eyed. */
  viewing: 'parallel' | 'cross';
  /** Two dots above the image that help the eyes converge. */
  guides: boolean;
  seed: number;
}

export const DEFAULT_STEREOGRAM: StereogramSettings = {
  pattern: 'organic',
  palette: 'jungle',
  repeats: 6,
  depth: 0.33,
  shape: 'smooth',
  cutoff: 0.25,
  viewing: 'parallel',
  guides: true,
  seed: 1,
};

const OVERSAMPLE = 3;

// ───────────────────────── deterministic noise ─────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise that tiles horizontally with period `px` lattice cells. */
function tileNoise(x: number, y: number, px: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const m = (v: number) => ((v % px) + px) % px;
  const a = hash2(m(x0), y0, seed), b = hash2(m(x0 + 1), y0, seed);
  const c = hash2(m(x0), y0 + 1, seed), d = hash2(m(x0 + 1), y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

const PALETTES: Record<Exclude<StereogramPalette, 'original'>, [number, number, number][]> = {
  jungle: [[8, 28, 4], [40, 90, 10], [120, 190, 20], [190, 240, 60], [235, 255, 150]],
  ocean: [[2, 16, 40], [10, 60, 110], [20, 130, 170], [90, 200, 210], [210, 245, 250]],
  sunset: [[30, 6, 40], [120, 20, 70], [220, 70, 50], [250, 160, 60], [255, 235, 170]],
  rainbow: [[230, 40, 60], [250, 170, 30], [80, 200, 80], [40, 140, 230], [150, 70, 210]],
  mono: [[12, 12, 12], [70, 70, 70], [140, 140, 140], [200, 200, 200], [250, 250, 250]],
};

function paletteColor(palette: StereogramPalette, t: number): [number, number, number] {
  const p = PALETTES[palette === 'original' ? 'jungle' : palette];
  const v = Math.min(0.9999, Math.max(0, t)) * (p.length - 1);
  const i = Math.floor(v), f = v - i;
  const a = p[i], b = p[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// ───────────────────────── textures ─────────────────────────

/**
 * Build the pattern tile: exactly `period` px wide (one repeat) and `height`
 * tall, seamless horizontally.
 */
export function buildTexture(
  s: StereogramSettings,
  period: number,
  height: number,
  photo: RGBAImage | null,
  custom: RGBAImage | null,
): RGBAImage {
  const tile = createImage(period, height);
  const d = tile.data;
  const rnd = mulberry32(s.seed * 9973 + 17);
  if (s.pattern === 'dots') {
    // Random-dot stereogram texture: small coloured dots.
    for (let y = 0; y < height; y++) for (let x = 0; x < period; x++) {
      const c = s.palette === 'rainbow' || s.palette === 'original'
        ? [rnd() * 255, rnd() * 255, rnd() * 255]
        : paletteColor(s.palette, rnd());
      const o = (y * period + x) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
    return tile;
  }
  if (s.pattern === 'organic') {
    // Leaf-like organic texture: tileable cellular (Worley) noise — each cell
    // a "leaf" with its own shade and dark veins between — plus fine noise.
    const cellsX = Math.max(3, Math.round(period / 38));
    const cs = period / cellsX;
    const cellsY = Math.ceil(height / cs) + 1;
    const pts: number[] = []; // feature point per cell: x, y, shade
    for (let cy = 0; cy < cellsY; cy++) for (let cx = 0; cx < cellsX; cx++) {
      pts.push((cx + 0.15 + 0.7 * hash2(cx, cy, s.seed)) * cs, (cy + 0.15 + 0.7 * hash2(cx, cy, s.seed + 7)) * cs, hash2(cx, cy, s.seed + 13));
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < period; x++) {
      const gx = Math.floor(x / cs), gy = Math.floor(y / cs);
      let f1 = Infinity, f2 = Infinity, shade = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const cy = gy + oy;
        if (cy < 0 || cy >= cellsY) continue;
        const cxw = ((gx + ox) % cellsX + cellsX) % cellsX;
        const i = (cy * cellsX + cxw) * 3;
        const px = pts[i] + (gx + ox - cxw) * cs; // wrap horizontally (seamless tile)
        // Elongate cells diagonally so they read as leaves, not bubbles.
        const dx = x - px, dy = y - pts[i + 1];
        const d = Math.hypot(dx * 0.8 + dy * 0.45, dy * 0.9 - dx * 0.2);
        if (d < f1) { f2 = f1; f1 = d; shade = pts[i + 2]; } else if (d < f2) f2 = d;
      }
      const edge = Math.min(1, (f2 - f1) / (cs * 0.18));
      const grain = tileNoise((x / period) * cellsX * 4, (y / period) * cellsX * 4, cellsX * 4, s.seed + 3);
      const t = Math.min(1, Math.max(0, (0.25 + 0.7 * shade) * (0.15 + 0.85 * edge) * (1 - 0.35 * f1 / cs) + 0.18 * grain));
      const c = paletteColor(s.palette, t);
      const o = (y * period + x) * 4;
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
    }
    return tile;
  }
  // Image-based textures: a strip of the photo, or a custom texture image.
  const src = s.pattern === 'custom' && custom ? custom : photo;
  if (!src) return buildTexture({ ...s, pattern: 'organic' }, period, height, null, null);
  // Cover-scale the source to the tile height and take a centred strip.
  const k = Math.max(height / src.height, (period * 1.3) / src.width);
  const sw = src.width * k;
  const offX = Math.max(0, (sw - period) / 2);
  const sample = (xs: number, sy: number) => {
    const sx = Math.min(src.width - 1, Math.max(0, Math.floor(xs / k)));
    return (sy * src.width + sx) * 4;
  };
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y + 0.5) / k));
    for (let x = 0; x < period; x++) {
      // Cross-fade the strip's end into the pixels just before its start,
      // so consecutive repeats join without a visible seam.
      const w = Math.min(1, Math.max(0, (x - period * 0.85) / (period * 0.15)));
      const p1 = sample(offX + x + 0.5, sy);
      const p2 = sample(offX + x + 0.5 - period, sy);
      let r = src.data[p1] * (1 - w) + src.data[p2] * w;
      let g = src.data[p1 + 1] * (1 - w) + src.data[p2 + 1] * w;
      let b = src.data[p1 + 2] * (1 - w) + src.data[p2 + 2] * w;
      if (s.palette !== 'original') {
        // Tint: map luminance onto the palette (like the classic green prints).
        const c = paletteColor(s.palette, (0.299 * r + 0.587 * g + 0.114 * b) / 255);
        r = c[0]; g = c[1]; b = c[2];
      }
      const o = (y * period + x) * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  return tile;
}

// ───────────────────────── depth shaping ─────────────────────────

/** Turn the normalised photo depth (1 = near) into the hidden shape. */
export function shapeDepth(depth: DepthMap, s: StereogramSettings): DepthMap {
  const c = Math.min(0.9, Math.max(0, s.cutoff));
  let map = smoothDepth(depth, Math.max(1, Math.round(depth.width / 300)));
  const out = new Float32Array(map.data.length);
  for (let i = 0; i < out.length; i++) {
    let z = (map.data[i] - c) / (1 - c);
    z = z < 0 ? 0 : z > 1 ? 1 : z;
    if (s.shape === 'layers') z = Math.round(z * 5) / 5;
    else if (s.shape === 'silhouette') z = z > 0.08 ? 1 : 0;
    out[i] = z;
  }
  map = { width: depth.width, height: depth.height, data: out };
  if (s.shape !== 'smooth') map = smoothDepth(map, 1); // soften stair edges slightly
  return map;
}

// ───────────────────────── generator ─────────────────────────

/**
 * Generate the autostereogram. `depth` is the hidden shape at output size
 * (0 = far background, 1 = nearest); the texture tile is one pattern width
 * (= separation of the far plane) wide.
 *
 * Texture coordinates are propagated outward from the centre: a pixel takes the texture coordinate of the pixel one separation away
 * toward the centre, where the separation for depth Z is
 *   sep(Z) = (1 − μZ)·E / (2 − μZ),  E = 2·patternWidth
 * (Thimbleby et al.), evaluated at the midpoint between the pair. Each repeat
 * is therefore a smoothly deformed copy of its neighbour, which keeps picture
 * textures coherent (the classic Magic Eye look) while encoding the depth.
 * Rows are computed at 3× horizontal resolution for sub-pixel depth steps.
 */
export function generateAutostereogram(
  depth: DepthMap,
  texture: RGBAImage,
  s: StereogramSettings,
): RGBAImage {
  const W = depth.width, H = depth.height;
  const P = texture.width;
  const K = OVERSAMPLE;
  const Wk = W * K;
  const mu = Math.min(0.5, Math.max(0.05, s.depth));
  const E = 2 * P * K;
  const sep = (z: number) => Math.round(((1 - mu * z) * E) / (2 - mu * z));
  const out = createImage(W, H);
  const Z = new Float32Array(Wk);
  const u = new Float64Array(Wk);
  const tex = texture.data;
  const TH = texture.height;
  const cross = s.viewing === 'cross';
  const c = Math.round(Wk / 2);
  const zAt = (x: number) => Z[x < 0 ? 0 : x >= Wk ? Wk - 1 : x];

  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < Wk; x++) {
      const t = (x + 0.5) / K - 0.5;
      const i0 = Math.max(0, Math.min(W - 1, Math.floor(t)));
      const i1 = Math.min(W - 1, i0 + 1);
      const f = Math.min(1, Math.max(0, t - i0));
      const z = depth.data[row + i0] * (1 - f) + depth.data[row + i1] * f;
      // Cross-eyed viewing reverses depth, so invert to keep the shape popping out.
      Z[x] = cross ? 1 - z : z;
    }
    // Rightwards from the centre: the first repeat (one local separation
    // wide) is the texture as is; every later pixel copies the texture
    // coordinate from one separation to its left.
    for (let x = c; x < Wk; x++) {
      const s0 = sep(Z[x]);
      const sx = sep(zAt(Math.round(x - s0 / 2)));
      u[x] = x - sx < c ? (x - c) / K : u[x - sx];
    }
    // Leftwards: copy from one separation to the right.
    for (let x = c - 1; x >= 0; x--) {
      const s0 = sep(Z[x]);
      const sx = sep(zAt(Math.round(x + s0 / 2)));
      u[x] = u[Math.min(Wk - 1, x + sx)];
    }
    // Sample the texture (linear in x, wrapping) and downsample.
    const ty = (y % TH) * P;
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < K; j++) {
        const tu = u[x * K + j];
        const f0 = Math.floor(tu);
        const fr = tu - f0;
        const a0 = (ty + (((f0 % P) + P) % P)) * 4;
        const a1 = (ty + ((((f0 + 1) % P) + P) % P)) * 4;
        r += tex[a0] * (1 - fr) + tex[a1] * fr;
        g += tex[a0 + 1] * (1 - fr) + tex[a1 + 1] * fr;
        b += tex[a0 + 2] * (1 - fr) + tex[a1 + 2] * fr;
      }
      const o = (row + x) * 4;
      out.data[o] = r / K; out.data[o + 1] = g / K; out.data[o + 2] = b / K; out.data[o + 3] = 255;
    }
  }
  if (s.guides) drawGuides(out, P);
  return out;
}

/** Two convergence dots, one pattern width apart, near the top. */
function drawGuides(img: RGBAImage, P: number): void {
  const r = Math.max(4, Math.round(img.width / 120));
  const cy = Math.round(r * 3);
  const cx = img.width / 2;
  for (const dx of [-P / 2, P / 2]) {
    const x0 = cx + dx;
    for (let y = cy - r - 2; y <= cy + r + 2; y++) {
      for (let x = Math.floor(x0 - r - 2); x <= Math.ceil(x0 + r + 2); x++) {
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
        const d = Math.hypot(x + 0.5 - x0, y + 0.5 - cy);
        const o = (y * img.width + x) * 4;
        if (d <= r) { img.data[o] = 0; img.data[o + 1] = 0; img.data[o + 2] = 0; }
        else if (d <= r + 2) { img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255; }
      }
    }
  }
}

/** Pattern width (px) for an output width. */
export function patternWidth(outputWidth: number, s: StereogramSettings): number {
  return Math.max(24, Math.round(outputWidth / Math.min(16, Math.max(3, s.repeats))));
}
