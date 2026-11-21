/**
 * Processing pipeline orchestrator.
 *
 *   source ─► [resize/crop → base frame (cached)] ─► reference view ─────────┐
 *   depth  ─► [normalise/smooth → aligned depth frame (cached)] ─┐           │
 *                                   base ─► H-displace / depth warp ─► V-displace ─► layout
 *
 * The expensive base and depth frames are cached and only rebuilt when the
 * framing changes, so offset / depth-strength changes only re-run the cheap
 * displacement + composition stages. Results are deterministic: identical
 * input + settings → identical bytes, independent of the cache state.
 */
import { buildBackground } from './background';
import { depthToImage, normalizeDepth, renderDepthFrame, smoothDepth, type DepthMap } from './depth';
import { composeLayout } from './formats';
import {
  computeMapping, resolveOutputSize, visibleSourceRect, zoomMapping,
  type CropRect, type Mapping, type OutputSize,
} from './layout';
import { renderFrame, type Background } from './resample';
import { effectiveOffsets, type StereoSettings } from './settings';
import { cropImage, hasTransparency, type RGBAImage } from './types';
import { generateReferenceView, generateViews, generateDisplacedView, type BaseFrame, type ViewParams } from './views';

export interface RenderResult {
  output: RGBAImage;
  left: RGBAImage;
  right: RGBAImage;
  /** Aligned depth map of the reference eye (grayscale), when requested. */
  depth?: RGBAImage;
  /** Full-resolution output size (what export produces). */
  size: OutputSize;
  /** Scale of this render relative to full resolution (1 for export). */
  renderScale: number;
  /** Uniform displacement actually applied at this render's resolution. */
  dx: number;
  dy: number;
  /** Whether depth-based disparity was used. */
  depthUsed: boolean;
  mapping: Mapping;
  /** Source region visible in the reference eye (normalised). */
  visible: CropRect;
  baseReused: boolean;
  timings: { base: number; views: number; compose: number };
}

export interface RenderOptions {
  /** Also return the composed output (default true). */
  compose?: boolean;
  /** Also return a grayscale view of the aligned depth map. */
  includeDepth?: boolean;
}

const KERNEL_PAD = 4;

function roundUp(v: number, step: number): number {
  return Math.ceil(v / step) * step;
}

interface Prepared {
  size: OutputSize;
  base: BaseFrame;
  params: ViewParams;
  dx: number;
  dy: number;
  mapping: Mapping;
  renderScale: number;
  baseReused: boolean;
  depthUsed: boolean;
}

export class StereoPipeline {
  private source: RGBAImage | null = null;
  private sourceHasAlpha = false;
  private baseKey = '';
  private base: BaseFrame | null = null;
  private bgKey = '';
  private bg: Background | null = null;
  private rawDepth: DepthMap | null = null;
  private depthId = 0;
  private depthKey = '';
  private depthFrame: DepthMap | null = null;

  setSource(img: RGBAImage): void {
    this.source = img;
    this.sourceHasAlpha = hasTransparency(img);
    this.base = null;
    this.baseKey = '';
    this.bg = null;
    this.bgKey = '';
    this.setDepth(null);
  }

  getSource(): RGBAImage | null {
    return this.source;
  }

  /** Raw relative-inverse-depth prediction for the current source (or null). */
  setDepth(depth: DepthMap | null): void {
    this.rawDepth = depth;
    this.depthId++;
    this.depthFrame = null;
    this.depthKey = '';
  }

  hasDepth(): boolean {
    return !!this.rawDepth;
  }

  private prepare(settings: StereoSettings, renderScale: number): Prepared {
    const src = this.source;
    if (!src) throw new Error('No source image loaded');
    const size = resolveOutputSize(settings.output, settings.format);
    const eyeW = Math.max(1, Math.round(size.eyeWidth * renderScale));
    const eyeH = Math.max(1, Math.round(size.eyeHeight * renderScale));
    // Offsets are defined in output pixels; scale them with the render.
    const off = effectiveOffsets(settings);
    const sxScale = eyeW / size.eyeWidth;
    const syScale = eyeH / size.eyeHeight;
    const dx = off.dx * sxScale;
    const dy = off.dy * syScale;
    const depthUsed = settings.depth.enabled && !!this.rawDepth && settings.depth.strength !== 0;
    const strength = depthUsed ? settings.depth.strength * sxScale : 0;
    // Largest possible |disparity| (depth term spans strength·max(focus, 1−focus)).
    const maxD = Math.abs(dx) + strength * Math.max(settings.depth.focus, 1 - settings.depth.focus);

    let mapping = computeMapping(src.width, src.height, eyeW, eyeH, settings.layout);
    if (settings.edgeMode === 'crop' && (maxD !== 0 || dy !== 0)) {
      const z = Math.max(1 + (2 * Math.ceil(maxD)) / eyeW, 1 + (2 * Math.ceil(Math.abs(dy))) / eyeH);
      mapping = zoomMapping(mapping, z, eyeW, eyeH);
    }

    const needX = Math.ceil(maxD) + KERNEL_PAD;
    const needY = Math.ceil(Math.abs(dy)) + KERNEL_PAD;
    const key = JSON.stringify({ eyeW, eyeH, mapping, interp: settings.resizeInterpolation, bg: settings.background });

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
    const base = this.base!;

    let depth: ViewParams['depth'] = null;
    if (depthUsed || (settings.depth.enabled && this.rawDepth)) {
      const dKey = JSON.stringify({ key, mx: base.marginX, my: base.marginY, id: this.depthId, s: settings.depth.smoothing, inv: settings.depth.invert });
      if (!this.depthFrame || this.depthKey !== dKey) {
        const norm = normalizeDepth(this.rawDepth!, settings.depth.invert);
        const radius = (Math.max(0, settings.depth.smoothing) / 100) * norm.width;
        const smooth = smoothDepth(norm, radius);
        this.depthFrame = renderDepthFrame(smooth, mapping, src.width, src.height, eyeW, eyeH, base.marginX, base.marginY);
        this.depthKey = dKey;
      }
      depth = {
        frame: this.depthFrame,
        strength,
        focus: settings.depth.focus,
        eyeSign: settings.shiftedEye === 'right' ? -1 : 1,
      };
    }
    const params: ViewParams = { dx, dy, interpolation: settings.shiftInterpolation, depth };
    return { size, base, params, dx, dy, mapping, renderScale: eyeW / size.eyeWidth, baseReused: reused, depthUsed };
  }

  /** Render at `renderScale` × full resolution (1 = export resolution). */
  render(settings: StereoSettings, renderScale = 1, opts: RenderOptions = {}): RenderResult {
    const t0 = now();
    const p = this.prepare(settings, renderScale);
    const t1 = now();
    const views = generateViews(p.base, p.params, settings.shiftedEye, settings.edgeMask);
    const t2 = now();
    const output = opts.compose === false
      ? views.left
      : composeLayout(views.left, views.right, settings.format, settings.arrangement, settings.anaglyphMethod, settings.resizeInterpolation);
    const t3 = now();
    let depth: RGBAImage | undefined;
    if (opts.includeDepth && p.params.depth) {
      const f = p.params.depth.frame;
      depth = cropImage(depthToImage(f), p.base.marginX, p.base.marginY, p.base.eyeW, p.base.eyeH);
    }
    const src = this.source!;
    return {
      output,
      left: views.left,
      right: views.right,
      depth,
      size: p.size,
      renderScale: p.renderScale,
      dx: p.dx,
      dy: p.dy,
      depthUsed: p.depthUsed,
      mapping: p.mapping,
      visible: visibleSourceRect(p.mapping, src.width, src.height, p.base.eyeW, p.base.eyeH),
      baseReused: p.baseReused,
      timings: { base: t1 - t0, views: t2 - t1, compose: t3 - t2 },
    };
  }

  /**
   * Frames of a wiggle animation. 2 frames = left/right flip; more frames
   * sweep smoothly from the reference view to the full displacement and back.
   */
  renderWiggleFrames(settings: StereoSettings, frames: number, renderScale = 1): RGBAImage[] {
    const p = this.prepare(settings, renderScale);
    const n = Math.max(2, Math.round(frames / 2) * 2);
    const half = n / 2;
    const ts: number[] = [];
    for (let k = 0; k < n; k++) ts.push(k <= half ? k / half : (n - k) / half);
    const cache = new Map<number, RGBAImage>();
    const view = (t: number) => {
      let img = cache.get(t);
      if (!img) {
        img = t === 0 ? generateReferenceView(p.base) : generateDisplacedView(p.base, { ...p.params, t });
        cache.set(t, img);
      }
      return img;
    };
    return ts.map(view);
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
