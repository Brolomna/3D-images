/**
 * Backgrounds for the "fit without cropping" mode. Instead of black bars the
 * default is a soft, blurred, cover-scaled copy of the same photograph.
 */
import { computeMapping, type Mapping } from './layout';
import { renderFrame, type Background } from './resample';
import { createImage, type RGBAImage } from './types';

export type BackgroundSpec =
  | { kind: 'blur'; radius: number }
  | { kind: 'color'; color: string }
  | { kind: 'transparent' };

export function parseHexColor(hex: string): [number, number, number, number] {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return [0, 0, 0, 255];
  const v = parseInt(m[1], 16);
  const a = m[2] ? parseInt(m[2], 16) : 255;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, a];
}

/** Separable box blur, repeated 3× (≈ Gaussian). Edge-clamped, deterministic. */
export function boxBlur(img: RGBAImage, radius: number, passes = 3): RGBAImage {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return { width: img.width, height: img.height, data: img.data.slice() };
  const { width: w, height: h } = img;
  let a = new Float32Array(img.data);
  let b = new Float32Array(a.length);
  const norm = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += a[row + Math.min(w - 1, Math.max(0, k)) * 4 + c];
        for (let x = 0; x < w; x++) {
          b[row + x * 4 + c] = acc * norm;
          const add = Math.min(w - 1, x + r + 1);
          const sub = Math.max(0, x - r);
          acc += a[row + add * 4 + c] - a[row + sub * 4 + c];
        }
      }
    }
    // vertical
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += b[Math.min(h - 1, Math.max(0, k)) * w * 4 + x * 4 + c];
        for (let y = 0; y < h; y++) {
          a[y * w * 4 + x * 4 + c] = acc * norm;
          const add = Math.min(h - 1, y + r + 1);
          const sub = Math.max(0, y - r);
          acc += b[add * w * 4 + x * 4 + c] - b[sub * w * 4 + x * 4 + c];
        }
      }
    }
  }
  const out = createImage(w, h);
  out.data.set(a);
  return out;
}

/**
 * Build the resampler background for a frame of (frameW+2mx)×(frameH+2my).
 */
export function buildBackground(
  spec: BackgroundSpec,
  source: RGBAImage,
  sourceHasAlpha: boolean,
  frameW: number,
  frameH: number,
  marginX: number,
  marginY: number,
): Background {
  if (spec.kind === 'transparent') return { kind: 'color', rgba: [0, 0, 0, 0] };
  if (spec.kind === 'color') return { kind: 'color', rgba: parseHexColor(spec.color) };

  // Blur: render a small cover-scaled frame, blur it, then upscale smoothly.
  const factor = 8;
  const smallW = Math.max(2, Math.ceil(frameW / factor));
  const smallH = Math.max(2, Math.ceil(frameH / factor));
  const cover = computeMapping(source.width, source.height, smallW, smallH, {
    fit: 'fill', scale: 1, posX: 0.5, posY: 0.5, crop: { x: 0, y: 0, w: 1, h: 1 },
  });
  const small = renderFrame({
    source, sourceHasAlpha, mapping: cover, frameW: smallW, frameH: smallH,
    marginX: 0, marginY: 0, interpolation: 'bilinear',
    background: { kind: 'color', rgba: [0, 0, 0, 255] },
  });
  const blurred = boxBlur(small, Math.max(1, (spec.radius || 48) / factor));
  // Opaque background: force alpha to 255.
  for (let i = 3; i < blurred.data.length; i += 4) blurred.data[i] = 255;
  const up: Mapping = { sx: frameW / smallW, sy: frameH / smallH, offX: 0, offY: 0 };
  const image = renderFrame({
    source: blurred, sourceHasAlpha: false, mapping: up, frameW, frameH,
    marginX, marginY, interpolation: 'bilinear',
    background: { kind: 'color', rgba: [0, 0, 0, 255] },
  });
  return { kind: 'image', image };
}
