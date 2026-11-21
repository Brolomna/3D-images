/** Deterministic synthetic test images covering the required categories. */
import { createImage, type RGBAImage } from '../src/core/types';

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Photo-like: smooth gradients + mild deterministic noise + a bright subject. */
export function photo(w: number, h: number, seed = 1, brightness = 1): RGBAImage {
  const img = createImage(w, h);
  const rnd = prng(seed);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const cx = x / w - 0.5, cy = y / h - 0.4;
      const subject = Math.exp(-(cx * cx + cy * cy) * 18);
      const n = (rnd() - 0.5) * 20;
      img.data[o] = (40 + 180 * (x / w) + 60 * subject + n) * brightness;
      img.data[o + 1] = (60 + 120 * (y / h) + 90 * subject + n) * brightness;
      img.data[o + 2] = (150 - 100 * (y / h) + 40 * subject + n) * brightness;
      img.data[o + 3] = 255;
    }
  }
  return img;
}

/** Flat-colour illustration with hard edges. */
export function illustration(w: number, h: number): RGBAImage {
  const img = createImage(w, h);
  const palette = [[230, 57, 70], [241, 250, 238], [168, 218, 220], [69, 123, 157], [29, 53, 87]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const c = palette[(Math.floor(x / 37) + Math.floor(y / 53)) % palette.length];
    img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
  }
  return img;
}

/** Text / logo-like: black glyph strokes on white. */
export function textImage(w: number, h: number): RGBAImage {
  const img = createImage(w, h);
  img.data.fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = x % 24, gy = y % 32;
    const stroke = (gx >= 4 && gx < 7 && gy >= 4 && gy < 26) || (gy >= 4 && gy < 7 && gx >= 4 && gx < 18) || (gy >= 14 && gy < 17 && gx >= 4 && gx < 15);
    if (stroke) {
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 0;
    }
  }
  return img;
}

/** PNG with an alpha channel (soft disc on transparency). */
export function transparentImage(w: number, h: number): RGBAImage {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const d = Math.hypot(x - w / 2, y - h / 2) / (Math.min(w, h) / 2);
    img.data[o] = 200; img.data[o + 1] = 80; img.data[o + 2] = 30;
    img.data[o + 3] = Math.max(0, Math.min(255, (1 - d) * 400));
  }
  return img;
}

export function solid(w: number, h: number, rgba: [number, number, number, number]): RGBAImage {
  const img = createImage(w, h);
  for (let i = 0; i < img.data.length; i += 4) img.data.set(rgba, i);
  return img;
}

export function px(img: RGBAImage, x: number, y: number): number[] {
  const o = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(o, o + 4));
}
