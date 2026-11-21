/** Module 7 — Side-by-Side Composition Engine. */
import { createImage, type RGBAImage } from './types';

/**
 * Place two equal-sized views next to each other. `parallel` puts the
 * left-eye view on the left (L|R); `cross` swaps them (R|L).
 */
export function composeSideBySide(
  left: RGBAImage,
  right: RGBAImage,
  arrangement: 'parallel' | 'cross' = 'parallel',
): RGBAImage {
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error(`Eye views differ in size: ${left.width}×${left.height} vs ${right.width}×${right.height}`);
  }
  const [a, b] = arrangement === 'parallel' ? [left, right] : [right, left];
  const w = left.width;
  const h = left.height;
  const out = createImage(w * 2, h);
  const rowBytes = w * 4;
  for (let y = 0; y < h; y++) {
    const o = y * rowBytes * 2;
    out.data.set(a.data.subarray(y * rowBytes, (y + 1) * rowBytes), o);
    out.data.set(b.data.subarray(y * rowBytes, (y + 1) * rowBytes), o + rowBytes);
  }
  return out;
}
