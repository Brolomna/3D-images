/**
 * Modules 3 & 4 — Left and Right View Generators.
 *
 * Both views are taken from ONE shared base frame (the photo resized once at
 * output resolution, with overscan margins). The reference eye is a straight
 * crop of that frame; the displaced eye is the same frame moved by the
 * horizontal (uniform or depth-based) and vertical displacement processors.
 * The two views therefore always have identical dimensions and scaling.
 */
import { warpHorizontal, disparityAt, type DepthMap } from './depth';
import { displaceHorizontal, displaceVertical } from './displace';
import { cropImage, type Interpolation, type RGBAImage } from './types';

export interface BaseFrame {
  image: RGBAImage; // (eyeW + 2·marginX) × (eyeH + 2·marginY)
  eyeW: number;
  eyeH: number;
  marginX: number;
  marginY: number;
  hasAlpha: boolean;
}

export interface DepthParams {
  /** Aligned depth frame, same size as base.image. */
  frame: DepthMap;
  strength: number;
  focus: number;
  /** −1 when the right eye is displaced, +1 for the left eye. */
  eyeSign: number;
}

export interface ViewParams {
  dx: number;
  dy: number;
  interpolation: Interpolation;
  depth?: DepthParams | null;
  /** Fraction of the full disparity (used for smooth wiggle frames). */
  t?: number;
}

/** Reference (undisplaced) view: exact copy of the frame region. */
export function generateReferenceView(base: BaseFrame): RGBAImage {
  return cropImage(base.image, base.marginX, base.marginY, base.eyeW, base.eyeH);
}

function usesDepth(p: ViewParams): p is ViewParams & { depth: DepthParams } {
  return !!p.depth && p.depth.strength !== 0;
}

/** Displaced view: the same frame translated / warped by the disparity. */
export function generateDisplacedView(base: BaseFrame, p: ViewParams): RGBAImage {
  const t = p.t ?? 1;
  const dx = p.dx * t;
  const dy = p.dy * t;
  if (usesDepth(p) && t !== 0) {
    const h = warpHorizontal(base.image, p.depth.frame, base.marginX, base.eyeW, {
      uniform: dx, strength: p.depth.strength * t, focus: p.depth.focus, eyeSign: p.depth.eyeSign,
    }, p.interpolation, base.hasAlpha);
    return displaceVertical(h, dy, base.marginY, base.eyeH, p.interpolation, base.hasAlpha);
  }
  if (dx === 0 && dy === 0) return generateReferenceView(base);
  const h = displaceHorizontal(base.image, dx, base.marginX, base.eyeW, p.interpolation, base.hasAlpha);
  return displaceVertical(h, dy, base.marginY, base.eyeH, p.interpolation, base.hasAlpha);
}

export interface EyeViews {
  left: RGBAImage;
  right: RGBAImage;
}

/** Disparity range along the left and right frame edges. */
export function edgeDisparity(base: BaseFrame, p: ViewParams) {
  const t = p.t ?? 1;
  if (!usesDepth(p)) {
    const d = p.dx * t;
    return { leftMin: d, leftMax: d, rightMin: d, rightMax: d };
  }
  const f = p.depth.frame;
  const params = { uniform: p.dx * t, strength: p.depth.strength * t, focus: p.depth.focus, eyeSign: p.depth.eyeSign };
  let leftMin = Infinity, leftMax = -Infinity, rightMin = Infinity, rightMax = -Infinity;
  const xl = base.marginX, xr = base.marginX + base.eyeW - 1;
  for (let y = base.marginY; y < base.marginY + base.eyeH; y++) {
    const dl = disparityAt(f.data[y * f.width + xl], params);
    const dr = disparityAt(f.data[y * f.width + xr], params);
    leftMin = Math.min(leftMin, dl); leftMax = Math.max(leftMax, dl);
    rightMin = Math.min(rightMin, dr); rightMax = Math.max(rightMax, dr);
  }
  return { leftMin, leftMax, rightMin, rightMax };
}

function fillColumns(img: RGBAImage, x0: number, x1: number) {
  x0 = Math.max(0, x0);
  x1 = Math.min(img.width, x1);
  if (x1 <= x0) return;
  for (let y = 0; y < img.height; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * img.width + x) * 4;
      img.data[o] = 0; img.data[o + 1] = 0; img.data[o + 2] = 0; img.data[o + 3] = 255;
    }
  }
}

/**
 * Stereo-window mask: blank the edge strips that only one eye can see, so the
 * picture border does not flicker or conflict with depth.
 */
export function applyEdgeMask(reference: RGBAImage, displaced: RGBAImage, e: ReturnType<typeof edgeDisparity>): void {
  const W = reference.width;
  // Content moved right (D > 0): displaced view's left strip and the
  // reference view's right strip are seen by one eye only.
  fillColumns(displaced, 0, Math.ceil(Math.max(0, e.leftMax)));
  fillColumns(reference, W - Math.ceil(Math.max(0, e.rightMax)), W);
  // Content moved left (D < 0): the mirror-image strips.
  fillColumns(displaced, W - Math.ceil(Math.max(0, -e.rightMin)), W);
  fillColumns(reference, 0, Math.ceil(Math.max(0, -e.leftMin)));
}

export function generateViews(
  base: BaseFrame,
  p: ViewParams,
  shiftedEye: 'left' | 'right',
  edgeMask = false,
): EyeViews {
  const reference = generateReferenceView(base);
  const displaced = generateDisplacedView(base, p);
  if (edgeMask) applyEdgeMask(reference, displaced === reference ? reference : displaced, edgeDisparity(base, p));
  return shiftedEye === 'right'
    ? { left: reference, right: displaced }
    : { left: displaced, right: reference };
}
