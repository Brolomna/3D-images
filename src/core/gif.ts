/**
 * Wiggle-GIF encoder. All frames share one global 256-colour palette built
 * from every frame, so colours do not flicker between frames. Deterministic.
 */
import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import type { RGBAImage } from './types';

export function encodeGif(frames: RGBAImage[], frameMs: number): Uint8Array {
  if (!frames.length) throw new Error('No frames');
  const { width, height } = frames[0];
  // Sample pixels from all frames for the palette (bounded for speed).
  const maxSample = 2_000_000;
  const per = Math.floor(maxSample / frames.length);
  const sample = new Uint8ClampedArray(Math.min(per, width * height) * frames.length * 4);
  let o = 0;
  for (const f of frames) {
    const n = width * height;
    const step = Math.max(1, Math.ceil(n / per));
    for (let i = 0, k = 0; i < n && k < per; i += step, k++, o += 4) {
      const p = i * 4;
      sample[o] = f.data[p]; sample[o + 1] = f.data[p + 1]; sample[o + 2] = f.data[p + 2]; sample[o + 3] = 255;
    }
  }
  const palette = quantize(sample.subarray(0, o), 256, { format: 'rgb565' });
  const gif = GIFEncoder();
  frames.forEach((f, i) => {
    if (f.width !== width || f.height !== height) throw new Error('Frame size mismatch');
    const index = applyPalette(f.data, palette, 'rgb565');
    gif.writeFrame(index, width, height, i === 0 ? { palette, delay: frameMs, repeat: 0 } : { delay: frameMs });
  });
  gif.finish();
  return gif.bytes();
}
