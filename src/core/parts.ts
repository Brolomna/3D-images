/**
 * "More downloads": the intermediate pictures the app already makes, as
 * files — eye views, depth maps (16-bit grayscale PNG, bright = near),
 * wiggle / motion frames, the stereogram's sketch and hidden shape, and the
 * 3D Scene's cut-out subject, background and depth.
 */
import { encode } from 'fast-png';
import type { DepthMap } from './depth';
import { encodePNG } from './encode';
import type { RGBAImage } from './types';

/** 16-bit grayscale PNG of a 0..1 depth map (bright = near). */
export function encodeDepthPNG(map: DepthMap): Uint8Array {
  const data = new Uint16Array(map.width * map.height);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(Math.min(1, Math.max(0, map.data[i])) * 65535);
  return encode({ width: map.width, height: map.height, data, depth: 16, channels: 1 });
}

/** Normalise a raw relative-inverse-depth map to 0..1 (robust percentiles). */
export function normaliseRaw(raw: DepthMap): DepthMap {
  const sorted = Float32Array.from(raw.data).sort();
  const lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  const r = hi - lo || 1;
  const out = new Float32Array(raw.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.max(0, (raw.data[i] - lo) / r));
  return { width: raw.width, height: raw.height, data: out };
}

/** Bilinear resample of a depth map to W × H. */
export function resizeDepth(m: DepthMap, W: number, H: number): DepthMap {
  if (m.width === W && m.height === H) return m;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(m.height - 1, Math.max(0, ((y + 0.5) * m.height) / H - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(m.height - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(m.width - 1, Math.max(0, ((x + 0.5) * m.width) / W - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(m.width - 1, x0 + 1), fx = sx - x0;
      const d = m.data, w = m.width;
      out[y * W + x] = (d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx) * (1 - fy) + (d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx) * fy;
    }
  }
  return { width: W, height: H, data: out };
}

/** The photo with a soft alpha (0..1 map, any resolution) as its transparency. */
export function cutout(photo: RGBAImage, alpha: DepthMap): RGBAImage {
  const a = resizeDepth(alpha, photo.width, photo.height);
  const out: RGBAImage = { width: photo.width, height: photo.height, data: Uint8ClampedArray.from(photo.data) };
  for (let i = 0; i < a.data.length; i++) out.data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, a.data[i])) * 255);
  return out;
}

export type Part = { name: string; bytes: Uint8Array };

export const png = (name: string, img: RGBAImage): Part => ({ name, bytes: encodePNG(img) });
export const depthPng = (name: string, map: DepthMap): Part => ({ name, bytes: encodeDepthPNG(map) });

/** Zero-padded frame file names: frame_01.png … */
export function frameName(prefix: string, i: number, n: number): string {
  return `${prefix}_${String(i + 1).padStart(String(n).length < 2 ? 2 : String(n).length, '0')}.png`;
}
