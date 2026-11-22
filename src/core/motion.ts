/**
 * "3D photo" motion effect: a virtual camera gently moves in front of the
 * photo and every pixel shifts according to its depth (near parts move more
 * than far parts), producing a looping parallax animation that shows depth
 * without glasses. Implemented as a separable 2-pass depth warp of the same
 * base frame used for the stereo views — still only real photo pixels.
 */
import { warpHorizontal, warpVertical, type DepthMap } from './depth';
import { cropImage, type Interpolation, type RGBAImage } from './types';
import type { BaseFrame } from './views';

export type MotionPath = 'circle' | 'horizontal' | 'vertical' | 'zoom';

export interface MotionSettings {
  path: MotionPath;
  /** Parallax amount in output pixels (near-vs-far movement at the extremes). */
  amplitude: number;
  /** Length of one loop. */
  durationMs: number;
  file: 'video' | 'gif';
}

export const MOTION_FPS = { video: 30, gif: 15 } as const;

/** Camera offsets at loop phase t ∈ [0, 1). */
export function motionOffsets(path: MotionPath, amplitude: number, t: number) {
  const a = 2 * Math.PI * t;
  switch (path) {
    case 'circle': return { hx: -amplitude * Math.cos(a), vy: -amplitude * Math.sin(a), radial: 0 };
    case 'horizontal': return { hx: -amplitude * Math.sin(a), vy: 0, radial: 0 };
    case 'vertical': return { hx: 0, vy: -amplitude * Math.sin(a), radial: 0 };
    case 'zoom': return { hx: 0, vy: 0, radial: amplitude * (1 - Math.cos(a)) / 2 };
  }
}

/** Number of frames in one loop and the exact frame duration. */
export function motionTiming(m: MotionSettings): { count: number; frameMs: number } {
  const fps = MOTION_FPS[m.file];
  const count = Math.max(2, Math.round((Math.max(500, m.durationMs) / 1000) * fps));
  return { count, frameMs: Math.max(500, m.durationMs) / count };
}

/** Render one motion frame (eyeW × eyeH) at loop phase t. */
export function renderMotionFrame(
  base: BaseFrame,
  depth: DepthMap | null,
  focus: number,
  path: MotionPath,
  amplitude: number,
  t: number,
  interpolation: Interpolation,
): RGBAImage {
  const { eyeW, eyeH, marginX, marginY, hasAlpha } = base;
  const { hx, vy, radial } = motionOffsets(path, amplitude, t);
  const still = !depth || (Math.abs(hx) < 1e-9 && Math.abs(vy) < 1e-9 && Math.abs(radial) < 1e-9);
  if (still) return cropImage(base.image, marginX, marginY, eyeW, eyeH);

  // Pass 1: horizontal parallax (carries the depth along for pass 2).
  const H = base.image.height;
  const warpedDepth = new Float32Array(eyeW * H);
  const h = warpHorizontal(base.image, depth!, marginX, eyeW, {
    uniform: 0, strength: hx, focus, eyeSign: 1, radial, center: eyeW / 2,
  }, interpolation, hasAlpha, warpedDepth);
  // Pass 2: vertical parallax.
  if (Math.abs(vy) < 1e-9 && Math.abs(radial) < 1e-9) return cropImage(h, 0, marginY, eyeW, eyeH);
  return warpVertical(h, { width: eyeW, height: H, data: warpedDepth }, marginY, eyeH, {
    uniform: 0, strength: vy, focus, eyeSign: 1, radial, center: eyeH / 2,
  }, interpolation, hasAlpha);
}

