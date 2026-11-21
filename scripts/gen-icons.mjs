// Generates the PWA icons (two eye panels, red/cyan) into public/icons.
import { encode } from 'fast-png';
import { writeFileSync } from 'node:fs';

function icon(size, maskable) {
  const d = new Uint8Array(size * size * 4);
  const pad = maskable ? size * 0.2 : size * 0.1;
  const r = size * 0.18;
  const inside = (x, y, x0, y0, x1, y1, rr) => {
    const cx = Math.min(Math.max(x, x0 + rr), x1 - rr), cy = Math.min(Math.max(y, y0 + rr), y1 - rr);
    return (x - cx) ** 2 + (y - cy) ** 2 <= rr * rr;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4;
    const px = x + 0.5, py = y + 0.5;
    let c = null;
    if (maskable || inside(px, py, 0, 0, size, size, r)) c = [14, 15, 18, 255];
    const w = (size - 2 * pad), gap = w * 0.08, pw = (w - gap) / 2, top = pad + w * 0.12, bot = size - pad - w * 0.12, pr = w * 0.05;
    if (inside(px, py, pad, top, pad + pw, bot, pr)) c = [255, 93, 93, 255];
    if (inside(px, py, pad + pw + gap, top, size - pad, bot, pr)) c = [64, 208, 255, 255];
    if (c) d.set(c, o);
  }
  return encode({ width: size, height: size, data: d, channels: 4, depth: 8 });
}
writeFileSync('public/icons/icon-192.png', icon(192, false));
writeFileSync('public/icons/icon-512.png', icon(512, false));
writeFileSync('public/icons/icon-maskable-512.png', icon(512, true));
console.log('icons written');
