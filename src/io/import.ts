/**
 * Module 1 — Image Import.
 *
 * Decodes JPEG / PNG / WEBP natively (honouring EXIF orientation and
 * converting embedded colour profiles to sRGB) and TIFF via UTIF. Pixels are
 * kept at the original resolution; nothing is recompressed.
 */
import UTIF from 'utif';
import type { RGBAImage } from '../core/types';

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff'];
export const ACCEPT_ATTR = '.jpg,.jpeg,.png,.webp,.tif,.tiff,image/jpeg,image/png,image/webp,image/tiff';
const MAX_PIXELS = 120_000_000;

export interface ImportedImage {
  name: string;
  image: RGBAImage;
  /** Display copy for the "original" panel. */
  bitmap: ImageBitmap;
  format: string;
  fileSize: number;
}

export function detectFormat(file: File): 'jpeg' | 'png' | 'webp' | 'tiff' | null {
  const t = file.type.toLowerCase();
  const n = file.name.toLowerCase();
  if (t === 'image/jpeg' || /\.jpe?g$/.test(n)) return 'jpeg';
  if (t === 'image/png' || n.endsWith('.png')) return 'png';
  if (t === 'image/webp' || n.endsWith('.webp')) return 'webp';
  if (t === 'image/tiff' || /\.tiff?$/.test(n)) return 'tiff';
  return null;
}

export async function importFile(file: File): Promise<ImportedImage> {
  const format = detectFormat(file);
  if (!format) throw new Error(`Unsupported file type: ${file.name || file.type}. Use JPEG, PNG, WEBP or TIFF.`);
  const image = format === 'tiff' ? await decodeTiff(file) : await decodeNative(file);
  if (image.width * image.height > MAX_PIXELS) {
    throw new Error(`Image is too large (${image.width}×${image.height}). Maximum is ${MAX_PIXELS / 1e6} megapixels.`);
  }
  const bitmap = await createImageBitmap(new ImageData(image.data.slice(), image.width, image.height));
  return { name: file.name.replace(/\.[^.]+$/, '') || 'image', image, bitmap, format, fileSize: file.size };
}

async function decodeNative(file: Blob): Promise<RGBAImage> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'default', imageOrientation: 'from-image' });
  } catch {
    throw new Error('This image could not be decoded by your browser.');
  }
  return bitmapToRGBA(bmp);
}

export function bitmapToRGBA(bmp: ImageBitmap | HTMLCanvasElement): RGBAImage {
  const w = bmp.width;
  const h = bmp.height;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = (canvas as OffscreenCanvas).getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' }) as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Canvas 2D is not available');
  ctx.drawImage(bmp as CanvasImageSource, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  if ('close' in bmp) bmp.close();
  return { width: w, height: h, data };
}

async function decodeTiff(file: Blob): Promise<RGBAImage> {
  const buf = await file.arrayBuffer();
  const ifds = UTIF.decode(buf);
  if (!ifds.length) throw new Error('No images found in TIFF file.');
  // Use the largest page (some TIFFs carry thumbnails first).
  let best = ifds[0];
  for (const ifd of ifds) {
    UTIF.decodeImage(buf, ifd, ifds);
    if (ifd.width * ifd.height > best.width * best.height) best = ifd;
  }
  if (!best.width || !best.height) throw new Error('Unsupported TIFF encoding.');
  const rgba = UTIF.toRGBA8(best);
  return { width: best.width, height: best.height, data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, best.width * best.height * 4) };
}

/** A built-in sample scene so the app can be tried without uploading. */
export async function createSampleImage(): Promise<ImportedImage> {
  const w = 1600, h = 2400;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#0b1d3a'); sky.addColorStop(0.45, '#3d5a8a'); sky.addColorStop(0.7, '#e7a873'); sky.addColorStop(1, '#2a1c2c');
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  g.fillStyle = '#ffe8b0'; g.beginPath(); g.arc(w * 0.68, h * 0.42, 150, 0, Math.PI * 2); g.fill();
  const ridge = (y: number, amp: number, color: string, seed: number) => {
    g.fillStyle = color; g.beginPath(); g.moveTo(0, h);
    for (let x = 0; x <= w; x += 8) g.lineTo(x, y + Math.sin(x / 140 + seed) * amp + Math.sin(x / 47 + seed * 2) * amp * 0.3);
    g.lineTo(w, h); g.fill();
  };
  ridge(h * 0.55, 90, '#3b3550', 1); ridge(h * 0.63, 70, '#2a2438', 2.5); ridge(h * 0.72, 55, '#1a1624', 4);
  g.fillStyle = '#0d0b12';
  for (let i = 0; i < 9; i++) {
    const x = 120 + i * 170, base = h * 0.86 + (i % 3) * 30, th = 260 + (i * 53) % 140;
    g.beginPath(); g.moveTo(x, base - th); g.lineTo(x - 70, base); g.lineTo(x + 70, base); g.fill();
  }
  g.fillStyle = '#f5f1e8'; g.font = 'bold 120px system-ui, sans-serif'; g.textAlign = 'center';
  g.fillText('STEREO', w / 2, h * 0.2);
  g.font = '48px system-ui, sans-serif'; g.fillText('sample photograph', w / 2, h * 0.2 + 80);
  const image = bitmapToRGBA(c);
  const bitmap = await createImageBitmap(c);
  return { name: 'sample', image, bitmap, format: 'png', fileSize: 0 };
}
