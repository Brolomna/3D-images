/**
 * Lossless, deterministic PNG encoding (pure JS) — the default export format.
 * Opaque images are written as RGB to keep files smaller; transparency is
 * preserved exactly otherwise.
 */
import { encode } from 'fast-png';
import { hasTransparency, type RGBAImage } from './types';

export function encodePNG(img: RGBAImage): Uint8Array {
  if (hasTransparency(img)) {
    return encode({ width: img.width, height: img.height, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength), depth: 8, channels: 4 });
  }
  const rgb = new Uint8Array(img.width * img.height * 3);
  const d = img.data;
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2];
  }
  return encode({ width: img.width, height: img.height, data: rgb, depth: 8, channels: 3 });
}
