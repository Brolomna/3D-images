/** Shared settings model (UI ⇄ workers) and the primary default configuration. */
import type { BackgroundSpec } from './background';
import type { LayoutSpec, OutputSizeSpec, StereoFormat } from './layout';
import type { MotionSettings } from './motion';
import type { Interpolation } from './types';

export type ShiftDirection = 1 | -1;
export type ShiftedEye = 'right' | 'left';
/** extend = pull in surrounding image (then edge pixels); crop = zoom both views to hide edges. */
export type EdgeMode = 'extend' | 'crop';
/** parallel = left-eye image first (L|R, L over R); cross = swapped (R|L) for cross-eyed viewing. */
export type Arrangement = 'parallel' | 'cross';
export type ImageFileFormat = 'png' | 'jpeg' | 'webp';
export type AnaglyphMethod = 'dubois' | 'half-color' | 'color' | 'gray';
export type WiggleFile = 'gif' | 'video';

export interface DepthSettings {
  /** Use the automatically estimated depth map for per-pixel disparity. */
  enabled: boolean;
  /** Extra disparity between nearest and farthest point, in output pixels. */
  strength: number;
  /** Depth (0 = far … 1 = near) that receives no extra disparity. */
  focus: number;
  /** Depth-map smoothing radius, % of the image width. Reduces warping artefacts. */
  smoothing: number;
  /** Swap near and far. */
  invert: boolean;
}

export interface StereoSettings {
  output: OutputSizeSpec;
  layout: LayoutSpec;
  background: BackgroundSpec;
  /** Used to resize the photo into the eye frame. Lanczos for best quality. */
  resizeInterpolation: Interpolation;
  /** Used for fractional (sub-pixel) displacement. */
  shiftInterpolation: Interpolation;
  /** Uniform horizontal displacement in OUTPUT pixels. */
  horizontalOffset: number;
  /** Vertical displacement in OUTPUT pixels (positive = down). */
  verticalOffset: number;
  verticalEnabled: boolean;
  /** +1 = displaced view moves right, −1 = moves left. */
  direction: ShiftDirection;
  shiftedEye: ShiftedEye;
  edgeMode: EdgeMode;
  /** Mask the thin edge strips that only one eye can see (stereo window). */
  edgeMask: boolean;
  arrangement: Arrangement;
  depth: DepthSettings;
  /** How the two views are packaged on export (and in the Output preview). */
  format: StereoFormat;
  anaglyphMethod: AnaglyphMethod;
  wiggleFile: WiggleFile;
  /** Frames per wiggle cycle: 2 = classic L/R flip, more = smooth sweep. */
  wiggleFrames: number;
  /** Milliseconds per frame. */
  wiggleFrameMs: number;
  /** "3D photo" camera-motion animation. */
  motion: MotionSettings;
  /** File type for still formats (sbs, half-sbs, ou, half-ou, anaglyph). */
  exportFormat: ImageFileFormat;
  /** 0..1 quality for JPEG / WEBP / MPO. */
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
  verticalOffset: 0,
  verticalEnabled: true,
  direction: 1,
  shiftedEye: 'right',
  edgeMode: 'extend',
  edgeMask: false,
  arrangement: 'parallel',
  depth: { enabled: true, strength: 16, focus: 0.5, smoothing: 0.6, invert: false },
  format: 'sbs',
  anaglyphMethod: 'dubois',
  wiggleFile: 'gif',
  wiggleFrames: 2,
  wiggleFrameMs: 140,
  motion: { path: 'circle', amplitude: 20, durationMs: 3000, file: 'video' },
  exportFormat: 'png',
  exportQuality: 0.95,
};

export function cloneSettings(s: StereoSettings): StereoSettings {
  return JSON.parse(JSON.stringify(s)) as StereoSettings;
}

/** Signed uniform displacement (in output pixels) applied to the displaced eye. */
export function effectiveOffsets(s: StereoSettings): { dx: number; dy: number } {
  const dx = s.direction * (Number.isFinite(s.horizontalOffset) ? s.horizontalOffset : 0);
  const dy = s.verticalEnabled && Number.isFinite(s.verticalOffset) ? s.verticalOffset : 0;
  return { dx: dx === 0 ? 0 : dx, dy: dy === 0 ? 0 : dy };
}
