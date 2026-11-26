/**
 * ✏️ Manual card splitter: paint one mask per layer over the card.
 *
 *  - Brush (size, softness) and eraser; painting a layer removes the same
 *    pixels from the others, so every pixel belongs to one layer.
 *  - Magic select: a tap grows a region of similar colour (and depth, when a
 *    depth map is available) and adds it to the active layer.
 *  - Undo / redo, two-finger pinch zoom and pan (wheel / middle-drag on desktop).
 *
 * Masks live at a working resolution (≤ 1200 px long side) and are scaled
 * up and feathered when the layers are built.
 */
import { magicSelect, type LayerRole, type PaintLayer } from '../core/cardstack';
import type { RGBAImage } from '../core/types';

export type PaintTool = 'brush' | 'eraser' | 'magic';

export interface EditorLayer extends PaintLayer {
  color: [number, number, number];
}

const PALETTE: [number, number, number][] = [[79, 140, 255], [255, 122, 61], [61, 220, 132], [180, 100, 255], [255, 210, 60], [255, 80, 160], [60, 220, 230]];
const MAX_SIDE = 1200;
const UNDO_LIMIT = 30;

export class CardEditor {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private photo: HTMLCanvasElement | null = null; // card at mask resolution (for display)
  private small: RGBAImage | null = null; // card at mask resolution (for magic select)
  private depth: Float32Array | null = null; // depth at mask resolution
  private overlay: HTMLCanvasElement = document.createElement('canvas');
  private overlayData: ImageData | null = null;
  mw = 0;
  mh = 0;
  layers: EditorLayer[] = [];
  active = 1;
  tool: PaintTool = 'brush';
  size = 28; // brush radius in mask px
  softness = 0.4;
  tolerance = 0.35;
  private undo: Uint8Array[][] = [];
  private redo: Uint8Array[][] = [];
  // View transform: screen = offset + mask * scale (CSS px).
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private fitted = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private stroke: { last: { x: number; y: number }; snapshot: Uint8Array[] } | null = null;
  private pinch: { dist: number; mid: { x: number; y: number } } | null = null;
  private panning: { x: number; y: number } | null = null;
  private raf = 0;
  private hover: { x: number; y: number } | null = null;
  onChange: () => void = () => {};

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'card-editor';
    this.el.hidden = true;
    this.canvas = document.createElement('canvas');
    this.el.appendChild(this.canvas);
    host.appendChild(this.el);
    new ResizeObserver(() => this.draw()).observe(this.el);
    this.bind();
  }

  /** Load a card; resets the masks to the default three layers. */
  setCard(card: RGBAImage, depth: { width: number; height: number; data: Float32Array } | null): void {
    const s = Math.min(1, MAX_SIDE / Math.max(card.width, card.height));
    this.mw = Math.max(1, Math.round(card.width * s));
    this.mh = Math.max(1, Math.round(card.height * s));
    const src = document.createElement('canvas');
    src.width = card.width; src.height = card.height;
    src.getContext('2d')!.putImageData(new ImageData(card.data.slice(), card.width, card.height), 0, 0);
    const c = document.createElement('canvas');
    c.width = this.mw; c.height = this.mh;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, this.mw, this.mh);
    this.photo = c;
    this.small = { width: this.mw, height: this.mh, data: g.getImageData(0, 0, this.mw, this.mh).data };
    this.setDepth(depth);
    this.overlay.width = this.mw; this.overlay.height = this.mh;
    this.overlayData = new ImageData(this.mw, this.mh);
    this.layers = [
      this.makeLayer('bg', 'Background', 'bg', false, 0),
      this.makeLayer('char', 'Character', 'char', false, 1),
      this.makeLayer('frame', 'Frame', 'frame', true, 2),
    ];
    this.active = 1;
    this.undo = []; this.redo = [];
    this.fitted = false;
    this.refreshOverlay();
    this.onChange();
  }

  setDepth(depth: { width: number; height: number; data: Float32Array } | null): void {
    if (!depth || !this.mw) { this.depth = null; return; }
    const out = new Float32Array(this.mw * this.mh);
    for (let y = 0; y < this.mh; y++) for (let x = 0; x < this.mw; x++) {
      const sx = Math.min(depth.width - 1, Math.floor(((x + 0.5) * depth.width) / this.mw));
      const sy = Math.min(depth.height - 1, Math.floor(((y + 0.5) * depth.height) / this.mh));
      out[y * this.mw + x] = depth.data[sy * depth.width + sx];
    }
    this.depth = out;
  }

  /** Replace all masks (e.g. "Start from Auto"); undoable. */
  setLayers(paint: PaintLayer[]): void {
    this.pushUndo();
    this.layers = paint.map((p, i) => ({ ...p, mask: p.mask.slice(), color: this.colorFor(p.role, i) }));
    this.active = Math.max(0, this.layers.findIndex((l) => l.role === 'char'));
    this.refreshOverlay();
    this.onChange();
  }

  addLayer(): void {
    this.pushUndo();
    const n = this.layers.filter((l) => l.role === 'mid').length + 1;
    const layer = this.makeLayer(`mid${Date.now().toString(36)}`, `Layer ${n}`, 'mid', false, this.layers.length);
    // New layers go in front of the background, behind the character.
    const at = Math.max(1, this.layers.findIndex((l) => l.role === 'char'));
    this.layers.splice(at, 0, layer);
    this.active = at;
    this.refreshOverlay();
    this.onChange();
  }

  removeLayer(i: number): void {
    if (this.layers[i]?.role !== 'mid') return;
    this.pushUndo();
    this.layers.splice(i, 1);
    this.active = Math.min(this.active, this.layers.length - 1);
    this.refreshOverlay();
    this.onChange();
  }

  setStill(i: number, still: boolean): void {
    if (this.layers[i]) this.layers[i].still = still;
    this.onChange();
  }

  canUndo() { return this.undo.length > 0; }
  canRedo() { return this.redo.length > 0; }
  painted(): boolean { return this.layers.some((l) => l.role !== 'bg' && l.mask.some((v) => v > 0)); }

  doUndo(): void {
    const prev = this.undo.pop();
    if (!prev) return;
    this.redo.push(this.snapshot());
    this.restore(prev);
  }

  doRedo(): void {
    const next = this.redo.pop();
    if (!next) return;
    this.undo.push(this.snapshot());
    this.restore(next);
  }

  setVisible(on: boolean): void {
    this.el.hidden = !on;
    if (on) this.draw();
  }

  zoomBy(f: number): void {
    const r = this.el.getBoundingClientRect();
    this.zoomAt(f, r.width / 2, r.height / 2);
  }

  fit(): void {
    this.fitted = false;
    this.draw();
  }

  // ───────────────────────── internals ─────────────────────────

  private makeLayer(id: string, name: string, role: LayerRole, still: boolean, i: number): EditorLayer {
    return { id, name, role, still, mask: new Uint8Array(this.mw * this.mh), color: this.colorFor(role, i) };
  }

  private colorFor(role: LayerRole, i: number): [number, number, number] {
    return role === 'bg' ? PALETTE[0] : role === 'char' ? PALETTE[1] : role === 'frame' ? PALETTE[2] : PALETTE[3 + (i % (PALETTE.length - 3))];
  }

  private snapshot(): Uint8Array[] {
    return this.layers.map((l) => l.mask.slice());
  }

  private pushUndo(): void {
    this.undo.push(this.snapshot());
    if (this.undo.length > UNDO_LIMIT) this.undo.shift();
    this.redo = [];
  }

  private restore(masks: Uint8Array[]): void {
    // A snapshot may come from before a layer was added / removed.
    if (masks.length !== this.layers.length) {
      while (this.layers.length < masks.length) this.layers.push(this.makeLayer(`mid${this.layers.length}`, `Layer ${this.layers.length - 2}`, 'mid', false, this.layers.length));
      this.layers.length = masks.length;
    }
    masks.forEach((m, i) => { this.layers[i].mask = m; });
    this.active = Math.min(this.active, this.layers.length - 1);
    this.refreshOverlay();
    this.onChange();
  }

  /** Recolour the overlay (whole image, or a dirty rectangle). */
  private refreshOverlay(x0 = 0, y0 = 0, x1 = this.mw, y1 = this.mh): void {
    const od = this.overlayData;
    if (!od) return;
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(this.mw, Math.ceil(x1)); y1 = Math.min(this.mh, Math.ceil(y1));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * this.mw + x;
      let r = 0, g = 0, b = 0, a = 0;
      for (const l of this.layers) {
        const v = l.mask[i];
        if (!v) continue;
        const w = v / 255;
        r += l.color[0] * w; g += l.color[1] * w; b += l.color[2] * w; a = Math.max(a, w);
      }
      const o = i * 4;
      const t = a > 0 ? 1 / Math.max(a, 1e-3) : 0;
      od.data[o] = Math.min(255, r * t); od.data[o + 1] = Math.min(255, g * t); od.data[o + 2] = Math.min(255, b * t);
      od.data[o + 3] = Math.round(a * 120);
    }
    this.overlay.getContext('2d')!.putImageData(od, 0, 0, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
    this.draw();
  }

  private draw(): void {
    if (this.raf || this.el.hidden) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const r = this.el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
      if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
      const g = this.canvas.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, H);
      if (!this.photo) return;
      if (!this.fitted && r.width > 0) {
        this.scale = Math.min((r.width - 24) / this.mw, (r.height - 24) / this.mh);
        this.ox = (r.width - this.mw * this.scale) / 2;
        this.oy = (r.height - this.mh * this.scale) / 2;
        this.fitted = true;
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.imageSmoothingEnabled = this.scale < 2;
      g.drawImage(this.photo, this.ox, this.oy, this.mw * this.scale, this.mh * this.scale);
      g.drawImage(this.overlay, this.ox, this.oy, this.mw * this.scale, this.mh * this.scale);
      if (this.hover && this.tool !== 'magic') {
        g.strokeStyle = 'rgba(255,255,255,0.9)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(this.hover.x, this.hover.y, this.size * this.scale, 0, Math.PI * 2);
        g.stroke();
      }
    });
  }

  private toMask(p: { x: number; y: number }) {
    return { x: (p.x - this.ox) / this.scale, y: (p.y - this.oy) / this.scale };
  }

  /** Stamp the brush at mask coordinates (x, y). */
  private stamp(x: number, y: number): void {
    const r = this.size, inner = r * (1 - Math.min(0.95, this.softness));
    const act = this.layers[this.active];
    if (!act) return;
    const erase = this.tool === 'eraser';
    const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(this.mw - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(this.mh - 1, Math.ceil(y + r));
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y);
      if (d > r) continue;
      const a = d <= inner ? 255 : Math.round(255 * (1 - (d - inner) / Math.max(1e-3, r - inner)));
      const i = yy * this.mw + xx;
      if (erase) {
        act.mask[i] = Math.min(act.mask[i], 255 - a);
      } else {
        act.mask[i] = Math.max(act.mask[i], a);
        for (const l of this.layers) if (l !== act) l.mask[i] = Math.min(l.mask[i], 255 - a);
      }
    }
    this.refreshOverlay(x0, y0, x1 + 1, y1 + 1);
  }

  private strokeTo(p: { x: number; y: number }): void {
    if (!this.stroke) return;
    const a = this.stroke.last;
    const dist = Math.hypot(p.x - a.x, p.y - a.y);
    const step = Math.max(1, this.size / 3);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let k = 1; k <= n; k++) this.stamp(a.x + ((p.x - a.x) * k) / n, a.y + ((p.y - a.y) * k) / n);
    this.stroke.last = p;
  }

  private magic(p: { x: number; y: number }): void {
    if (!this.small) return;
    const sel = magicSelect(this.small, this.depth, Math.floor(p.x), Math.floor(p.y), this.tolerance);
    this.pushUndo();
    const act = this.layers[this.active];
    for (let i = 0; i < sel.length; i++) {
      if (!sel[i]) continue;
      act.mask[i] = 255;
      for (const l of this.layers) if (l !== act) l.mask[i] = 0;
    }
    this.refreshOverlay();
    this.onChange();
  }

  private zoomAt(f: number, x: number, y: number): void {
    const s = Math.min(40, Math.max(0.05, this.scale * f));
    const k = s / this.scale;
    this.ox = x - (x - this.ox) * k;
    this.oy = y - (y - this.oy) * k;
    this.scale = s;
    this.fitted = true;
    this.draw();
  }

  private bind(): void {
    const el = this.el;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const pinchState = () => {
      const [a, b] = [...this.pointers.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    };
    el.addEventListener('pointerdown', (e) => {
      const p = local(e);
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2) {
        // Second finger: undo the stroke just started and switch to pinch.
        if (this.stroke) { this.restore(this.stroke.snapshot); this.undo.pop(); this.stroke = null; }
        this.pinch = pinchState();
        return;
      }
      if (this.pointers.size > 2) return;
      if (e.button === 1 || e.button === 2 || e.altKey) { this.panning = p; return; }
      const m = this.toMask(p);
      if (this.tool === 'magic') { this.magic(m); return; }
      const snapshot = this.snapshot();
      this.pushUndo();
      this.stroke = { last: m, snapshot };
      this.stamp(m.x, m.y);
    });
    el.addEventListener('pointermove', (e) => {
      const p = local(e);
      this.hover = e.pointerType === 'mouse' ? p : null;
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
      if (this.pinch && this.pointers.size === 2) {
        const next = pinchState();
        this.ox += next.mid.x - this.pinch.mid.x;
        this.oy += next.mid.y - this.pinch.mid.y;
        this.zoomAt(next.dist / this.pinch.dist, next.mid.x, next.mid.y);
        this.pinch = next;
        return;
      }
      if (this.panning) {
        this.ox += p.x - this.panning.x;
        this.oy += p.y - this.panning.y;
        this.panning = p;
        this.fitted = true;
        this.draw();
        return;
      }
      if (this.stroke) this.strokeTo(this.toMask(p));
      else this.draw();
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.stroke) { this.stroke = null; this.onChange(); }
      this.panning = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = local(e);
      this.zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
    }, { passive: false });
  }
}
