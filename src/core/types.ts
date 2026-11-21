/**
 * Core image types. Everything in `src/core` is pure TypeScript with no DOM
 * dependency, so the exact same code runs in the Web Worker, on the main
 * thread and in the Node test-suite. All processing is deterministic.
 */

/** Straight (non-premultiplied) 8-bit RGBA raster, row-major, 4 bytes per pixel. */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type Interpolation = 'nearest' | 'bilinear' | 'bicubic' | 'lanczos';

export function createImage(width: number, height: number): RGBAImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid image size ${width}×${height}`);
  }
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** True when any pixel is not fully opaque. */
export function hasTransparency(img: RGBAImage): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

/** Copy a rectangular region (must lie fully inside the source). */
export function cropImage(src: RGBAImage, x: number, y: number, w: number, h: number): RGBAImage {
  if (x < 0 || y < 0 || x + w > src.width || y + h > src.height) {
    throw new Error('cropImage: region outside source');
  }
  const out = createImage(w, h);
  const rowBytes = w * 4;
  for (let r = 0; r < h; r++) {
    const s = ((y + r) * src.width + x) * 4;
    out.data.set(src.data.subarray(s, s + rowBytes), r * rowBytes);
  }
  return out;
}

export function imagesEqual(a: RGBAImage, b: RGBAImage): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const da = a.data, db = b.data;
  for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) return false;
  return true;
}
