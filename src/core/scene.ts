/**
 * 3D Scene: put the photo's subject into a new background that is built for
 * depth, and add relief detail to the subject so it pops out.
 *
 *  1. Subject cut-out: the depth-based subject mask (same detector as the
 *     stereogram sketch), refined with an edge-aware guided filter that snaps
 *     the soft edge to the photo.
 *  2. Background with known depth: procedurally generated (auto-from-photo
 *     palette, mountains, tunnel, space, room, bokeh) so every pixel's
 *     distance is exact, or a user-supplied background with estimated depth.
 *  3. Subject relief: placed clearly in front of the background, rounded,
 *     with its own depth and fine surface detail (bas-relief from the photo).
 *  4. The composite photo + its depth map then feed every 3D style.
 *
 * Everything is deterministic (seeded) and runs in the browser.
 */
import type { DepthMap } from './depth';
import { insideDistance, subjectMask } from './sketch';
import { createImage, type RGBAImage } from './types';

export type SceneBackground = 'auto' | 'mountains' | 'tunnel' | 'space' | 'room' | 'bokeh' | 'custom' | 'original';

export interface SceneSettings {
  enabled: boolean;
  background: SceneBackground;
  /** Id of the selected custom background (browser storage). */
  customId: string | null;
  /** 0..1: how much depth range the background itself spans. */
  backgroundDepth: number;
  /** 0..1: extra relief detail on the subject. */
  subjectPop: number;
  /** 0..1: gap between the subject and the background. */
  separation: number;
  /** 0..1: softness of the subject's edge. */
  edge: number;
  /** Shift of the automatic subject/background split (−0.3 … +0.3). */
  threshold: number;
  /** Soft contact shadow of the subject on the background. */
  shadow: boolean;
  seed: number;
}

export const DEFAULT_SCENE: SceneSettings = {
  enabled: false,
  background: 'auto',
  customId: null,
  backgroundDepth: 0.8,
  subjectPop: 0.5,
  separation: 0.5,
  edge: 0.3,
  threshold: 0,
  shadow: true,
  seed: 1,
};

type RGB = [number, number, number];

// ───────────────────────── helpers ─────────────────────────

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

function hash1(x: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(seed, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 1-D fractal value noise in 0..1. */
function ridge1(x: number, seed: number, octaves = 5): number {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const xi = Math.floor(x * f), fx = x * f - xi;
    const s = fx * fx * (3 - 2 * fx);
    const a = hash1(xi, seed + o * 31), b = hash1(xi + 1, seed + o * 31);
    v += amp * (a + (b - a) * s);
    norm += amp; amp *= 0.5; f *= 2.1;
  }
  return v / norm;
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed), c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm2(x: number, y: number, seed: number, oct = 5): number {
  let v = 0, amp = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { v += amp * noise2(x * f, y * f, seed + o * 17); n += amp; amp *= 0.5; f *= 2; }
  return v / n;
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const lum = (c: RGB) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/** Representative colours (k-means, deterministic) of the masked-out area. */
export function extractPalette(photo: RGBAImage, weight: (i: number) => number, k = 5): RGB[] {
  const pts: RGB[] = [];
  const n = photo.width * photo.height;
  const step = Math.max(1, Math.floor(n / 20000));
  for (let i = 0; i < n; i += step) {
    if (weight(i) < 0.5) continue;
    const o = i * 4;
    pts.push([photo.data[o], photo.data[o + 1], photo.data[o + 2]]);
  }
  if (pts.length < k) for (let i = 0; i < n; i += step) { const o = i * 4; pts.push([photo.data[o], photo.data[o + 1], photo.data[o + 2]]); }
  pts.sort((a, b) => lum(a) - lum(b));
  let centers: RGB[] = Array.from({ length: k }, (_, j) => pts[Math.floor(((j + 0.5) / k) * pts.length)].slice() as RGB);
  for (let it = 0; it < 8; it++) {
    const sum = centers.map(() => [0, 0, 0, 0]);
    for (const p of pts) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const c = centers[j];
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
      const s = sum[best]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    }
    centers = centers.map((c, j) => (sum[j][3] ? [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]] : c)) as RGB[];
  }
  return centers.sort((a, b) => lum(a) - lum(b));
}

/** Boost saturation a little so generated scenes are vivid. */
function vivid(c: RGB, amount = 1.25): RGB {
  const l = lum(c);
  return [l + (c[0] - l) * amount, l + (c[1] - l) * amount, l + (c[2] - l) * amount].map((v) => Math.max(0, Math.min(255, v))) as RGB;
}

// ───────────────────────── backgrounds ─────────────────────────

export interface Layer {
  image: RGBAImage;
  /** 0 = farthest … 1 = nearest (within the background). */
  depth: Float32Array;
}

const PRESET_PALETTES: Record<string, RGB[]> = {
  mountains: [[24, 18, 46], [64, 44, 96], [150, 70, 110], [240, 140, 90], [255, 214, 150]],
  tunnel: [[10, 8, 30], [40, 20, 110], [120, 40, 200], [40, 190, 230], [250, 240, 255]],
  space: [[4, 6, 18], [20, 24, 70], [90, 40, 140], [40, 150, 200], [255, 240, 220]],
  room: [[24, 26, 34], [60, 66, 84], [110, 120, 150], [200, 140, 90], [240, 236, 228]],
  bokeh: [[8, 10, 20], [30, 40, 80], [200, 90, 120], [250, 180, 80], [255, 245, 220]],
};

function put(img: RGBAImage, i: number, c: RGB) {
  const o = i * 4;
  img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
}

/** Layered landscape: sky, sun, hazy ridges receding into the distance, bokeh. */
function landscape(W: number, H: number, pal: RGB[], seed: number): Layer {
  const img = createImage(W, H);
  const depth = new Float32Array(W * H);
  const p = pal.map((c) => vivid(c));
  const skyTop = mix(p[1], p[0], 0.4), skyBot = mix(p[4], p[3], 0.3);
  const ridges = 6;
  const tops: number[][] = [];
  for (let k = 0; k < ridges; k++) {
    const base = 0.36 + 0.11 * k;
    const amp = 0.06 + 0.035 * k;
    const freq = 2.2 + k * 0.9;
    const row: number[] = [];
    for (let x = 0; x < W; x++) row.push((base - amp * (ridge1((x / W) * freq, seed + k * 101) - 0.5) * 2) * H);
    tops.push(row);
  }
  const sunX = (0.25 + 0.5 * hash1(3, seed)) * W, sunY = 0.24 * H, sunR = 0.08 * Math.min(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let layer = -1;
    for (let k = ridges - 1; k >= 0; k--) if (y >= tops[k][x]) { layer = k; break; }
    let c: RGB, z: number;
    if (layer < 0) {
      c = mix(skyTop, skyBot, Math.min(1, y / (0.5 * H)));
      const ds = Math.hypot(x - sunX, y - sunY);
      if (ds < sunR) c = mix(c, [255, 246, 220], 0.9);
      else c = mix(c, [255, 230, 190], Math.max(0, 0.35 * (1 - (ds - sunR) / (sunR * 3))));
      z = 0;
    } else {
      const t = layer / (ridges - 1); // 0 far … 1 near
      const ground = mix(p[2], p[0], t);
      const shade = 0.85 + 0.15 * fbm2(x / (W * 0.08), y / (H * 0.08), seed + layer, 4);
      c = mix(mix(skyBot, ground, 0.35 + 0.65 * t), [0, 0, 0], (1 - shade) * t);
      // Depth: each ridge a step nearer; slight slope within the ridge.
      const within = Math.min(1, (y - tops[layer][x]) / (H * 0.25));
      z = 0.12 + 0.75 * t + 0.1 * within * t;
    }
    put(img, i, c);
    depth[i] = Math.min(1, z);
  }
  bokeh(img, depth, p, seed + 7, 26, 0.35, 0.95);
  return { image: img, depth };
}

/** Soft glowing circles at varied depths (bigger = nearer). */
function bokeh(img: RGBAImage, depth: Float32Array, pal: RGB[], seed: number, count: number, zMin: number, zMax: number) {
  const W = img.width, H = img.height;
  const rnd = mulberry32(seed);
  const circles = Array.from({ length: count }, () => {
    const z = zMin + (zMax - zMin) * rnd();
    return { x: rnd() * W, y: rnd() * H, r: Math.min(W, H) * (0.01 + 0.05 * z * z), z, c: pal[2 + Math.floor(rnd() * (pal.length - 2))] };
  }).sort((a, b) => a.z - b.z);
  for (const b of circles) {
    const x0 = Math.max(0, Math.floor(b.x - b.r)), x1 = Math.min(W - 1, Math.ceil(b.x + b.r));
    const y0 = Math.max(0, Math.floor(b.y - b.r)), y1 = Math.min(H - 1, Math.ceil(b.y + b.r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - b.x, y + 0.5 - b.y) / b.r;
      if (d > 1) continue;
      const a = 0.55 * Math.min(1, (1 - d) * 4) * (0.6 + 0.4 * d);
      const i = y * W + x, o = i * 4;
      const c = mix([img.data[o], img.data[o + 1], img.data[o + 2]], mix(b.c, [255, 255, 255], 0.35), a);
      put(img, i, c);
      if (b.z > depth[i]) depth[i] = depth[i] + (b.z - depth[i]) * Math.min(1, a * 2);
    }
  }
}

/** Rounded-rectangle tunnel receding to a vanishing point. */
function tunnel(W: number, H: number, pal: RGB[], seed: number): Layer {
  const img = createImage(W, H);
  const depth = new Float32Array(W * H);
  const p = pal.map((c) => vivid(c, 1.4));
  const cx = W * (0.45 + 0.1 * hash1(5, seed)), cy = H * 0.45;
  const a = W * 0.5, b = H * 0.5;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const nx = (x - cx) / a, ny = (y - cy) / b;
    const d = Math.pow(Math.pow(Math.abs(nx), 4) + Math.pow(Math.abs(ny), 4), 0.25); // superellipse
    const dist = 1 / Math.max(0.04, d); // distance along the tunnel
    const ring = Math.log(dist) * 6;
    const band = ring - Math.floor(ring);
    const k = ((Math.floor(ring) % p.length) + p.length) % p.length;
    let c = mix(p[k], p[(k + 1) % p.length], band);
    const glow = Math.exp(-((band - 0.5) ** 2) / 0.01);
    c = mix(c, [255, 255, 255], 0.35 * glow);
    c = mix([0, 0, 0], c, Math.min(1, d * 1.6)); // darker far away
    const i = y * W + x;
    put(img, i, c);
    depth[i] = Math.min(1, Math.max(0, d)); // edges near, centre far
  }
  return { image: img, depth };
}

/** Deep space: nebula far away, stars and planets at many depths. */
function space(W: number, H: number, pal: RGB[], seed: number): Layer {
  const img = createImage(W, H);
  const depth = new Float32Array(W * H);
  const p = pal.map((c) => vivid(c, 1.3));
  const s = Math.max(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const n1 = fbm2(x / (s * 0.25), y / (s * 0.25), seed, 5);
    const n2 = fbm2(x / (s * 0.12), y / (s * 0.12), seed + 9, 4);
    let c = mix(p[0], p[1], Math.max(0, n1 * 1.6 - 0.4));
    c = mix(c, p[2], Math.max(0, n2 * 1.8 - 0.9));
    c = mix(c, p[3], Math.max(0, n1 * n2 * 3 - 1.1));
    const i = y * W + x;
    put(img, i, c);
    depth[i] = 0.05 * n1;
  }
  const rnd = mulberry32(seed + 3);
  const stars = Math.round((W * H) / 1800);
  for (let k = 0; k < stars; k++) {
    const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H), z = rnd() ** 2;
    const r = 0.6 + 2.2 * z * (s / 1600);
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const a = Math.max(0, 1 - Math.hypot(dx, dy) / r);
      if (!a) continue;
      const i = yy * W + xx, o = i * 4;
      put(img, i, mix([img.data[o], img.data[o + 1], img.data[o + 2]], p[4], a));
      depth[i] = Math.max(depth[i], z * a);
    }
  }
  // Two planets at mid depth with simple shading.
  for (let k = 0; k < 2; k++) {
    const r = s * (0.06 + 0.06 * rnd()), x0 = rnd() * W, y0 = rnd() * H * 0.8, z = 0.35 + 0.3 * rnd();
    const col = p[2 + k];
    for (let y = Math.max(0, Math.floor(y0 - r)); y < Math.min(H, y0 + r); y++) for (let x = Math.max(0, Math.floor(x0 - r)); x < Math.min(W, x0 + r); x++) {
      const dx = (x - x0) / r, dy = (y - y0) / r, d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      const nz = Math.sqrt(1 - d2);
      const light = Math.max(0.08, -0.5 * dx - 0.6 * dy + 0.62 * nz);
      const i = y * W + x;
      put(img, i, mix([0, 0, 0], mix(col, [255, 255, 255], 0.2 * fbm2(x / (r * 0.3), y / (r * 0.3), seed + k)), light));
      depth[i] = z + 0.08 * nz;
    }
  }
  return { image: img, depth };
}

/** A room in perspective: far back wall, floor, ceiling and side walls with grids. */
function room(W: number, H: number, pal: RGB[], seed: number): Layer {
  const img = createImage(W, H);
  const depth = new Float32Array(W * H);
  const p = pal.map((c) => vivid(c, 1.1));
  const cx = W * (0.5 + 0.06 * (hash1(1, seed) - 0.5)), cy = H * 0.42;
  const bw = W * 0.28, bh = H * 0.22; // back wall half-size
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const nx = (x - cx) / bw, ny = (y - cy) / bh;
    const m = Math.max(Math.abs(nx), Math.abs(ny));
    let c: RGB, z: number;
    if (m <= 1) {
      // Back wall: far, with a soft window glow.
      c = mix(p[2], p[4], 0.25 + 0.25 * Math.max(0, 1 - Math.hypot(nx * 0.8, ny + 0.2)));
      const grid = (Math.abs(((nx * 3 + 30) % 1) - 0.5) < 0.02 || Math.abs(((ny * 3 + 30) % 1) - 0.5) < 0.02) ? 0.12 : 0;
      c = mix(c, [0, 0, 0], grid);
      z = 0;
    } else {
      // Perspective depth: 1/m (back wall at m = 1, frame edges near).
      const near = 1 - 1 / m;
      const floor = ny > Math.abs(nx);
      const ceil = ny < -Math.abs(nx);
      const u = floor || ceil ? nx / m : ny / m; // coordinate across the surface
      const v = 1 / m;
      const lineU = Math.abs(((u * 6 + 60) % 1) - 0.5) < 0.03;
      const lineV = Math.abs(((Math.log(v) * 4 + 60) % 1) - 0.5) < 0.04;
      const base = floor ? p[3] : ceil ? p[1] : p[2];
      c = mix(base, [0, 0, 0], 0.15 + 0.35 * near);
      if (lineU || lineV) c = mix(c, p[4], floor ? 0.5 : 0.25);
      z = Math.min(1, near * 1.15);
    }
    const i = y * W + x;
    put(img, i, c);
    depth[i] = z;
  }
  return { image: img, depth };
}

function bokehScene(W: number, H: number, pal: RGB[], seed: number): Layer {
  const img = createImage(W, H);
  const depth = new Float32Array(W * H);
  const p = pal.map((c) => vivid(c, 1.3));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    put(img, i, mix(p[0], p[1], 0.5 * fbm2(x / (W * 0.4), y / (H * 0.4), seed) + 0.3 * (y / H)));
  }
  bokeh(img, depth, p, seed, 70, 0.05, 1);
  return { image: img, depth };
}

/** Resample a custom background (and its depth) to W × H (cover fit). */
function customLayer(bg: RGBAImage, bgDepth: DepthMap, W: number, H: number): Layer {
  const img = createImage(W, H);
  const depth = new Float32Array(W * H);
  const s = Math.max(W / bg.width, H / bg.height);
  const ox = (bg.width * s - W) / 2, oy = (bg.height * s - H) / 2;
  const sorted = Float32Array.from(bgDepth.data).sort();
  const lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.floor(sorted.length * 0.99)] || lo + 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x + ox + 0.5) / s - 0.5, v = (y + oy + 0.5) / s - 0.5;
    const xi = Math.max(0, Math.min(bg.width - 2, Math.floor(u))), yi = Math.max(0, Math.min(bg.height - 2, Math.floor(v)));
    const fx = Math.min(1, Math.max(0, u - xi)), fy = Math.min(1, Math.max(0, v - yi));
    const i = y * W + x, o = i * 4;
    for (let c = 0; c < 3; c++) {
      const a = bg.data[(yi * bg.width + xi) * 4 + c], b = bg.data[(yi * bg.width + xi + 1) * 4 + c];
      const cc = bg.data[((yi + 1) * bg.width + xi) * 4 + c], d = bg.data[((yi + 1) * bg.width + xi + 1) * 4 + c];
      img.data[o + c] = (a + (b - a) * fx) * (1 - fy) + (cc + (d - cc) * fx) * fy;
    }
    img.data[o + 3] = 255;
    const du = Math.min(bgDepth.width - 1, Math.max(0, Math.round((u / bg.width) * bgDepth.width)));
    const dv = Math.min(bgDepth.height - 1, Math.max(0, Math.round((v / bg.height) * bgDepth.height)));
    depth[i] = Math.min(1, Math.max(0, (bgDepth.data[dv * bgDepth.width + du] - lo) / (hi - lo)));
  }
  return { image: img, depth };
}

export function generateBackground(
  kind: Exclude<SceneBackground, 'custom' | 'original'>,
  W: number,
  H: number,
  palette: RGB[],
  seed: number,
): Layer {
  switch (kind) {
    case 'auto': return landscape(W, H, palette, seed);
    case 'mountains': return landscape(W, H, PRESET_PALETTES.mountains, seed);
    case 'tunnel': return tunnel(W, H, PRESET_PALETTES.tunnel, seed);
    case 'space': return space(W, H, PRESET_PALETTES.space, seed);
    case 'room': return room(W, H, PRESET_PALETTES.room, seed);
    case 'bokeh': return bokehScene(W, H, PRESET_PALETTES.bokeh, seed);
  }
}

// ───────────────────────── matting ─────────────────────────

/**
 * Guided filter (He et al.): refines a coarse mask `p` so its edges follow
 * the structure of the guide image `I` (grayscale 0..1).
 */
export function guidedFilter(I: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const box = (v: Float32Array) => smoothBox(v, w, h, r);
  const n = w * h;
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = box(I), mp = box(p), mIp = box(Ip), mII = box(II);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = mIp[i] - mI[i] * mp[i];
    const v = mII[i] - mI[i] * mI[i];
    a[i] = cov / (v + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = box(a), mb = box(b);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, ma[i] * I[i] + mb[i]));
  return q;
}

/** Single-pass box mean (radius r), edge-clamped. */
function smoothBox(v: Float32Array, w: number, h: number, r: number): Float32Array {
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

/** Keep connected regions at least `frac` × the largest one (drops stray near objects). */
export function keepMainRegions(mask: Uint8Array, w: number, h: number, frac: number): void {
  const label = new Int32Array(mask.length).fill(-1);
  const sizes: number[] = [];
  const queue = new Int32Array(mask.length);
  for (let s0 = 0; s0 < mask.length; s0++) {
    if (!mask[s0] || label[s0] >= 0) continue;
    const id = sizes.length;
    let head = 0, tail = 0;
    queue[tail++] = s0; label[s0] = id;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w, y = (i - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (mask[j] && label[j] < 0) { label[j] = id; queue[tail++] = j; }
      }
    }
    sizes.push(tail);
  }
  const largest = Math.max(0, ...sizes);
  for (let i = 0; i < mask.length; i++) if (mask[i] && sizes[label[i]] < largest * frac) mask[i] = 0;
}

// ───────────────────────── composite ─────────────────────────

export interface SceneResult {
  /** Composite photo at the source resolution. */
  image: RGBAImage;
  /** Normalised depth of the composite (0 = far … 1 = near), working resolution. */
  depth: DepthMap;
  /** Subject alpha at working resolution (for previews / tests). */
  alpha: DepthMap;
}

/** Bilinear sample of a single-channel map at normalised coordinates. */
function sampleMap(m: DepthMap, u: number, v: number): number {
  const x = Math.min(m.width - 1, Math.max(0, u * m.width - 0.5));
  const y = Math.min(m.height - 1, Math.max(0, v * m.height - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(m.width - 1, x0 + 1), y1 = Math.min(m.height - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const d = m.data, w = m.width;
  return (d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx) * (1 - fy) + (d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx) * fy;
}

/** Area-average downscale to fit `maxSide`. */
export function downscale(img: RGBAImage, maxSide: number): RGBAImage {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (s === 1) return img;
  const W = Math.max(1, Math.round(img.width * s)), H = Math.max(1, Math.round(img.height * s));
  const out = createImage(W, H);
  for (let y = 0; y < H; y++) {
    const sy0 = Math.floor(y / s), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) / s));
    for (let x = 0; x < W; x++) {
      const sx0 = Math.floor(x / s), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) / s));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = sy0; yy < Math.min(img.height, sy1); yy++) for (let xx = sx0; xx < Math.min(img.width, sx1); xx++) {
        const o = (yy * img.width + xx) * 4;
        r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; a += img.data[o + 3]; n++;
      }
      const o = (y * W + x) * 4;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = a / n;
    }
  }
  return out;
}

const WORK_SIDE = 1024;

/**
 * Build the 3D scene. `rawDepth` is the model's relative inverse depth of
 * the photo (larger = nearer); `custom` the selected custom background.
 */
export function buildScene(
  photo: RGBAImage,
  rawDepth: DepthMap,
  s: SceneSettings,
  custom: { image: RGBAImage; depth: DepthMap } | null,
): SceneResult {
  // Working resolution for masks and depth.
  const small = downscale(photo, WORK_SIDE);
  const w = small.width, h = small.height, n = w * h;
  // Normalised photo depth at working resolution.
  const sorted = Float32Array.from(rawDepth.data).sort();
  const lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.floor(sorted.length * 0.99)] || lo + 1;
  const dn: DepthMap = { width: w, height: h, data: new Float32Array(n) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = sampleMap(rawDepth, (x + 0.5) / w, (y + 0.5) / h);
    dn.data[y * w + x] = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  }

  // 1. Subject alpha: depth mask → guided filter on the photo → feather.
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    gray[i] = (0.299 * small.data[o] + 0.587 * small.data[o + 1] + 0.114 * small.data[o + 2]) / 255;
  }
  const coarse = subjectMask(dn, s.threshold);
  keepMainRegions(coarse, w, h, 0.35);
  const p = Float32Array.from(coarse);
  const r = Math.max(2, Math.round(Math.max(w, h) / 120));
  let alpha = guidedFilter(gray, p, w, h, r, 1e-3);
  // Contrast the matte, then feather by the edge setting.
  for (let i = 0; i < n; i++) alpha[i] = Math.min(1, Math.max(0, (alpha[i] - 0.5) * 2.2 + 0.5));
  const feather = Math.round(Math.max(0, Math.min(1, s.edge)) * Math.max(w, h) / 300);
  if (feather > 0) alpha = smoothBox(alpha, w, h, feather);
  const alphaMap: DepthMap = { width: w, height: h, data: alpha };

  // 2. Background (generated with exact depth, the photo itself, or custom).
  let bg: Layer;
  if (s.background === 'original') {
    bg = { image: small, depth: Float32Array.from(dn.data) };
  } else if (s.background === 'custom' && custom) {
    bg = customLayer(custom.image, custom.depth, w, h);
  } else {
    const kind = s.background === 'custom' ? 'auto' : s.background;
    const palette = extractPalette(small, (i) => 1 - coarse[i]);
    bg = generateBackground(kind, w, h, palette, s.seed);
  }

  // 3. Depth: background squeezed into the far range, subject in front with
  //    rounded body, its own relief and fine surface detail.
  const bgRange = 0.15 + 0.4 * Math.max(0, Math.min(1, s.backgroundDepth));
  const gap = 0.04 + 0.16 * Math.max(0, Math.min(1, s.separation));
  const subjBase = Math.min(0.9, bgRange + gap);
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = alpha[i] > 0.5 ? 1 : 0;
  const dist = insideDistance(bin, w, h);
  const R = Math.max(4, Math.max(w, h) * 0.06);
  let sLo = 1, sHi = 0;
  for (let i = 0; i < n; i++) if (bin[i]) { sLo = Math.min(sLo, dn.data[i]); sHi = Math.max(sHi, dn.data[i]); }
  const sRange = sHi - sLo || 1;
  const blurG = smoothBox(gray, w, h, Math.max(1, Math.round(Math.max(w, h) / 180)));
  const pop = Math.max(0, Math.min(1, s.subjectPop));
  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const zb = bg.depth[i] * bgRange;
    const q = Math.min(1, dist[i] / R);
    const dome = Math.sqrt(1 - (1 - q) * (1 - q));
    const own = (dn.data[i] - sLo) / sRange;
    const detail = (gray[i] - blurG[i]) * 3; // bas-relief: brighter detail stands out
    let zs = subjBase + (1 - subjBase) * (0.45 * own + 0.4 * dome * (0.5 + 0.5 * pop) + 0.15);
    zs += detail * 0.18 * pop;
    zs = Math.min(1, Math.max(subjBase, zs));
    depth[i] = alpha[i] * zs + (1 - alpha[i]) * zb;
  }

  // 4. Contact shadow on the background (working resolution).
  const shadow = new Float32Array(n);
  if (s.shadow && s.background !== 'original') {
    const ox = Math.round(w * 0.012), oy = Math.round(h * 0.02);
    const shifted = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = x - ox, sy = y - oy;
      shifted[y * w + x] = sx >= 0 && sy >= 0 && sx < w && sy < h ? alpha[sy * w + sx] : 0;
    }
    const soft = smoothBox(smoothBox(shifted, w, h, Math.max(2, Math.round(w / 60))), w, h, Math.max(2, Math.round(w / 60)));
    for (let i = 0; i < n; i++) shadow[i] = soft[i] * 0.45;
  }

  // 5. Colour composite at the full photo resolution.
  const W = photo.width, H = photo.height;
  const out = createImage(W, H);
  const shadowMap: DepthMap = { width: w, height: h, data: shadow };
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const a = sampleMap(alphaMap, u, v);
      const sh = shadowMap.data.length ? sampleMap(shadowMap, u, v) : 0;
      // Background colour (bilinear from the working-resolution layer).
      const bx = Math.min(w - 1, Math.max(0, u * w - 0.5)), by = Math.min(h - 1, Math.max(0, v * h - 0.5));
      const x0 = Math.floor(bx), y0 = Math.floor(by), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const fx = bx - x0, fy = by - y0;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const bgv = (bg.image.data[(y0 * w + x0) * 4 + c] * (1 - fx) + bg.image.data[(y0 * w + x1) * 4 + c] * fx) * (1 - fy)
          + (bg.image.data[(y1 * w + x0) * 4 + c] * (1 - fx) + bg.image.data[(y1 * w + x1) * 4 + c] * fx) * fy;
        const bgc = bgv * (1 - sh);
        out.data[o + c] = a * photo.data[o + c] + (1 - a) * bgc;
      }
      out.data[o + 3] = 255;
    }
  }
  return { image: out, depth: { width: w, height: h, data: depth }, alpha: alphaMap };
}
