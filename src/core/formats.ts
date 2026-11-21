/**
 * Module 7 — Composition engine for every stereo output format
 * (side-by-side, half side-by-side, over/under, half over/under, anaglyph).
 */
import { composeSideBySide } from './compose';
import type { StereoFormat } from './layout';
import { renderFrame } from './resample';
import type { AnaglyphMethod, Arrangement } from './settings';
import { createImage, hasTransparency, type Interpolation, type RGBAImage } from './types';

/** Resample to exactly half width (anti-aliased), for half-SBS. */
export function squeezeHorizontal(img: RGBAImage, interpolation: Interpolation): RGBAImage {
  return squeeze(img, img.width / 2, img.height, interpolation);
}

/** Resample to exactly half height (anti-aliased), for half-OU. */
export function squeezeVertical(img: RGBAImage, interpolation: Interpolation): RGBAImage {
  return squeeze(img, img.width, img.height / 2, interpolation);
}

function squeeze(img: RGBAImage, w: number, h: number, interpolation: Interpolation): RGBAImage {
  return renderFrame({
    source: img,
    sourceHasAlpha: hasTransparency(img),
    mapping: { sx: w / img.width, sy: h / img.height, offX: 0, offY: 0 },
    frameW: w,
    frameH: h,
    marginX: 0,
    marginY: 0,
    interpolation,
    background: { kind: 'color', rgba: [0, 0, 0, 0] },
  });
}

/** Stack two equal views vertically (first on top). */
export function composeOverUnder(top: RGBAImage, bottom: RGBAImage): RGBAImage {
  if (top.width !== bottom.width || top.height !== bottom.height) throw new Error('Eye views differ in size');
  const out = createImage(top.width, top.height * 2);
  out.data.set(top.data, 0);
  out.data.set(bottom.data, top.data.length);
  return out;
}

// Dubois least-squares red/cyan matrices (rows → output R, G, B).
const DUBOIS_L = [0.456, 0.5, 0.176, -0.04, -0.038, -0.016, -0.015, -0.021, -0.005];
const DUBOIS_R = [-0.043, -0.088, -0.002, 0.378, 0.734, -0.018, -0.072, -0.113, 1.226];

/** Red (left eye) / cyan (right eye) anaglyph. */
export function composeAnaglyph(left: RGBAImage, right: RGBAImage, method: AnaglyphMethod): RGBAImage {
  if (left.width !== right.width || left.height !== right.height) throw new Error('Eye views differ in size');
  const out = createImage(left.width, left.height);
  const L = left.data, R = right.data, o = out.data;
  for (let i = 0; i < o.length; i += 4) {
    const lr = L[i], lg = L[i + 1], lb = L[i + 2];
    const rr = R[i], rg = R[i + 1], rb = R[i + 2];
    if (method === 'dubois') {
      const m = DUBOIS_L, n = DUBOIS_R;
      o[i] = m[0] * lr + m[1] * lg + m[2] * lb + n[0] * rr + n[1] * rg + n[2] * rb;
      o[i + 1] = m[3] * lr + m[4] * lg + m[5] * lb + n[3] * rr + n[4] * rg + n[5] * rb;
      o[i + 2] = m[6] * lr + m[7] * lg + m[8] * lb + n[6] * rr + n[7] * rg + n[8] * rb;
    } else if (method === 'half-color') {
      o[i] = 0.299 * lr + 0.587 * lg + 0.114 * lb;
      o[i + 1] = rg;
      o[i + 2] = rb;
    } else if (method === 'color') {
      o[i] = lr;
      o[i + 1] = rg;
      o[i + 2] = rb;
    } else {
      o[i] = 0.299 * lr + 0.587 * lg + 0.114 * lb;
      o[i + 1] = o[i + 2] = 0.299 * rr + 0.587 * rg + 0.114 * rb;
    }
    o[i + 3] = Math.max(L[i + 3], R[i + 3]);
  }
  return out;
}

/**
 * Package the two eye views. Wiggle and MPO are multi-image exports; for them
 * this returns a side-by-side image used for previews.
 */
export function composeLayout(
  left: RGBAImage,
  right: RGBAImage,
  format: StereoFormat,
  arrangement: Arrangement,
  anaglyphMethod: AnaglyphMethod,
  interpolation: Interpolation,
): RGBAImage {
  const [a, b] = arrangement === 'parallel' ? [left, right] : [right, left];
  switch (format) {
    case 'half-sbs':
      return composeSideBySide(squeezeHorizontal(a, interpolation), squeezeHorizontal(b, interpolation));
    case 'ou':
      return composeOverUnder(a, b);
    case 'half-ou':
      return composeOverUnder(squeezeVertical(a, interpolation), squeezeVertical(b, interpolation));
    case 'anaglyph':
      return composeAnaglyph(left, right, anaglyphMethod);
    default:
      return composeSideBySide(a, b);
  }
}
