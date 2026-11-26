/**
 * Layered 3D card with any number of layers — the two splitter modes.
 *
 *  ✨ Auto:   the frame follows the card rules (outside the window, the
 *             banner, edge ornaments); inside the window pixels are sorted by
 *             DEPTH together with the cut-out model's matte: the character is
 *             what is nearer than a threshold (Otsu by default) and confirmed
 *             by the matte, optional mid layers split the rest by depth.
 *  ✏️ Manual: the user paints one mask per layer; this builds the layers
 *             from those masks (feathered), fills what is behind moving
 *             layers, and gives each layer its movement.
 *
 * Every layer is card-size with transparency, so the stack lines up exactly.
 * Movement follows depth: far layers move most (8 % / 6 %), the character
 * least (4 % / 2.4 %), still layers not at all.
 */
import { otsu } from './sketch';
import {
  bannerLine, behindHole, characterLayer, components, DEFAULT_CARD, fillBehind, findWindow,
  frameAlpha, hsv, morph, softBlur, withAlpha, type CardSettings,
} from './cardlayers';
import type { DepthMap } from './depth';
import type { RGBAImage } from './types';

export type LayerRole = 'bg' | 'mid' | 'char' | 'frame';

export interface StackLayer {
  id: string;
  name: string;
  role: LayerRole;
  image: RGBAImage;
  still: boolean;
  /** Movement at full tilt, % of the layer's own size. */
  motion: { x: number; y: number };
  /** Average depth (0 far … 1 near) when known. */
  depth: number | null;
}

export interface CardStack {
  mode: 'auto' | 'manual';
  size: [number, number];
  window: [number, number, number, number];
  win: { x: number; y: number; w: number; h: number };
  /** Back to front. */
  layers: StackLayer[];
  bannerTop: [number, number, number] | null;
  /** Auto: the depth threshold used (0..1 within the window), or null without depth. */
  threshold: number | null;
  /** Auto: what the character was found from. */
  source?: 'matte+depth' | 'matte' | 'depth';
}

export interface AutoSettings {
  /** Depth threshold 0..1 within the window; null = automatic (Otsu). */
  threshold: number | null;
  /** Extra depth layers between background and character (0–2). */
  extraLayers: number;
}

export const DEFAULT_AUTO: AutoSettings = { threshold: null, extraLayers: 0 };

/** Movement ends: background and character (the proven Howlfall values). */
export const MOTION_FAR = { x: 8, y: 6 };
export const MOTION_NEAR = { x: 4, y: 2.4 };

/** Movement for a layer at depth d, interpolated between the background and the character. */
export function motionFor(d: number, dFar: number, dNear: number): { x: number; y: number } {
  const t = dNear > dFar ? Math.min(1, Math.max(0, (d - dFar) / (dNear - dFar))) : 0.5;
  const r = (v: number) => Math.round(v * 100) / 100;
  return { x: r(MOTION_FAR.x + (MOTION_NEAR.x - MOTION_FAR.x) * t), y: r(MOTION_FAR.y + (MOTION_NEAR.y - MOTION_FAR.y) * t) };
}

/** Bilinear resample of a single-channel map to W × H. */
export function resample(m: Float32Array, w: number, h: number, W: number, H: number): Float32Array {
  if (w === W && h === H) return m;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / H - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / W - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      out[y * W + x] = (m[y0 * w + x0] * (1 - fx) + m[y0 * w + x1] * fx) * (1 - fy) + (m[y1 * w + x0] * (1 - fx) + m[y1 * w + x1] * fx) * fy;
    }
  }
  return out;
}

/** Fill holes: background pixels not reachable from the window border become foreground if `accept`. */
function fillHoles(mask: Uint8Array, region: Uint8Array, W: number, H: number, accept: (i: number) => boolean): void {
  const outside = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let head = 0, tail = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] || !region[i]) continue;
    const x = i % W, y = (i - x) / W;
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 || !region[i - 1] || !region[i + 1] || !region[i - W] || !region[i + W];
    if (edge) { outside[i] = 1; queue[tail++] = i; }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % W, y = (i - x) / W;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
      if (j >= 0 && region[j] && !mask[j] && !outside[j]) { outside[j] = 1; queue[tail++] = j; }
    }
  }
  for (let i = 0; i < mask.length; i++) if (region[i] && !mask[i] && !outside[i] && accept(i)) mask[i] = 1;
}

/**
 * Cut points between `k` depth groups (1-D k-means started at quantiles).
 * Robust to a flat background that holds most of the pixels.
 */
export function depthCuts(sorted: number[], k: number): number[] {
  if (sorted.length < k) return Array.from({ length: k - 1 }, (_, j) => (j + 1) / k);
  let c = Array.from({ length: k }, (_, j) => sorted[Math.floor(((j + 0.5) / k) * sorted.length)]);
  // Spread identical starting centres so every group can take its own values.
  const lo = sorted[0], hi = sorted[sorted.length - 1];
  c = c.map((v, j) => (j > 0 && v <= c[j - 1] ? lo + ((hi - lo) * j) / (k - 1) : v));
  for (let it = 0; it < 20; it++) {
    const sum = new Array(k).fill(0), n = new Array(k).fill(0);
    for (const v of sorted) {
      let b = 0;
      for (let j = 1; j < k; j++) if (Math.abs(v - c[j]) < Math.abs(v - c[b])) b = j;
      sum[b] += v; n[b]++;
    }
    c = c.map((v, j) => (n[j] ? sum[j] / n[j] : v)).sort((p, q) => p - q);
  }
  return c.slice(1).map((v, j) => (c[j] + v) / 2);
}

function round4(v: number) {
  return Math.round(v * 10000) / 10000;
}

function windowInfo(W: number, H: number, box: [number, number, number, number]) {
  const [X0, Y0, X1, Y1] = box;
  return { x: round4(X0 / W), y: round4(Y0 / H), w: round4((X1 - X0) / W), h: round4((Y1 - Y0) / H) };
}

/**
 * ✨ Auto mode. `matte`: the cut-out model's foreground probability for the
 * window crop (or null). `depth`: a 0..1 depth map of the whole card, any
 * resolution (or null). At least one of them is needed.
 */
export function autoStack(
  card: RGBAImage,
  matte: Float32Array | null,
  depth: DepthMap | null,
  s: CardSettings,
  a: AutoSettings,
  ownBg: RGBAImage | null,
): CardStack {
  if (!matte && !depth) throw new Error('Needs the cut-out model or a depth map.');
  const W = card.width, H = card.height, N = W * H;
  const k = W / 941;
  const box = findWindow(card, s.window);
  const [X0, Y0, X1, Y1] = box;
  const cut = bannerLine(card, box, s.noBanner ? null : s.bannerBand);
  const win = new Uint8Array(N), above = new Uint8Array(N);
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
    const i = y * W + x;
    win[i] = 1;
    if (y <= cut[x]) above[i] = 1;
  }
  const colour = hsv(card);

  // Matte at card size (zero outside the window).
  let m: Float32Array | null = null;
  if (matte) {
    m = new Float32Array(N);
    const cw = X1 - X0;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) m[y * W + x] = matte[(y - Y0) * cw + (x - X0)];
  }
  // Depth normalised within the window (above the banner).
  let dn: Float32Array | null = null;
  let thr: number | null = null;
  if (depth) {
    const d = resample(depth.data, depth.width, depth.height, W, H);
    const vals: number[] = [];
    for (let i = 0; i < N; i += 3) if (above[i]) vals.push(d[i]);
    vals.sort((p, q) => p - q);
    const lo = vals[Math.floor(vals.length * 0.01)] ?? 0, hi = vals[Math.floor(vals.length * 0.99)] ?? 1;
    const r = hi - lo || 1;
    dn = new Float32Array(N);
    for (let i = 0; i < N; i++) dn[i] = Math.min(1, Math.max(0, (d[i] - lo) / r));
    if (a.threshold != null) thr = Math.min(0.98, Math.max(0.02, a.threshold));
    else {
      const inWin = Float32Array.from(vals.map((v) => Math.min(1, Math.max(0, (v - lo) / r))));
      thr = otsu(inWin).t;
    }
  }

  // Character: nearer than the threshold, confirmed by the matte.
  const cand = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!above[i]) continue;
    if (m && dn) cand[i] = m[i] > 0.5 && dn[i] > thr! - 0.15 ? 1 : 0; // depth trims what the matte got wrong
    else if (m) cand[i] = m[i] > 0.5 ? 1 : 0;
    else cand[i] = dn![i] > thr! ? 1 : 0;
  }
  if (s.dropHue) {
    const [h0, h1] = s.dropHue;
    const glow = new Uint8Array(N);
    for (let i = 0; i < N; i++) glow[i] = colour.hue[i] > h0 && colour.hue[i] < h1 && colour.sat[i] > 0.45 && colour.val[i] > 0.5 ? 1 : 0;
    const opened = morph(morph(glow, W, H, 1, false), W, H, 1, true);
    for (let i = 0; i < N; i++) if (opened[i]) cand[i] = 0;
  }
  // Keep the largest piece, close small gaps, fill holes the depth confirms.
  const { label, comps } = components(cand, W, H);
  if (!comps.length) throw new Error('No character found inside the window — try moving the depth threshold.');
  let best = 0;
  comps.forEach((c, i) => { if (c.area > comps[best].area) best = i; });
  let hard = new Uint8Array(N);
  for (let i = 0; i < N; i++) hard[i] = label[i] === best ? 1 : 0;
  hard = morph(morph(hard, W, H, 2, true), W, H, 2, false);
  for (let i = 0; i < N; i++) if (!above[i]) hard[i] = 0;
  fillHoles(hard, above, W, H, (i) => (dn ? dn[i] > thr! - 0.1 : true));
  // Soft edge: the matte's own soft values at the boundary where available.
  const a0 = new Float32Array(N);
  for (let i = 0; i < N; i++) a0[i] = hard[i] ? (m ? Math.max(0.6, Math.min(1, m[i] * 1.4)) : 1) : 0;
  const alpha = softBlur(a0, W, H, 1);

  // Layers.
  const char = characterLayer(card, alpha, cut, box, s);
  const fa = frameAlpha(card, win, above, colour, alpha, box);
  const frame = withAlpha(card, fa);

  // Optional mid layers: split the remaining window by depth quantiles.
  const mids: { alpha: Float32Array; depth: number }[] = [];
  const extra = dn ? Math.max(0, Math.min(2, Math.round(a.extraLayers))) : 0;
  let farMask = new Float32Array(N);
  for (let i = 0; i < N; i++) farMask[i] = above[i] && alpha[i] < 0.5 ? 1 : 0;
  if (extra > 0 && dn) {
    const rest: number[] = [];
    for (let i = 0; i < N; i += 2) if (farMask[i]) rest.push(dn[i]);
    rest.sort((p, q) => p - q);
    const cuts = depthCuts(rest, extra + 1);
    // Nearest band first so that each band takes what is nearer than its cut.
    for (let j = extra - 1; j >= 0; j--) {
      const lo = cuts[j], hi = j + 1 < extra ? cuts[j + 1] : Infinity;
      const band = new Uint8Array(N);
      for (let i = 0; i < N; i++) band[i] = farMask[i] && dn[i] >= lo && dn[i] < hi ? 1 : 0;
      const cleaned = morph(morph(band, W, H, 2, false), W, H, 2, true); // open: drop specks
      const ba = softBlur(Float32Array.from(cleaned), W, H, 1);
      let sum = 0, n = 0;
      for (let i = 0; i < N; i++) if (cleaned[i]) { sum += dn[i]; n++; }
      if (n < N * 0.002) continue;
      mids.unshift({ alpha: ba, depth: sum / n });
      for (let i = 0; i < N; i++) if (cleaned[i]) farMask[i] = 0;
    }
  }

  // Background: fill behind the character and the mid layers.
  const behind = behindHole(alpha, fa, win, W, H, k);
  for (const md of mids) {
    const extraHole = behindHole(md.alpha, new Float32Array(N), win, W, H, k);
    for (let i = 0; i < N; i++) behind[i] = Math.max(behind[i], extraHole[i]);
  }
  const bg = ownBg ?? fillBehind(card, behind, win, box);

  // Depth per layer → movement.
  const avg = (mask: (i: number) => number) => {
    if (!dn) return null;
    let s0 = 0, n = 0;
    for (let i = 0; i < N; i += 2) { const w = mask(i); if (w > 0.5) { s0 += dn[i]; n++; } }
    return n ? s0 / n : null;
  };
  const dBg = avg((i) => farMask[i]);
  const dChar = avg((i) => alpha[i]);
  const layers: StackLayer[] = [
    { id: 'bg', name: 'Background', role: 'bg', image: bg, still: false, motion: { ...MOTION_FAR }, depth: dBg },
    ...mids.map((md, j) => ({
      id: `mid${j + 1}`, name: `Depth layer ${j + 1}`, role: 'mid' as const, image: withAlpha(card, md.alpha), still: false,
      motion: motionFor(md.depth, dBg ?? 0, dChar ?? 1), depth: md.depth,
    })),
    { id: 'char', name: 'Character', role: 'char', image: char, still: false, motion: { ...MOTION_NEAR }, depth: dChar },
    { id: 'frame', name: 'Frame', role: 'frame', image: frame, still: true, motion: { x: 0, y: 0 }, depth: null },
  ];
  let cmin = Infinity, cmax = -Infinity;
  for (let x = 0; x < W; x++) { cmin = Math.min(cmin, cut[x]); cmax = Math.max(cmax, cut[x]); }
  return {
    mode: 'auto', size: [W, H], window: box, win: windowInfo(W, H, box), layers,
    bannerTop: s.noBanner ? null : [Math.round(cut[Math.min(W - 1, X0 + 2)]), Math.round(cmin), Math.round(cmax)],
    threshold: thr, source: m && dn ? 'matte+depth' : m ? 'matte' : 'depth',
  };
}

// ───────────────────────── ✏️ Manual ─────────────────────────

export interface PaintLayer {
  id: string;
  name: string;
  role: LayerRole;
  still: boolean;
  /** Coverage 0..255 at the mask resolution. */
  mask: Uint8Array;
}

/**
 * Build the stack from painted masks (mask resolution mw × mh, any scale of
 * the card). Unpainted pixels belong to the background. Masks are feathered
 * by ~1.5 px; the background is filled where moving layers sit.
 */
export function manualStack(
  card: RGBAImage,
  paint: PaintLayer[],
  mw: number,
  mh: number,
  depth: DepthMap | null,
  s: CardSettings = DEFAULT_CARD,
): CardStack {
  const W = card.width, H = card.height, N = W * H;
  const k = W / 941;
  const box = findWindow(card, s.window);
  const win = new Uint8Array(N);
  for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) win[y * W + x] = 1;
  const dn = depth ? resample(depth.data, depth.width, depth.height, W, H) : null;
  const alphas = paint.map((p) => {
    const f = Float32Array.from(p.mask, (v) => v / 255);
    return softBlur(resample(f, mw, mh, W, H), W, H, 1.5);
  });
  const bgIdx = paint.findIndex((p) => p.role === 'bg');
  // Background: everything not painted onto another layer, filled behind moving layers.
  const hole = new Float32Array(N);
  paint.forEach((p, j) => {
    if (j === bgIdx || p.still) return;
    const h = behindHole(alphas[j], new Float32Array(N), new Uint8Array(N).fill(1), W, H, k);
    for (let i = 0; i < N; i++) hole[i] = Math.max(hole[i], h[i]);
  });
  const all = new Uint8Array(N).fill(1);
  const bgImage = fillBehind(card, hole, all, [0, 0, W, H]);
  const depthOf = (a: Float32Array) => {
    if (!dn) return null;
    let s0 = 0, n = 0;
    for (let i = 0; i < N; i += 2) if (a[i] > 0.5) { s0 += dn[i]; n++; }
    return n ? s0 / n : null;
  };
  const charIdx = paint.findIndex((p) => p.role === 'char');
  const dChar = charIdx >= 0 ? depthOf(alphas[charIdx]) : null;
  const paintedBg = bgIdx >= 0 ? alphas[bgIdx] : null;
  let dBg: number | null = null;
  if (dn) {
    // Background depth: painted background, else everything unpainted.
    const taken = new Float32Array(N);
    alphas.forEach((a, j) => { if (j !== bgIdx) for (let i = 0; i < N; i++) taken[i] = Math.max(taken[i], a[i]); });
    dBg = depthOf(paintedBg ?? taken.map((v) => 1 - v));
  }
  const layers: StackLayer[] = paint.map((p, j) => {
    const image = j === bgIdx ? bgImage : withAlpha(card, alphas[j]);
    const d = j === bgIdx ? dBg : depthOf(alphas[j]);
    const motion = p.still ? { x: 0, y: 0 }
      : p.role === 'bg' ? { ...MOTION_FAR }
        : p.role === 'char' ? { ...MOTION_NEAR }
          : d != null && dBg != null && dChar != null ? motionFor(d, dBg, dChar) : motionFor(0.5, 0, 1);
    return { id: p.id, name: p.name, role: p.role, image, still: p.still, motion, depth: d };
  });
  if (bgIdx < 0) {
    layers.unshift({ id: 'bg', name: 'Background', role: 'bg', image: bgImage, still: false, motion: { ...MOTION_FAR }, depth: dBg });
  }
  return { mode: 'manual', size: [W, H], window: box, win: windowInfo(W, H, box), layers, bannerTop: null, threshold: null };
}

/**
 * Magic select: grow a region from (sx, sy) over pixels of similar colour
 * (and similar depth when a depth map is given). Mask resolution = image
 * resolution of `img`. Tolerance 0..1.
 */
export function magicSelect(img: RGBAImage, depth: Float32Array | null, sx: number, sy: number, tolerance: number): Uint8Array {
  const W = img.width, H = img.height;
  const out = new Uint8Array(W * H);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return out;
  const s = sy * W + sx;
  const r0 = img.data[s * 4], g0 = img.data[s * 4 + 1], b0 = img.data[s * 4 + 2];
  const d0 = depth ? depth[s] : 0;
  const cTol = 20 + 140 * tolerance; // colour distance (0..441)
  const dTol = 0.03 + 0.25 * tolerance;
  const ok = (i: number) => {
    const o = i * 4;
    const dc = Math.hypot(img.data[o] - r0, img.data[o + 1] - g0, img.data[o + 2] - b0);
    if (dc > cTol) return false;
    return !depth || Math.abs(depth[i] - d0) <= dTol;
  };
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  queue[tail++] = s;
  out[s] = 255;
  while (head < tail) {
    const i = queue[head++];
    const x = i % W, y = (i - x) / W;
    if (x > 0 && !out[i - 1] && ok(i - 1)) { out[i - 1] = 255; queue[tail++] = i - 1; }
    if (x < W - 1 && !out[i + 1] && ok(i + 1)) { out[i + 1] = 255; queue[tail++] = i + 1; }
    if (y > 0 && !out[i - W] && ok(i - W)) { out[i - W] = 255; queue[tail++] = i - W; }
    if (y < H - 1 && !out[i + W] && ok(i + W)) { out[i + W] = 255; queue[tail++] = i + W; }
  }
  return out;
}

/** Turn an Auto stack into paint masks (mask resolution mw × mh) for hand fixes. */
export function stackToPaint(stack: CardStack, mw: number, mh: number): PaintLayer[] {
  const [W, H] = stack.size;
  return stack.layers.map((l) => {
    const a = new Float32Array(W * H);
    if (l.role !== 'bg') for (let i = 0; i < a.length; i++) a[i] = l.image.data[i * 4 + 3] / 255;
    const small = resample(a, W, H, mw, mh);
    return { id: l.id, name: l.name, role: l.role, still: l.still, mask: Uint8Array.from(small, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255)) };
  });
}

