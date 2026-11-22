/**
 * GIF encoder for wiggle and motion animations. All frames share one global
 * 256-colour palette (built from sample frames) so colours do not flicker.
 * Frames are encoded one at a time, so long animations need little memory.
 * Deterministic.
 */
import { applyPalette, GIFEncoder, quantize, type Palette } from 'gifenc';
import type { RGBAImage } from './types';

/** Build a shared palette from a few representative frames. */
export function buildPalette(frames: RGBAImage[]): Palette {
  const maxSample = 2_000_000;
  const per = Math.max(1, Math.floor(maxSample / frames.length));
  const parts: Uint8ClampedArray[] = [];
  for (const f of frames) {
    const n = f.width * f.height;
    const step = Math.max(1, Math.ceil(n / per));
    const part = new Uint8ClampedArray(Math.ceil(n / step) * 4);
    let o = 0;
    for (let i = 0; i < n; i += step, o += 4) {
      const p = i * 4;
      part[o] = f.data[p]; part[o + 1] = f.data[p + 1]; part[o + 2] = f.data[p + 2]; part[o + 3] = 255;
    }
    parts.push(part.subarray(0, o));
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const sample = new Uint8ClampedArray(total);
  let o = 0;
  for (const p of parts) { sample.set(p, o); o += p.length; }
  return quantize(sample, 256, { format: 'rgb565' });
}

/** Encode `count` frames produced on demand by `getFrame`. */
export function encodeGifStream(
  count: number,
  getFrame: (i: number) => RGBAImage,
  frameMs: number,
  palette: Palette,
  onProgress?: (i: number) => void,
): Uint8Array {
  const gif = GIFEncoder();
  let w = 0, h = 0;
  for (let i = 0; i < count; i++) {
    const f = getFrame(i);
    if (i === 0) { w = f.width; h = f.height; }
    if (f.width !== w || f.height !== h) throw new Error('Frame size mismatch');
    const index = applyPalette(f.data, palette, 'rgb565');
    gif.writeFrame(index, w, h, i === 0 ? { palette, delay: frameMs, repeat: 0 } : { delay: frameMs });
    onProgress?.(i);
  }
  gif.finish();
  return gif.bytes();
}

export function encodeGif(frames: RGBAImage[], frameMs: number): Uint8Array {
  if (!frames.length) throw new Error('No frames');
  return encodeGifStream(frames.length, (i) => frames[i], frameMs, buildPalette(frames));
}
