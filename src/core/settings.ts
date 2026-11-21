/** Shared settings model (UI ⇄ worker) and the primary default configuration. */
import type { BackgroundSpec } from './background';
import type { LayoutSpec, OutputSizeSpec } from './layout';
import type { Interpolation } from './types';

export type ShiftDirection = 1 | -1;
export type ShiftedEye = 'right' | 'left';
/** extend = pull in surrounding image (then edge pixels); crop = zoom both views to hide edges. */
export type EdgeMode = 'extend' | 'crop';
/** parallel = left-eye image on the left (L|R); cross = swapped (R|L) for cross-eyed viewing. */
export type Arrangement = 'parallel' | 'cross';
export type ExportFormat = 'png' | 'jpeg' | 'webp';

export interface StereoSettings {
  output: OutputSizeSpec;
  layout: LayoutSpec;
  background: BackgroundSpec;
  /** Used to resize the photo into the eye frame. Lanczos for best quality. */
  resizeInterpolation: Interpolation;
  /** Used for fractional (sub-pixel) displacement. */
  shiftInterpolation: Interpolation;
  /** Horizontal displacement magnitude in OUTPUT pixels. */
  horizontalOffset: number;
  /** Vertical displacement in OUTPUT pixels (positive = down). */
  verticalOffset: number;
  verticalEnabled: boolean;
  /** +1 = displaced view moves right, −1 = moves left. */
  direction: ShiftDirection;
  shiftedEye: ShiftedEye;
  edgeMode: EdgeMode;
  arrangement: Arrangement;
  exportFormat: ExportFormat;
  /** 0..1 quality for JPEG / WEBP. */
  exportQuality: number;
}

export const DEFAULT_SETTINGS: StereoSettings = {
  output: {
    aspect: '9:16',
    resolution: '1080p',
    aspectTarget: 'output',
    customWidth: 1080,
    customHeight: 1920,
    customAspectW: 9,
    customAspectH: 16,
  },
  layout: { fit: 'fill', scale: 1, posX: 0.5, posY: 0.5, crop: { x: 0, y: 0, w: 1, h: 1 } },
  background: { kind: 'blur', radius: 48 },
  resizeInterpolation: 'lanczos',
  shiftInterpolation: 'bicubic',
  horizontalOffset: 14,
  verticalOffset: 0.6,
  verticalEnabled: true,
  direction: 1,
  shiftedEye: 'right',
  edgeMode: 'extend',
  arrangement: 'parallel',
  exportFormat: 'png',
  exportQuality: 0.95,
};

export function cloneSettings(s: StereoSettings): StereoSettings {
  return JSON.parse(JSON.stringify(s)) as StereoSettings;
}

/** Signed displacement (in output pixels) applied to the displaced eye. */
export function effectiveOffsets(s: StereoSettings): { dx: number; dy: number } {
  const dx = s.direction * (Number.isFinite(s.horizontalOffset) ? s.horizontalOffset : 0);
  const dy = s.verticalEnabled && Number.isFinite(s.verticalOffset) ? s.verticalOffset : 0;
  return { dx: dx === 0 ? 0 : dx, dy: dy === 0 ? 0 : dy };
}
