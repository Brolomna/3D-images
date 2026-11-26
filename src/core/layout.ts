/**
 * Module 2 — Image Resizing and Cropping (geometry only).
 *
 * Computes output dimensions from aspect-ratio / resolution presets and the
 * affine, axis-aligned mapping from source pixels into one eye frame.
 */

export type AspectPreset = '9:16' | '1:1' | '16:9' | '4:3' | 'custom';
export type ResolutionPreset = '720p' | '1080p' | '1440p' | '4k' | '8k' | 'custom';
export type FitMode = 'fill' | 'fit' | 'stretch' | 'manual';
/** Whether the aspect ratio describes the full side-by-side output or each eye. */
export type AspectTarget = 'output' | 'eye';

export const ASPECT_RATIOS: Record<Exclude<AspectPreset, 'custom'>, [number, number]> = {
  '9:16': [9, 16],
  '1:1': [1, 1],
  '16:9': [16, 9],
  '4:3': [4, 3],
};

/** Short-side pixel count of each resolution preset. */
export const RESOLUTION_SHORT_SIDE: Record<Exclude<ResolutionPreset, 'custom'>, number> = {
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
  '4k': 2160,
  '8k': 4320,
};

export const MAX_OUTPUT_SIDE = 16384;

export interface OutputSizeSpec {
  aspect: AspectPreset;
  resolution: ResolutionPreset;
  aspectTarget: AspectTarget;
  customWidth: number;
  customHeight: number;
  /** Custom aspect ratio terms, used when aspect === 'custom' and resolution !== 'custom'. */
  customAspectW: number;
  customAspectH: number;
}

/**
 * How the two eye views are packaged.
 *  sbs      – full side-by-side (each eye W/2 × H)
 *  half-sbs – each eye rendered W × H, squeezed to W/2 × H (3D TVs, VR players)
 *  ou       – over/under (each eye W × H/2)
 *  half-ou  – each eye rendered W × H, squeezed to W × H/2
 *  anaglyph – single red/cyan image W × H
 *  wiggle   – animation alternating the eyes, W × H frames (GIF / video)
 *  mpo      – multi-picture JPEG with two W × H views (3D cameras / displays)
 *  motion   – "3D photo": depth-driven camera-motion animation, W × H frames
 *  stereogram – single-image autostereogram ("Magic Eye"), W × H
 *  card     – Layered 3D card: the uploaded card split into frame / character /
 *             background layers with a live tilt preview (not rendered here)
 */
export type StereoFormat = 'sbs' | 'half-sbs' | 'ou' | 'half-ou' | 'anaglyph' | 'wiggle' | 'mpo' | 'motion' | 'stereogram' | 'card';

export interface OutputSize {
  /** Final output file size (for wiggle / mpo: size of each frame / image). */
  width: number;
  height: number;
  /** Size of each rendered eye view. Offsets are measured in these pixels. */
  eyeWidth: number;
  eyeHeight: number;
}

function evenUp(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r % 2 === 0 ? r : r + 1;
}

/**
 * Resolve the final output size for a stereo format.
 *
 * Examples (SBS): 9:16 @ 1080p → 1080×1920 (eyes 540×1920); 16:9 @ 4K → 3840×2160.
 */
export function resolveOutputSize(spec: OutputSizeSpec, format: StereoFormat = 'sbs'): OutputSize {
  // Tiling factors of the eye views within the output.
  const tileX = format === 'sbs' ? 2 : 1;
  const tileY = format === 'ou' ? 2 : 1;
  let width: number;
  let height: number;
  if (spec.resolution === 'custom') {
    width = Math.round(clampSide(spec.customWidth));
    height = Math.round(clampSide(spec.customHeight));
  } else {
    const [aw, ah] = spec.aspect === 'custom'
      ? [Math.max(0.01, spec.customAspectW), Math.max(0.01, spec.customAspectH)]
      : ASPECT_RATIOS[spec.aspect];
    // Ratio of the full output (eye-target ratios are multiplied by the tiling).
    const rw = spec.aspectTarget === 'eye' ? aw * tileX : aw;
    const rh = spec.aspectTarget === 'eye' ? ah * tileY : ah;
    const short = RESOLUTION_SHORT_SIDE[spec.resolution];
    if (rw <= rh) {
      width = short;
      height = (short * rh) / rw;
    } else {
      height = short;
      width = (short * rw) / rh;
    }
    width = Math.round(Math.min(width, MAX_OUTPUT_SIDE));
    height = Math.round(Math.min(height, MAX_OUTPUT_SIDE));
  }
  width = Math.max(1, width);
  height = Math.max(1, height);
  // Even dimensions where the format splits or squeezes an axis by two, and
  // for video (H.264 / VP9 require even frame sizes).
  const video = format === 'wiggle' || format === 'motion';
  if (format === 'sbs' || format === 'half-sbs' || video) width = evenUp(width);
  if (format === 'ou' || format === 'half-ou' || video) height = evenUp(height);
  return { width, height, eyeWidth: width / tileX, eyeHeight: height / tileY };
}

function clampSide(v: number): number {
  if (!Number.isFinite(v)) return 2;
  return Math.min(MAX_OUTPUT_SIDE, Math.max(2, v));
}

export interface CropRect {
  /** Normalised source coordinates (0..1). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutSpec {
  fit: FitMode;
  /** Uniform user zoom (1 = preset framing). Ignored for manual crop. */
  scale: number;
  /** Crop / framing position, 0..1 (0.5 = centred). Ignored for manual crop. */
  posX: number;
  posY: number;
  /** Manual crop rectangle (normalised), used when fit === 'manual'. */
  crop: CropRect;
}

/**
 * Axis-aligned mapping from source pixel space to eye-frame space:
 *   frameX = offX + srcX * sx,  frameY = offY + srcY * sy
 * where coordinates are measured at pixel *edges* (pixel i spans [i, i+1)).
 */
export interface Mapping {
  sx: number;
  sy: number;
  offX: number;
  offY: number;
}

export function computeMapping(
  srcW: number,
  srcH: number,
  frameW: number,
  frameH: number,
  layout: LayoutSpec,
): Mapping {
  if (layout.fit === 'manual') {
    const c = normaliseCrop(layout.crop);
    const cw = c.w * srcW;
    const ch = c.h * srcH;
    const sx = frameW / cw;
    const sy = frameH / ch;
    return { sx, sy, offX: -c.x * srcW * sx, offY: -c.y * srcH * sy };
  }
  const zoom = Math.max(0.01, layout.scale || 1);
  let sx: number;
  let sy: number;
  if (layout.fit === 'stretch') {
    sx = (frameW / srcW) * zoom;
    sy = (frameH / srcH) * zoom;
  } else {
    const s = layout.fit === 'fill'
      ? Math.max(frameW / srcW, frameH / srcH)
      : Math.min(frameW / srcW, frameH / srcH);
    sx = sy = s * zoom;
  }
  const dw = srcW * sx;
  const dh = srcH * sy;
  const px = clamp01(layout.posX);
  const py = clamp01(layout.posY);
  return { sx, sy, offX: (frameW - dw) * px, offY: (frameH - dh) * py };
}

/** Zoom a mapping uniformly about the frame centre (used by the "crop edges" mode). */
export function zoomMapping(m: Mapping, z: number, frameW: number, frameH: number): Mapping {
  const cx = frameW / 2;
  const cy = frameH / 2;
  return {
    sx: m.sx * z,
    sy: m.sy * z,
    offX: cx - (cx - m.offX) * z,
    offY: cy - (cy - m.offY) * z,
  };
}

/** The region of the source visible in the eye frame, normalised & clamped to 0..1. */
export function visibleSourceRect(m: Mapping, srcW: number, srcH: number, frameW: number, frameH: number): CropRect {
  const x0 = clamp01((0 - m.offX) / m.sx / srcW);
  const x1 = clamp01((frameW - m.offX) / m.sx / srcW);
  const y0 = clamp01((0 - m.offY) / m.sy / srcH);
  const y1 = clamp01((frameH - m.offY) / m.sy / srcH);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Largest centred crop of the source with the frame's aspect ratio — the
 * default manual crop rectangle.
 */
export function defaultCrop(srcW: number, srcH: number, frameW: number, frameH: number): CropRect {
  const frameAR = frameW / frameH;
  const srcAR = srcW / srcH;
  if (srcAR > frameAR) {
    const w = frameAR / srcAR;
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  }
  const h = srcAR / frameAR;
  return { x: 0, y: (1 - h) / 2, w: 1, h };
}

export function normaliseCrop(c: CropRect): CropRect {
  const w = Math.min(1, Math.max(1e-4, c.w));
  const h = Math.min(1, Math.max(1e-4, c.h));
  return { x: Math.min(1 - w, Math.max(0, c.x)), y: Math.min(1 - h, Math.max(0, c.y)), w, h };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}
