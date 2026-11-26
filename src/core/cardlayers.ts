/**
 * Layered 3D card (parallax).
 *
 * Splits one finished card picture (a painted frame with a window, a
 * character in the window and a name banner) into three same-size layers
 * that stack exactly:
 *
 *  - frame: the card with the window made transparent. It keeps the border,
 *    ornaments touching the window's edge, and everything below the banner.
 *  - char:  the character inside the window, above the banner, with its
 *    clothes mirrored a little further down under the banner and past the
 *    window's sides, so no cut edge shows when it slides.
 *  - bg:    what is behind the character: the user's own painting, or the
 *    window with the character's area filled by a push-pull fill plus grain,
 *    carried on past the window's edges.
 *
 * A browser port of the Howlfall tool `tools/card_layers.py`. The character
 * matte comes from a segmentation model (BiRefNet_lite, run by the caller);
 * everything here is deterministic image processing.
 */
import { createImage, type RGBAImage } from './types';

export interface CardSettings {
  /** Window override as fractions of the card [x0, y0, x1, y1], or null = detect. */
  window: [number, number, number, number] | null;
  /** Fractions of the height to search for the banner's top edge. */
  bannerBand: [number, number];
  noBanner: boolean;
  /** Hue range (degrees) of a glowing background colour to strip from the outline, or null. */
  dropHue: [number, number] | null;
  /** How far clothes continue under the banner and past the sides (px at 941 px card width). */
  extend: [number, number];
}

export const DEFAULT_CARD: CardSettings = {
  window: null,
  bannerBand: [0.62, 0.695],
  noBanner: false,
  dropHue: [300, 345],
  extend: [100, 70],
};

/** Howlfall's frame window, as fractions of the card. */
export const DEFAULT_WINDOW: [number, number, number, number] = [98 / 941, 120 / 1672, 843 / 941, 1540 / 1672];

export interface CardLayers {
  frame: RGBAImage;
  char: RGBAImage;
  bg: RGBAImage;
  info: {
    size: [number, number];
    window: [number, number, number, number];
    win: { x: number; y: number; w: number; h: number };
    bannerTop: [number, number, number] | null;
    ownBackground: boolean;
  };
}

// ───────────────────────── small image helpers ─────────────────────────

type Map1 = Float32Array;

/** Box blur radius r (separable, edge-clamped). */
function box(v: Map1, w: number, h: number, r: number): Map1 {
  if (r < 1) return Float32Array.from(v);
  const tmp = new Float32Array(v.length), out = new Float32Array(v.length);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += v[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * norm;
      acc += v[row + Math.min(w - 1, x + r + 1)] - v[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * norm;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Gaussian blur approximated by three box passes. */
export function gaussian(v: Map1, w: number, h: number, sigma: number): Map1 {
  if (sigma <= 0.3) return Float32Array.from(v);
  const r = Math.max(1, Math.round((Math.sqrt((12 * sigma * sigma) / 3 + 1) - 1) / 2));
  return box(box(box(v, w, h, r), w, h, r), w, h, r);
}

/** Sub-pixel sigma: blend between identity and a 1-px box for small radii. */
export function softBlur(v: Map1, w: number, h: number, sigma: number): Map1 {
  if (sigma >= 1.2) return gaussian(v, w, h, sigma);
  const b = box(v, w, h, 1);
  const t = Math.min(1, sigma / 1.2);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * (1 - t) + b[i] * t;
  return out;
}

/** Square min (erode) or max (dilate) filter with half-size r. */
export function morph(v: Uint8Array, w: number, h: number, r: number, max: boolean): Uint8Array {
  const tmp = new Uint8Array(v.length), out = new Uint8Array(v.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = max ? 0 : 1;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
      const s = v[y * w + k];
      if (max ? s > m : s < m) m = s;
    }
    tmp[y * w + x] = m;
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = max ? 0 : 1;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
      const s = tmp[k * w + x];
      if (max ? s > m : s < m) m = s;
    }
    out[y * w + x] = m;
  }
  return out;
}

export interface Component { area: number; x0: number; y0: number; x1: number; y1: number }

/** 8-connected components: labels (−1 = background) and stats. */
export function components(bin: Uint8Array, w: number, h: number): { label: Int32Array; comps: Component[] } {
  const label = new Int32Array(bin.length).fill(-1);
  const comps: Component[] = [];
  const queue = new Int32Array(bin.length);
  for (let s = 0; s < bin.length; s++) {
    if (!bin[s] || label[s] >= 0) continue;
    const id = comps.length;
    const c: Component = { area: 0, x0: w, y0: h, x1: 0, y1: 0 };
    let head = 0, tail = 0;
    queue[tail++] = s; label[s] = id;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w, y = (i - x) / w;
      c.area++;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (bin[j] && label[j] < 0) { label[j] = id; queue[tail++] = j; }
      }
    }
    comps.push(c);
  }
  return { label, comps };
}

function median(a: number[]): number {
  const s = a.slice().sort((p, q) => p - q);
  return s[s.length >> 1];
}

/** HSV in OpenCV's convention scaled to degrees / 0..1. */
export function hsv(img: RGBAImage) {
  const n = img.width * img.height;
  const hue = new Float32Array(n), sat = new Float32Array(n), val = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = img.data[o] / 255, g = img.data[o + 1] / 255, b = img.data[o + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let hh = 0;
    if (d > 0) {
      if (mx === r) hh = 60 * (((g - b) / d) % 6);
      else if (mx === g) hh = 60 * ((b - r) / d + 2);
      else hh = 60 * ((r - g) / d + 4);
    }
    hue[i] = hh < 0 ? hh + 360 : hh;
    sat[i] = mx > 0 ? d / mx : 0;
    val[i] = mx;
  }
  return { hue, sat, val };
}

// ───────────────────────── geometry ─────────────────────────

/**
 * The card's window in pixels: an explicit override, else the largest
 * transparent hole (if the card has alpha and the hole is big), else
 * Howlfall's frame fractions.
 */
export function findWindow(card: RGBAImage, override: CardSettings['window']): [number, number, number, number] {
  const W = card.width, H = card.height;
  if (override) {
    const [a, b, c, d] = override;
    return [Math.round(a * W), Math.round(b * H), Math.round(c * W), Math.round(d * H)];
  }
  const hole = new Uint8Array(W * H);
  let any = false;
  for (let i = 0; i < hole.length; i++) if (card.data[i * 4 + 3] < 20) { hole[i] = 1; any = true; }
  if (any) {
    const { comps } = components(hole, W, H);
    const big = comps.reduce<Component | null>((m, c) => (!m || c.area > m.area ? c : m), null);
    if (big && big.area > W * H * 0.2) return [big.x0, big.y0, big.x1 + 1, big.y1 + 1];
  }
  const f = DEFAULT_WINDOW;
  return [Math.round(f[0] * W), Math.round(f[1] * H), Math.round(f[2] * W), Math.round(f[3] * H)];
}

/**
 * Banner top edge per column (y in px): the strongest dark→bright step of the
 * red channel inside the band, median-smoothed with outlier rejection.
 */
export function bannerLine(card: RGBAImage, win: [number, number, number, number], band: [number, number] | null): Float32Array {
  const W = card.width, H = card.height;
  const [x0, , x1, y1] = win;
  const line = new Float32Array(W).fill(y1);
  if (!band) return line;
  const a = Math.floor(band[0] * H), b = Math.floor(band[1] * H);
  const red = new Float32Array(W * H);
  for (let i = 0; i < red.length; i++) red[i] = card.data[i * 4];
  const r = gaussian(red, W, H, 2.5);
  const m = Math.max(4, Math.round(0.023 * W));
  const xs: number[] = [];
  for (let x = x0 + m; x < x1 - m; x++) xs.push(x);
  if (!xs.length) return line;
  let t = xs.map((x) => {
    let best = -Infinity, by = a;
    for (let y = Math.max(4, a); y < Math.min(H - 4, b); y++) {
      const gy = r[(y + 4) * W + x] - r[(y - 4) * W + x];
      if (gy > best) { best = gy; by = y; }
    }
    return by + 3;
  });
  t = t.map((_, i) => median(t.slice(Math.max(0, i - 4), i + 5)));
  const wide = t.map((_, i) => median(t.slice(Math.max(0, i - 15), i + 16)));
  t = t.map((v, i) => (Math.abs(v - wide[i]) > 25 ? wide[i] : v));
  xs.forEach((x, i) => { line[x] = t[i]; });
  for (let x = 0; x < x0 + m; x++) line[x] = t[0];
  for (let x = x1 - m; x < W; x++) line[x] = t[t.length - 1];
  return line;
}

// ───────────────────────── background fill ─────────────────────────

/** Gaussian 5-tap pyramid reduction of a multi-channel float image. */
function pyrDown(c: Float32Array, w: number, h: number, ch: number): { d: Float32Array; w: number; h: number } {
  const k = [1, 4, 6, 4, 1].map((v) => v / 16);
  const W2 = Math.max(1, (w + 1) >> 1), H2 = Math.max(1, (h + 1) >> 1);
  const tmp = new Float32Array(W2 * h * ch);
  for (let y = 0; y < h; y++) for (let x = 0; x < W2; x++) for (let q = 0; q < ch; q++) {
    let s = 0;
    for (let t = -2; t <= 2; t++) s += k[t + 2] * c[(y * w + Math.min(w - 1, Math.max(0, 2 * x + t))) * ch + q];
    tmp[(y * W2 + x) * ch + q] = s;
  }
  const d = new Float32Array(W2 * H2 * ch);
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) for (let q = 0; q < ch; q++) {
    let s = 0;
    for (let t = -2; t <= 2; t++) s += k[t + 2] * tmp[(Math.min(h - 1, Math.max(0, 2 * y + t)) * W2 + x) * ch + q];
    d[(y * W2 + x) * ch + q] = s;
  }
  return { d, w: W2, h: H2 };
}

/** Bilinear resize of a multi-channel float image. */
export function resize(c: Float32Array, w: number, h: number, ch: number, W: number, H: number): Float32Array {
  const out = new Float32Array(W * H * ch);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / H - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / W - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      for (let q = 0; q < ch; q++) {
        const a = c[(y0 * w + x0) * ch + q], b = c[(y0 * w + x1) * ch + q];
        const cc = c[(y1 * w + x0) * ch + q], d = c[(y1 * w + x1) * ch + q];
        out[(y * W + x) * ch + q] = (a + (b - a) * fx) * (1 - fy) + (cc + (d - cc) * fx) * fy;
      }
    }
  }
  return out;
}

/**
 * Push-pull fill: unknown pixels (weight 0) are filled with a smooth blend
 * of the known ones, coarse to fine.
 */
export function pushPull(rgb: Float32Array, weight: Float32Array, w: number, h: number): Float32Array {
  const levels: { c: Float32Array; wt: Float32Array; w: number; h: number }[] = [];
  let c = new Float32Array(rgb.length);
  for (let i = 0; i < w * h; i++) for (let q = 0; q < 3; q++) c[i * 3 + q] = rgb[i * 3 + q];
  let wt = Float32Array.from(weight), cw = w, chh = h;
  // Reduce all the way down so even very large holes receive colour.
  while (Math.max(cw, chh) > 1) {
    levels.push({ c, wt, w: cw, h: chh });
    const pre = new Float32Array(c.length);
    for (let i = 0; i < cw * chh; i++) for (let q = 0; q < 3; q++) pre[i * 3 + q] = c[i * 3 + q] * wt[i];
    const cd = pyrDown(pre, cw, chh, 3), wd = pyrDown(wt, cw, chh, 1);
    const nc = new Float32Array(cd.d.length), nw = new Float32Array(wd.d.length);
    for (let i = 0; i < nw.length; i++) {
      const ww = wd.d[i];
      for (let q = 0; q < 3; q++) nc[i * 3 + q] = cd.d[i * 3 + q] / Math.max(ww, 1e-4);
      nw[i] = Math.min(ww * 4, 1);
    }
    c = nc; wt = nw; cw = cd.w; chh = cd.h;
  }
  for (let l = levels.length - 1; l >= 0; l--) {
    const L = levels[l];
    const up = resize(c, cw, chh, 3, L.w, L.h);
    const next = new Float32Array(L.w * L.h * 3);
    for (let i = 0; i < L.w * L.h; i++) for (let q = 0; q < 3; q++) {
      next[i * 3 + q] = L.c[i * 3 + q] * L.wt[i] + up[i * 3 + q] * (1 - L.wt[i]);
    }
    c = next; cw = L.w; chh = L.h;
  }
  return c;
}

/** Deterministic normal noise (Box–Muller on a seeded PRNG). */
export function gaussNoise(n: number, sd: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967297;
  };
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = rnd(), v = rnd();
    const r = Math.sqrt(-2 * Math.log(u)) * sd;
    out[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  return out;
}


// ───────────────────────── layer building blocks ─────────────────────────

/** The card's colours with a 0..1 alpha map. */
export function withAlpha(card: RGBAImage, a: Float32Array): RGBAImage {
  const out = createImage(card.width, card.height);
  for (let i = 0; i < a.length; i++) {
    const o = i * 4;
    out.data[o] = card.data[o]; out.data[o + 1] = card.data[o + 1]; out.data[o + 2] = card.data[o + 2];
    out.data[o + 3] = Math.round(Math.min(1, Math.max(0, a[i])) * 255);
  }
  return out;
}

/**
 * Character layer: the card with the character's alpha, its clothes mirrored
 * further down under the banner and past the window's sides so no cut edge
 * shows when it slides behind the still frame.
 */
export function characterLayer(card: RGBAImage, alpha: Float32Array, cut: Float32Array, box: [number, number, number, number], s: CardSettings): RGBAImage {
  const W = card.width, H = card.height;
  const k = W / 941;
  const [X0, , X1] = box;
  const char = withAlpha(card, alpha);
  const src = Uint8ClampedArray.from(char.data);
  const down = Math.round(s.extend[0] * k), side = Math.round(s.extend[1] * k);
  const out = char.data;
  const px = (x: number, y: number) => (y * W + x) * 4;
  if (!s.noBanner) {
    for (let x = X0; x < X1; x++) {
      const c = Math.floor(cut[x]) - 3;
      for (let y = Math.max(0, c); y < H; y++) out.fill(0, px(x, y), px(x, y) + 4);
      for (let kk = 1; kk < down; kk++) {
        const ys = c - kk, yd = c + kk - 1;
        if (ys < 0 || yd >= H) break;
        if (yd >= 0) out.set(src.subarray(px(x, ys), px(x, ys) + 4), px(x, yd));
      }
    }
  }
  for (let kk = 1; kk < side; kk++) {
    for (let y = 0; y < H; y++) {
      if (X0 - kk >= 0 && X0 + kk < W) out.copyWithin(px(X0 - kk, y), px(X0 + kk, y), px(X0 + kk, y) + 4);
      if (X1 - 1 + kk < W && X1 - 1 - kk >= 0) out.copyWithin(px(X1 - 1 + kk, y), px(X1 - 1 - kk, y), px(X1 - 1 - kk, y) + 4);
    }
  }
  return char;
}

/**
 * Frame alpha: everything but the window above the banner, plus bronze
 * ornaments that touch the window's edge (never character pixels).
 */
export function frameAlpha(
  card: RGBAImage, win: Uint8Array, above: Uint8Array,
  c: { hue: Float32Array; sat: Float32Array; val: Float32Array },
  alpha: Float32Array, box: [number, number, number, number],
): Float32Array {
  const W = card.width, H = card.height, N = W * H;
  const k = W / 941;
  const [X0, Y0, X1, Y1] = box;
  const fa0 = new Float32Array(N);
  for (let i = 0; i < N; i++) fa0[i] = !win[i] || !above[i] ? 1 : 0;
  const ex = Math.round(70 * k), ey = Math.round(90 * k);
  const orn = new Uint8Array(N);
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
    const i = y * W + x;
    const inner = y >= Y0 + ey && y < Y1 - ey && x >= X0 + ex && x < X1 - ex;
    const bronze = c.hue[i] > 12 && c.hue[i] < 48 && c.sat[i] > 0.25 && c.val[i] > 0.32;
    // Ornaments are frame, never character (fur or clothes can look bronze).
    if (bronze && !inner && above[i] && alpha[i] < 0.5) orn[i] = 1;
  }
  const ornD = morph(orn, W, H, 2, true);
  const oc = components(ornD, W, H);
  const touching = oc.comps.map((cc) => cc.x0 <= X0 + 3 || cc.y0 <= Y0 + 3 || cc.x1 + 1 >= X1 - 3);
  for (let i = 0; i < N; i++) if (oc.label[i] >= 0 && touching[oc.label[i]]) fa0[i] = 1;
  return softBlur(fa0, W, H, 0.7);
}

/** Area to fill behind moving layers: dilated layer alpha + the frame's parts inside the window. */
export function behindHole(alpha: Float32Array, fa: Float32Array, win: Uint8Array, W: number, H: number, k: number): Float32Array {
  const N = W * H;
  const holeB = new Uint8Array(N);
  for (let i = 0; i < N; i++) holeB[i] = alpha[i] > 0.03 ? 1 : 0;
  const holeD = morph(holeB, W, H, Math.max(1, Math.round(8 * k)), true);
  const hole = new Float32Array(N);
  for (let i = 0; i < N; i++) hole[i] = Math.max(holeD[i], fa[i] > 0.5 && win[i] ? 1 : 0);
  return hole;
}

/**
 * Background layer: the window with the `hole` area filled by a smooth
 * push-pull fill plus grain, carried on past the window's edges.
 */
export function fillBehind(card: RGBAImage, hole: Float32Array, win: Uint8Array, box: [number, number, number, number]): RGBAImage {
  const W = card.width, H = card.height, N = W * H;
  const k = W / 941;
  const [X0, Y0, X1, Y1] = box;
  const known = new Float32Array(N);
  for (let i = 0; i < N; i++) known[i] = (1 - hole[i]) * win[i];
  const f = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) for (let q = 0; q < 3; q++) f[i * 3 + q] = card.data[i * 4 + q] * known[i];
  const fill = pushPull(f, known, W, H);
  const grain = gaussNoise(N, 6, 3);
  const soft = gaussian(hole, W, H, 4);
  const res = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) for (let q = 0; q < 3; q++) {
    res[i * 3 + q] = card.data[i * 4 + q] * (1 - soft[i]) + (fill[i * 3 + q] + grain[i]) * soft[i];
  }
  // Carry the window's content past its edges (replicate, then blur outside).
  const full = new Float32Array(N * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.min(X1 - 1, Math.max(X0, x)), sy = Math.min(Y1 - 1, Math.max(Y0, y));
    for (let q = 0; q < 3; q++) full[(y * W + x) * 3 + q] = res[(sy * W + sx) * 3 + q];
  }
  const blurred = new Float32Array(N * 3);
  for (let q = 0; q < 3; q++) {
    const chn = new Float32Array(N);
    for (let i = 0; i < N; i++) chn[i] = full[i * 3 + q];
    const b = gaussian(chn, W, H, 18 * k);
    for (let i = 0; i < N; i++) blurred[i * 3 + q] = b[i];
  }
  const ins0 = new Float32Array(N);
  for (let i = 0; i < N; i++) ins0[i] = win[i];
  const ins = gaussian(ins0, W, H, 6 * k);
  const bg = createImage(W, H);
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    for (let q = 0; q < 3; q++) bg.data[o + q] = win[i] ? res[i * 3 + q] : full[i * 3 + q] * ins[i] + blurred[i * 3 + q] * (1 - ins[i]);
    bg.data[o + 3] = 255;
  }
  return bg;
}

// ───────────────────────── the split ─────────────────────────

/**
 * Split a card into frame / char / bg layers.
 * `matte`: the segmentation model's foreground probability for the window
 * crop (winW × winH, 0..1). `ownBg`: optional background painting.
 */
export function splitCard(
  card: RGBAImage,
  matteFor: (win: [number, number, number, number]) => Float32Array,
  s: CardSettings,
  ownBg: RGBAImage | null,
): CardLayers {
  const W = card.width, H = card.height, N = W * H;
  const k = W / 941; // the tool's pixel constants are for Howlfall's 941 px wide cards
  const [X0, Y0, X1, Y1] = findWindow(card, s.window);
  const cut = bannerLine(card, [X0, Y0, X1, Y1], s.noBanner ? null : s.bannerBand);
  const win = new Uint8Array(N), above = new Uint8Array(N);
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
    const i = y * W + x;
    win[i] = 1;
    if (y <= cut[x]) above[i] = 1;
  }
  const { hue, sat, val } = hsv(card);

  // Character matte.
  const m = new Float32Array(N);
  const crop = matteFor([X0, Y0, X1, Y1]);
  const cw = X1 - X0;
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) m[y * W + x] = crop[(y - Y0) * cw + (x - X0)];
  if (s.dropHue) {
    const [h0, h1] = s.dropHue;
    const glow = new Uint8Array(N);
    for (let i = 0; i < N; i++) glow[i] = hue[i] > h0 && hue[i] < h1 && sat[i] > 0.45 && val[i] > 0.5 ? 1 : 0;
    const opened = morph(morph(glow, W, H, 1, false), W, H, 1, true);
    for (let i = 0; i < N; i++) if (opened[i]) m[i] = 0;
  }
  for (let i = 0; i < N; i++) if (!above[i]) m[i] = 0;
  let hard = new Uint8Array(N);
  for (let i = 0; i < N; i++) hard[i] = m[i] > 0.5 ? 1 : 0;
  const { label, comps } = components(hard, W, H);
  if (!comps.length) throw new Error('No character found inside the window.');
  let best = 0;
  comps.forEach((c, i) => { if (c.area > comps[best].area) best = i; });
  for (let i = 0; i < N; i++) hard[i] = label[i] === best ? 1 : 0;
  hard = morph(morph(hard, W, H, 2, true), W, H, 2, false); // close 5×5
  const a0 = new Float32Array(N);
  for (let i = 0; i < N; i++) a0[i] = Math.min(1, m[i]) * hard[i];
  const alpha = softBlur(a0, W, H, 0.8);

  const box: [number, number, number, number] = [X0, Y0, X1, Y1];
  const char = characterLayer(card, alpha, cut, box, s);
  const fa = frameAlpha(card, win, above, { hue, sat, val }, alpha, box);
  const frame = withAlpha(card, fa);
  const ownBackground = !!ownBg;
  const bg = ownBg ?? fillBehind(card, behindHole(alpha, fa, win, W, H, k), win, box);

  let cmin = Infinity, cmax = -Infinity;
  for (let x = 0; x < W; x++) { cmin = Math.min(cmin, cut[x]); cmax = Math.max(cmax, cut[x]); }
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return {
    frame, char, bg,
    info: {
      size: [W, H],
      window: [X0, Y0, X1, Y1],
      win: { x: r4(X0 / W), y: r4(Y0 / H), w: r4((X1 - X0) / W), h: r4((Y1 - Y0) / H) },
      bannerTop: s.noBanner ? null : [Math.round(cut[Math.min(W - 1, X0 + 2)]), Math.round(cmin), Math.round(cmax)],
      ownBackground,
    },
  };
}
