/**
 * Modules 3 & 4 — Left and Right View Generators.
 *
 * Both views are taken from ONE shared base frame (the photo resized once at
 * output resolution, with overscan margins). The reference eye is a straight
 * crop of that frame; the displaced eye goes through the horizontal and then
 * the vertical displacement processor. The two views therefore always have
 * identical dimensions and scaling — they are never resized independently.
 */
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

/** Reference (undisplaced) view: exact copy of the frame region. */
export function generateReferenceView(base: BaseFrame): RGBAImage {
  return cropImage(base.image, base.marginX, base.marginY, base.eyeW, base.eyeH);
}

/** Displaced view: the same frame translated by (dx, dy) output pixels. */
export function generateDisplacedView(
  base: BaseFrame,
  dx: number,
  dy: number,
  interpolation: Interpolation,
): RGBAImage {
  if (dx === 0 && dy === 0) return generateReferenceView(base);
  const h = displaceHorizontal(base.image, dx, base.marginX, base.eyeW, interpolation, base.hasAlpha);
  return displaceVertical(h, dy, base.marginY, base.eyeH, interpolation, base.hasAlpha);
}

export interface EyeViews {
  left: RGBAImage;
  right: RGBAImage;
}

export function generateViews(
  base: BaseFrame,
  dx: number,
  dy: number,
  shiftedEye: 'left' | 'right',
  interpolation: Interpolation,
): EyeViews {
  const reference = generateReferenceView(base);
  const displaced = generateDisplacedView(base, dx, dy, interpolation);
  return shiftedEye === 'right'
    ? { left: reference, right: displaced }
    : { left: displaced, right: reference };
}
