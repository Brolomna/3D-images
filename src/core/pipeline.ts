/**
 * Processing pipeline orchestrator.
 *
 *   source ─► [resize/crop → base frame (cached)] ─► reference view ─┐
 *                                  └─► H-displace ─► V-displace ─────┴─► compose
 *
 * The expensive base frame is cached and only rebuilt when framing settings
 * change, so offset changes only re-run the cheap displacement + composition
 * stages. Results are deterministic: identical input + settings → identical
 * bytes, independent of the cache state.
 */
import { buildBackground } from './background';
import { composeSideBySide } from './compose';
import {
  computeMapping, resolveOutputSize, visibleSourceRect, zoomMapping,
  type CropRect, type Mapping, type OutputSize,
} from './layout';
import { renderFrame, type Background } from './resample';
import { effectiveOffsets, type StereoSettings } from './settings';
import { hasTransparency, type RGBAImage } from './types';
import { generateViews, type BaseFrame } from './views';

export interface RenderResult {
  output: RGBAImage;
  left: RGBAImage;
  right: RGBAImage;
  /** Full-resolution output size (what export produces). */
  size: OutputSize;
  /** Scale of this render relative to full resolution (1 for export). */
  renderScale: number;
  /** Displacement actually applied at this render's resolution. */
  dx: number;
  dy: number;
  mapping: Mapping;
  /** Source region visible in the reference eye (normalised). */
  visible: CropRect;
  baseReused: boolean;
  timings: { base: number; views: number; compose: number };
}

const KERNEL_PAD = 4;

function roundUp(v: number, step: number): number {
  return Math.ceil(v / step) * step;
}

export class StereoPipeline {
  private source: RGBAImage | null = null;
  private sourceHasAlpha = false;
  private baseKey = '';
  private base: BaseFrame | null = null;
  private bgKey = '';
  private bg: Background | null = null;

  setSource(img: RGBAImage): void {
    this.source = img;
    this.sourceHasAlpha = hasTransparency(img);
    this.base = null;
    this.baseKey = '';
    this.bg = null;
    this.bgKey = '';
  }

  getSource(): RGBAImage | null {
    return this.source;
  }

  /** Render at `renderScale` × full resolution (1 = export resolution). */
  render(settings: StereoSettings, renderScale = 1): RenderResult {
    const src = this.source;
    if (!src) throw new Error('No source image loaded');
    const size = resolveOutputSize(settings.output);
    const eyeW = Math.max(1, Math.round(size.eyeWidth * renderScale));
    const eyeH = Math.max(1, Math.round(size.eyeHeight * renderScale));
    // Offsets are defined in output pixels; scale them with the render.
    const off = effectiveOffsets(settings);
    const sxScale = eyeW / size.eyeWidth;
    const syScale = eyeH / size.eyeHeight;
    const dx = off.dx * sxScale;
    const dy = off.dy * syScale;

    let mapping = computeMapping(src.width, src.height, eyeW, eyeH, settings.layout);
    if (settings.edgeMode === 'crop' && (dx !== 0 || dy !== 0)) {
      const z = Math.max(1 + (2 * Math.ceil(Math.abs(dx))) / eyeW, 1 + (2 * Math.ceil(Math.abs(dy))) / eyeH);
      mapping = zoomMapping(mapping, z, eyeW, eyeH);
    }

    const needX = Math.ceil(Math.abs(dx)) + KERNEL_PAD;
    const needY = Math.ceil(Math.abs(dy)) + KERNEL_PAD;
    const keyObj = {
      eyeW, eyeH, mapping, interp: settings.resizeInterpolation, bg: settings.background,
    };
    const key = JSON.stringify(keyObj);

    const t0 = now();
    let reused = false;
    if (this.base && this.baseKey === key && this.base.marginX >= needX && this.base.marginY >= needY) {
      reused = true;
    } else {
      // Over-allocate margins so typical offset changes (up to ~60 px
      // horizontally, ~12 px vertically) re-use this frame.
      const marginX = roundUp(Math.max(needX * 1.5, 64), 16);
      const marginY = roundUp(Math.max(needY * 1.5, 16), 16);
      const bgKey = JSON.stringify({ eyeW, eyeH, marginX, marginY, bg: settings.background });
      if (!this.bg || this.bgKey !== bgKey) {
        this.bg = buildBackground(settings.background, src, this.sourceHasAlpha, eyeW, eyeH, marginX, marginY);
        this.bgKey = bgKey;
      }
      const image = renderFrame({
        source: src,
        sourceHasAlpha: this.sourceHasAlpha,
        mapping,
        frameW: eyeW,
        frameH: eyeH,
        marginX,
        marginY,
        interpolation: settings.resizeInterpolation,
        background: this.bg,
      });
      const mayHaveAlpha = this.sourceHasAlpha || settings.background.kind !== 'blur';
      this.base = { image, eyeW, eyeH, marginX, marginY, hasAlpha: mayHaveAlpha && hasTransparency(image) };
      this.baseKey = key;
    }
    const t1 = now();
    const views = generateViews(this.base!, dx, dy, settings.shiftedEye, settings.shiftInterpolation);
    const t2 = now();
    const output = composeSideBySide(views.left, views.right, settings.arrangement);
    const t3 = now();

    return {
      output,
      left: views.left,
      right: views.right,
      size,
      renderScale: eyeW / size.eyeWidth,
      dx,
      dy,
      mapping,
      visible: visibleSourceRect(mapping, src.width, src.height, eyeW, eyeH),
      baseReused: reused,
      timings: { base: t1 - t0, views: t2 - t1, compose: t3 - t2 },
    };
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
