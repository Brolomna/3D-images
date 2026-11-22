/**
 * Module 8 — Preview Renderer.
 *
 * Displays the worker's rendered output without re-processing: the composite
 * buffer is uploaded once into an offscreen canvas and every view mode
 * (side-by-side, synchronised L/R comparison, wiggle, difference, anaglyph,
 * original + crop editor) is drawn from it with a shared zoom / pan state.
 */
import type { CropRect } from '../core/layout';
import type { RGBAImage } from '../core/types';

export type ViewMode = 'sbs' | 'compare' | 'wiggle' | 'diff' | 'anaglyph' | 'depth' | 'crop';

interface Frame {
  composite: HTMLCanvasElement;
  left: HTMLCanvasElement;
  right: HTMLCanvasElement;
  eyeW: number;
  eyeH: number;
  depth?: HTMLCanvasElement;
  diff?: HTMLCanvasElement;
  anaglyph?: HTMLCanvasElement;
  leftData: ImageData;
  rightData: ImageData;
}

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class PreviewRenderer {
  mode: ViewMode = 'sbs';
  /** null = fit to stage; otherwise CSS px per content px. */
  zoom: number | null = null;
  /** View centre in normalised content coordinates. */
  private cx = 0.5;
  private cy = 0.5;
  private frame: Frame | null = null;
  private original: ImageBitmap | null = null;
  private visible: CropRect | null = null;
  private manualCrop = false;
  private crop: CropRect | null = null;
  private cropAspect = 1; // eye aspect (w/h) in pixels
  private wiggleOn = false;
  private wiggleTimer = 0;
  private wiggleMs = 140;
  private animateOutput = false;
  private outputFrames: HTMLCanvasElement[] | null = null;
  private animMs = 140;
  private tick = 0;
  private hover: { x: number; y: number } | null = null;
  private drag: { kind: 'pan' | Handle; sx: number; sy: number; cx: number; cy: number; crop: CropRect | null } | null = null;
  private dpr = 1;
  private raf = 0;
  onCropChange: (c: CropRect, final: boolean) => void = () => {};
  onCropReset: () => void = () => {};
  onZoomChange: (label: string) => void = () => {};

  constructor(
    private stage: HTMLElement,
    private canvas: HTMLCanvasElement,
    private readout: HTMLElement,
    private thumbs: Record<'original' | 'left' | 'right' | 'sbs', HTMLCanvasElement>,
  ) {
    new ResizeObserver(() => this.requestDraw()).observe(stage);
    this.bindPointer();
  }

  /** Upload newly rendered eye views + composed output (once per worker result). */
  setViews(
    left: RGBAImage,
    right: RGBAImage,
    depth: RGBAImage | null,
    output: RGBAImage,
    anim: { frames: RGBAImage[]; frameMs: number } | null,
  ): void {
    const toCanvas = (img: RGBAImage, prev?: HTMLCanvasElement) => {
      const c = prev && prev.width === img.width && prev.height === img.height ? prev : makeCanvas(img.width, img.height);
      c.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
      return c;
    };
    const f = this.frame;
    this.frame = {
      composite: toCanvas(output, f?.composite),
      left: toCanvas(left, f?.left),
      right: toCanvas(right, f?.right),
      depth: depth ? toCanvas(depth, f?.depth) : undefined,
      eyeW: left.width,
      eyeH: left.height,
      leftData: new ImageData(left.data as Uint8ClampedArray<ArrayBuffer>, left.width, left.height),
      rightData: new ImageData(right.data as Uint8ClampedArray<ArrayBuffer>, right.width, right.height),
    };
    if (anim) {
      const prev = this.outputFrames ?? [];
      this.outputFrames = anim.frames.map((img, i) => toCanvas(img, prev[i]));
      this.animMs = anim.frameMs;
    } else {
      this.outputFrames = null;
    }
    this.animateOutput = !!anim;
    this.setWiggle(this.mode === 'wiggle' || (this.mode === 'sbs' && this.animateOutput));
    this.drawThumbs();
    this.requestDraw();
  }

  /** Wiggle frame duration (ms). */
  setWiggleSpeed(ms: number): void {
    if (ms === this.wiggleMs) return;
    this.wiggleMs = ms;
    this.setWiggle(this.mode === 'wiggle' || (this.mode === 'sbs' && this.animateOutput));
  }

  setOriginal(bmp: ImageBitmap | null): void {
    this.original = bmp;
    this.frame = null;
    this.drawThumbs();
    this.requestDraw();
  }

  setCropState(visible: CropRect | null, manual: boolean, crop: CropRect, eyeAspect: number): void {
    this.visible = visible;
    this.manualCrop = manual;
    this.crop = { ...crop };
    this.cropAspect = eyeAspect;
    this.drawThumbs();
    this.requestDraw();
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.setWiggle(mode === 'wiggle' || (mode === 'sbs' && this.animateOutput));
    this.requestDraw();
  }

  zoomBy(factor: number, at?: { x: number; y: number }): void {
    const view = this.viewTransform();
    if (!view) return;
    const cur = view.scale;
    let next = Math.min(32, Math.max(0.05, cur * factor));
    if (Math.abs(next - 1) < 0.04) next = 1;
    if (at) {
      // Keep the content point under the cursor fixed.
      const p = this.screenToContent(at.x, at.y, view);
      const { w, h } = view.content;
      const rect = this.stageRect();
      this.cx = (p.x - (at.x - view.areaX - view.areaW / 2) / next) / w;
      this.cy = (p.y - (at.y - rect.height / 2) / next) / h;
    } else if (this.zoom === null) {
      this.cx = 0.5;
      this.cy = 0.5;
    }
    this.zoom = next;
    this.clampCenter();
    this.requestDraw();
  }

  toggleFit(): void {
    if (this.zoom === null) {
      this.zoom = 1;
    } else {
      this.zoom = null;
      this.cx = this.cy = 0.5;
    }
    this.requestDraw();
  }

  requestDraw(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  // ───────────────────────── internals ─────────────────────────

  private setWiggle(on: boolean) {
    clearInterval(this.wiggleTimer);
    if (on) {
      this.wiggleTimer = window.setInterval(() => {
        this.wiggleOn = !this.wiggleOn;
        this.tick++;
        this.requestDraw();
      }, this.mode === 'wiggle' ? this.wiggleMs : this.animMs);
    }
  }

  private stageRect() {
    return this.stage.getBoundingClientRect();
  }

  /** Content being displayed in the current mode. */
  private content(): { w: number; h: number; panes: 1 | 2 } | null {
    if (this.mode === 'crop') {
      return this.original ? { w: this.original.width, h: this.original.height, panes: 1 } : null;
    }
    const f = this.frame;
    if (!f) return null;
    if (this.mode === 'sbs') {
      const af = this.outputFrames?.[0];
      if (this.animateOutput && af) return { w: af.width, h: af.height, panes: 1 };
      return { w: f.composite.width, h: f.composite.height, panes: 1 };
    }
    if (this.mode === 'compare') return { w: f.eyeW, h: f.eyeH, panes: 2 };
    return { w: f.eyeW, h: f.eyeH, panes: 1 };
  }

  private viewTransform() {
    const content = this.content();
    if (!content) return null;
    const rect = this.stageRect();
    const pad = this.zoom === null ? 16 : 0;
    const gap = content.panes === 2 ? 8 : 0;
    const paneW = (rect.width - gap) / content.panes;
    const fitScale = Math.min((paneW - pad * 2) / content.w, (rect.height - pad * 2) / content.h);
    const scale = this.zoom ?? Math.max(0.01, fitScale);
    return { content, scale, areaX: 0, areaW: paneW, gap, rectH: rect.height };
  }

  private screenToContent(sx: number, sy: number, view = this.viewTransform()!) {
    const { w, h } = view.content;
    let areaX = 0;
    if (view.content.panes === 2 && sx > view.areaW + view.gap / 2) areaX = view.areaW + view.gap;
    const x = (sx - areaX - view.areaW / 2) / view.scale + this.cx * w;
    const y = (sy - view.rectH / 2) / view.scale + this.cy * h;
    return { x, y };
  }

  private clampCenter() {
    this.cx = Math.min(1, Math.max(0, this.cx));
    this.cy = Math.min(1, Math.max(0, this.cy));
  }

  private draw() {
    const rect = this.stageRect();
    this.dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(rect.width * this.dpr));
    const H = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const g = this.canvas.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    const view = this.viewTransform();
    this.onZoomChange(this.zoom === null ? 'Fit' : `${Math.round(this.zoom * 100)}%`);
    this.stage.classList.toggle('grab', !!view && (this.zoom !== null || (this.mode === 'crop' && this.manualCrop)));
    if (!view) {
      this.readout.classList.add('hidden');
      return;
    }
    g.scale(this.dpr, this.dpr);
    const { w, h } = view.content;
    const s = view.scale;
    g.imageSmoothingEnabled = s < 2;
    g.imageSmoothingQuality = 'high';

    const drawPane = (src: CanvasImageSource, paneX: number) => {
      const x = paneX + view.areaW / 2 - this.cx * w * s;
      const y = rect.height / 2 - this.cy * h * s;
      g.save();
      g.beginPath();
      g.rect(paneX, 0, view.areaW, rect.height);
      g.clip();
      g.drawImage(src, x, y, w * s, h * s);
      g.restore();
      return { x, y };
    };

    const f = this.frame;
    if (this.mode === 'crop' && this.original) {
      const o = drawPane(this.original, 0);
      this.drawCropOverlay(g, o.x, o.y, w * s, h * s);
    } else if (f) {
      if (this.mode === 'sbs') {
        const frames = this.outputFrames;
        drawPane(this.animateOutput && frames?.length ? frames[this.tick % frames.length] : f.composite, 0);
      } else if (this.mode === 'compare') {
        const a = drawPane(f.left, 0);
        drawPane(f.right, view.areaW + view.gap);
        this.label(g, 'L', 8, 8, '#ff5d5d');
        this.label(g, 'R', view.areaW + view.gap + 8, 8, '#40d0ff');
        if (this.hover) {
          // Synchronised crosshair at the same pixel in both eyes.
          const px = Math.floor(this.hover.x), py = Math.floor(this.hover.y);
          g.strokeStyle = 'rgba(255,255,255,0.75)';
          g.lineWidth = 1;
          for (const paneX of [0, view.areaW + view.gap]) {
            const ox = paneX + view.areaW / 2 - this.cx * w * s;
            const cxp = ox + (px + 0.5) * s;
            const cyp = a.y + (py + 0.5) * s;
            g.beginPath();
            g.moveTo(cxp, cyp - 12); g.lineTo(cxp, cyp + 12);
            g.moveTo(cxp - 12, cyp); g.lineTo(cxp + 12, cyp);
            g.stroke();
          }
        }
      } else if (this.mode === 'wiggle') {
        drawPane(this.wiggleOn ? f.right : f.left, 0);
        this.label(g, this.wiggleOn ? 'R' : 'L', 8, 8, this.wiggleOn ? '#40d0ff' : '#ff5d5d');
      } else if (this.mode === 'depth') {
        if (f.depth) drawPane(f.depth, 0);
        else this.message(g, rect.width, rect.height, 'Depth is off or still being analysed');
      } else if (this.mode === 'diff') {
        drawPane(this.derived('diff'), 0);
      } else if (this.mode === 'anaglyph') {
        drawPane(this.derived('anaglyph'), 0);
      }
    }
    this.updateReadout();
  }

  private message(g: CanvasRenderingContext2D, w: number, h: number, text: string) {
    g.fillStyle = '#9097a5';
    g.font = '13px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2);
  }

  private label(g: CanvasRenderingContext2D, t: string, x: number, y: number, color: string) {
    g.fillStyle = 'rgba(14,15,18,0.85)';
    g.fillRect(x, y, 22, 20);
    g.fillStyle = color;
    g.font = '600 12px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(t, x + 11, y + 10.5);
  }

  private derived(kind: 'diff' | 'anaglyph'): HTMLCanvasElement {
    const f = this.frame!;
    const cached = f[kind];
    if (cached) return cached;
    const c = makeCanvas(f.eyeW, f.eyeH);
    const out = new ImageData(f.eyeW, f.eyeH);
    const L = f.leftData.data, R = f.rightData.data, o = out.data;
    for (let i = 0; i < o.length; i += 4) {
      if (kind === 'diff') {
        o[i] = Math.abs(L[i] - R[i]) * 4;
        o[i + 1] = Math.abs(L[i + 1] - R[i + 1]) * 4;
        o[i + 2] = Math.abs(L[i + 2] - R[i + 2]) * 4;
      } else {
        o[i] = 0.299 * L[i] + 0.587 * L[i + 1] + 0.114 * L[i + 2];
        o[i + 1] = R[i + 1];
        o[i + 2] = R[i + 2];
      }
      o[i + 3] = 255;
    }
    c.getContext('2d')!.putImageData(out, 0, 0);
    f[kind] = c;
    return c;
  }

  private cropRectScreen(ox: number, oy: number, dw: number, dh: number): { x: number; y: number; w: number; h: number } | null {
    const r = this.manualCrop ? this.crop : this.visible;
    if (!r) return null;
    return { x: ox + r.x * dw, y: oy + r.y * dh, w: r.w * dw, h: r.h * dh };
  }

  private drawCropOverlay(g: CanvasRenderingContext2D, ox: number, oy: number, dw: number, dh: number) {
    const r = this.cropRectScreen(ox, oy, dw, dh);
    if (!r) return;
    g.save();
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.beginPath();
    g.rect(ox, oy, dw, dh);
    g.rect(r.x, r.y, r.w, r.h);
    g.fill('evenodd');
    g.strokeStyle = this.manualCrop ? '#4f8cff' : 'rgba(255,255,255,0.85)';
    g.lineWidth = 1.5;
    g.strokeRect(r.x, r.y, r.w, r.h);
    if (this.manualCrop) {
      // Rule-of-thirds guides and corner handles.
      g.strokeStyle = 'rgba(255,255,255,0.25)';
      g.lineWidth = 1;
      g.beginPath();
      for (const t of [1 / 3, 2 / 3]) {
        g.moveTo(r.x + r.w * t, r.y); g.lineTo(r.x + r.w * t, r.y + r.h);
        g.moveTo(r.x, r.y + r.h * t); g.lineTo(r.x + r.w, r.y + r.h * t);
      }
      g.stroke();
      g.fillStyle = '#4f8cff';
      for (const [hx, hy] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
        g.fillRect(hx - 5, hy - 5, 10, 10);
      }
    }
    g.restore();
  }

  private updateReadout() {
    const f = this.frame;
    if (!this.hover || !f || (this.mode !== 'compare' && this.mode !== 'wiggle' && this.mode !== 'diff')) {
      this.readout.classList.add('hidden');
      return;
    }
    const x = Math.floor(this.hover.x), y = Math.floor(this.hover.y);
    if (x < 0 || y < 0 || x >= f.eyeW || y >= f.eyeH) {
      this.readout.classList.add('hidden');
      return;
    }
    const i = (y * f.eyeW + x) * 4;
    const L = f.leftData.data, R = f.rightData.data;
    this.readout.textContent = `x ${x}  y ${y}   L ${L[i]},${L[i + 1]},${L[i + 2]}   R ${R[i]},${R[i + 1]},${R[i + 2]}`;
    this.readout.classList.remove('hidden');
  }

  private hitHandle(sx: number, sy: number): Handle | null {
    const view = this.viewTransform();
    if (!view || !this.crop || !this.original) return null;
    const { w, h } = view.content;
    const s = view.scale;
    const ox = view.areaW / 2 - this.cx * w * s;
    const oy = view.rectH / 2 - this.cy * h * s;
    const r = this.cropRectScreen(ox, oy, w * s, h * s)!;
    const near = (ax: number, ay: number) => Math.abs(sx - ax) <= 12 && Math.abs(sy - ay) <= 12;
    if (near(r.x, r.y)) return 'nw';
    if (near(r.x + r.w, r.y)) return 'ne';
    if (near(r.x, r.y + r.h)) return 'sw';
    if (near(r.x + r.w, r.y + r.h)) return 'se';
    if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) return 'move';
    return null;
  }

  private bindPointer() {
    const el = this.stage;
    const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const r = this.stageRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    el.addEventListener('pointerdown', (e) => {
      const p = local(e);
      if (this.mode === 'crop' && this.manualCrop) {
        const hnd = this.hitHandle(p.x, p.y);
        if (hnd) {
          this.drag = { kind: hnd, sx: p.x, sy: p.y, cx: this.cx, cy: this.cy, crop: { ...this.crop! } };
          el.setPointerCapture(e.pointerId);
          return;
        }
      }
      if (this.zoom !== null) {
        this.drag = { kind: 'pan', sx: p.x, sy: p.y, cx: this.cx, cy: this.cy, crop: null };
        el.classList.add('grabbing');
        el.setPointerCapture(e.pointerId);
      }
    });
    el.addEventListener('pointermove', (e) => {
      const p = local(e);
      const view = this.viewTransform();
      if (view) {
        const c = this.screenToContent(p.x, p.y, view);
        this.hover = c;
      }
      if (this.mode === 'crop' && this.manualCrop && !this.drag) {
        const hnd = this.hitHandle(p.x, p.y);
        el.style.cursor = hnd === 'move' ? 'move' : hnd === 'nw' || hnd === 'se' ? 'nwse-resize' : hnd ? 'nesw-resize' : '';
      } else if (!this.drag) {
        el.style.cursor = '';
      }
      if (this.drag && view) {
        const { w, h } = view.content;
        const dxs = p.x - this.drag.sx, dys = p.y - this.drag.sy;
        if (this.drag.kind === 'pan') {
          this.cx = this.drag.cx - dxs / view.scale / w;
          this.cy = this.drag.cy - dys / view.scale / h;
          this.clampCenter();
        } else if (this.drag.crop && this.original) {
          const next = this.dragCrop(this.drag.kind, this.drag.crop, dxs / view.scale / w, dys / view.scale / h);
          this.crop = next;
          this.onCropChange(next, false);
        }
      }
      this.requestDraw();
    });
    const end = (e: PointerEvent) => {
      if (this.drag && this.drag.kind !== 'pan' && this.crop) this.onCropChange(this.crop, true);
      this.drag = null;
      el.classList.remove('grabbing');
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => {
      this.hover = null;
      this.requestDraw();
    });
    el.addEventListener('dblclick', (e) => {
      if (this.mode === 'crop' && this.manualCrop) this.onCropReset();
      else this.zoomBy(this.zoom === null ? 2 : 1 / (this.zoom || 1), local(e));
    });
    el.addEventListener('wheel', (e) => {
      if (!this.content()) return;
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), local(e));
    }, { passive: false });
  }

  /** Move / resize the manual crop, keeping the eye aspect ratio and staying inside the photo. */
  private dragCrop(kind: Handle, start: CropRect, dxn: number, dyn: number): CropRect {
    const ow = this.original!.width, oh = this.original!.height;
    if (kind === 'move') {
      return {
        x: Math.min(1 - start.w, Math.max(0, start.x + dxn)),
        y: Math.min(1 - start.h, Math.max(0, start.y + dyn)),
        w: start.w,
        h: start.h,
      };
    }
    // Normalised height per normalised width for the locked aspect.
    const k = ow / oh / this.cropAspect;
    const ax = kind === 'nw' || kind === 'sw' ? start.x + start.w : start.x; // anchor
    const ay = kind === 'nw' || kind === 'ne' ? start.y + start.h : start.y;
    const sxSign = kind === 'nw' || kind === 'sw' ? -1 : 1;
    const sySign = kind === 'nw' || kind === 'ne' ? -1 : 1;
    let w = Math.max(start.w + sxSign * dxn, (start.h + sySign * dyn) / k, 0.02);
    const maxW = sxSign > 0 ? 1 - ax : ax;
    const maxH = sySign > 0 ? 1 - ay : ay;
    w = Math.min(w, maxW, maxH / k);
    const h = w * k;
    return { x: sxSign > 0 ? ax : ax - w, y: sySign > 0 ? ay : ay - h, w, h };
  }

  private drawThumbs() {
    const draw = (c: HTMLCanvasElement, src: CanvasImageSource | null, sw: number, sh: number, overlay?: (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void) => {
      const dpr = window.devicePixelRatio || 1;
      const rect = c.getBoundingClientRect();
      const W = Math.max(1, Math.round((rect.width || 160) * dpr));
      const H = Math.max(1, Math.round((rect.height || 86) * dpr));
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const g = c.getContext('2d')!;
      g.clearRect(0, 0, W, H);
      if (!src || !sw || !sh) return;
      const s = Math.min(W / sw, H / sh);
      const w = sw * s, h = sh * s, x = (W - w) / 2, y = (H - h) / 2;
      g.imageSmoothingQuality = 'high';
      g.drawImage(src, x, y, w, h);
      overlay?.(g, x, y, w, h);
    };
    const o = this.original;
    draw(this.thumbs.original, o, o?.width ?? 0, o?.height ?? 0, (g, x, y, w, h) => {
      const r = this.manualCrop ? this.crop : this.visible;
      if (!r) return;
      g.strokeStyle = this.manualCrop ? '#4f8cff' : 'rgba(255,255,255,0.9)';
      g.lineWidth = 1.5;
      g.strokeRect(x + r.x * w, y + r.y * h, r.w * w, r.h * h);
    });
    const f = this.frame;
    draw(this.thumbs.left, f?.left ?? null, f?.eyeW ?? 0, f?.eyeH ?? 0);
    draw(this.thumbs.right, f?.right ?? null, f?.eyeW ?? 0, f?.eyeH ?? 0);
    const thumb = this.animateOutput && this.outputFrames?.length ? this.outputFrames[0] : f?.composite ?? null;
    draw(this.thumbs.sbs, thumb, thumb?.width ?? 0, thumb?.height ?? 0);
  }

  redrawThumbs() {
    this.drawThumbs();
  }
}
