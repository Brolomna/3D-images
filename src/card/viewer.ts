/**
 * Live tilt viewer for a Layered 3D card (the Howlfall parallax recipe).
 *
 * The card itself never moves. Inside the window box (overflow hidden) the
 * background and the character slide by different amounts; the frame sits
 * on top, still. Driven by the device's gyroscope (gravity vector with a
 * slowly re-centring rest pose), with mouse / finger drag as the fallback.
 * Tapping the card re-centres it.
 */
export interface ViewerLayers {
  frame: string; // image URLs
  char: string;
  bg: string;
  win: { x: number; y: number; w: number; h: number };
  size: [number, number];
}

/** Movement at full tilt, as % of each layer's own size. */
export const PARALLAX = { bg: { x: 8, y: 6 }, char: { x: 4, y: 2.4 } };

export class CardViewer {
  readonly el: HTMLDivElement;
  private card: HTMLDivElement;
  private bg: HTMLImageElement;
  private char: HTMLImageElement;
  private frame: HTMLImageElement;
  private motionBtn: HTMLButtonElement;
  private x = 0; private y = 0; // current (smoothed) tilt −1..1
  private tx = 0; private ty = 0; // target tilt
  private grav: [number, number] | null = null;
  private rest: [number, number] | null = null;
  private gyroOn = false;
  private dragging: { x0: number; y0: number; tx: number; ty: number } | null = null;
  private last = 0;
  private aspect = 941 / 1672;
  private raf = 0;
  private ro: ResizeObserver;

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'card-viewer';
    this.el.innerHTML = `
      <div class="card3d">
        <div class="card3d-win"><img class="card3d-bg" alt="" draggable="false"><img class="card3d-char" alt="" draggable="false"></div>
        <img class="card3d-frame" alt="" draggable="false">
      </div>
      <p class="card3d-msg"></p>
      <button class="btn small card3d-motion" type="button">✨ Turn on motion</button>`;
    host.appendChild(this.el);
    this.card = this.el.querySelector('.card3d')!;
    this.bg = this.el.querySelector('.card3d-bg')!;
    this.char = this.el.querySelector('.card3d-char')!;
    this.frame = this.el.querySelector('.card3d-frame')!;
    this.motionBtn = this.el.querySelector('.card3d-motion')!;
    this.motionBtn.addEventListener('click', () => void this.enableMotion());
    this.bindPointer();
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(host);
    const hasGyro = typeof DeviceOrientationEvent !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    this.motionBtn.hidden = !hasGyro;
  }

  /** Text shown instead of the card (e.g. before the first split). */
  setMessage(text: string): void {
    const m = this.el.querySelector<HTMLElement>('.card3d-msg')!;
    m.textContent = text;
    m.hidden = !text;
  }

  /** Show a split card. */
  setLayers(l: ViewerLayers | null): void {
    this.el.classList.toggle('empty', !l);
    if (!l) return;
    const { win } = l;
    this.aspect = l.size[0] / l.size[1];
    this.card.style.aspectRatio = `${l.size[0]} / ${l.size[1]}`;
    const box = this.card.querySelector<HTMLDivElement>('.card3d-win')!;
    Object.assign(box.style, { left: `${win.x * 100}%`, top: `${win.y * 100}%`, width: `${win.w * 100}%`, height: `${win.h * 100}%` });
    // Character: the full card, positioned relative to the window.
    Object.assign(this.char.style, { left: `${(-win.x / win.w) * 100}%`, top: `${(-win.y / win.h) * 100}%`, width: `${100 / win.w}%`, height: `${100 / win.h}%` });
    this.bg.src = l.bg; this.char.src = l.char; this.frame.src = l.frame;
    this.fit();
    this.start();
  }

  setVisible(on: boolean): void {
    this.el.hidden = !on;
    if (on) {
      this.fit();
      this.start();
    } else {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private fit() {
    const host = this.el.parentElement;
    if (!host) return;
    const r = host.getBoundingClientRect();
    const ar = this.aspect;
    const pad = 24;
    const w = Math.min(r.width - pad * 2, (r.height - pad * 2 - 44) * ar);
    this.card.style.width = `${Math.max(80, w)}px`;
  }

  private async enableMotion() {
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    try {
      if (typeof DOE.requestPermission === 'function') {
        const res = await DOE.requestPermission(); // iOS: must come from a tap
        if (res !== 'granted') return;
      }
    } catch { return; }
    if (!this.gyroOn) window.addEventListener('deviceorientation', this.onOrient);
    this.gyroOn = true;
    this.motionBtn.hidden = true;
  }

  private onOrient = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null) return;
    const b = (e.beta * Math.PI) / 180, g = (e.gamma * Math.PI) / 180;
    let gx = -Math.cos(b) * Math.sin(g), gy = Math.sin(b);
    const ang = ((screen.orientation?.angle ?? 0) * Math.PI) / 180;
    const c = Math.cos(ang), s = Math.sin(ang);
    [gx, gy] = [gx * c + gy * s, -gx * s + gy * c];
    this.grav = [gx, gy];
    if (!this.rest) this.rest = [gx, gy];
  };

  private bindPointer() {
    const el = this.card;
    let moved = false;
    el.addEventListener('pointerdown', (e) => {
      moved = false;
      this.dragging = { x0: e.clientX, y0: e.clientY, tx: this.tx, ty: this.ty };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      if (this.dragging) {
        const dx = (e.clientX - this.dragging.x0) / (r.width / 2), dy = (e.clientY - this.dragging.y0) / (r.height / 2);
        if (Math.abs(dx) + Math.abs(dy) > 0.03) moved = true;
        this.tx = clamp(this.dragging.tx + dx);
        this.ty = clamp(this.dragging.ty + dy);
      } else if (e.pointerType === 'mouse' && !this.gyroOn) {
        // Hover with a mouse tilts towards the pointer.
        this.tx = clamp(((e.clientX - r.left) / r.width - 0.5) * 2);
        this.ty = clamp(((e.clientY - r.top) / r.height - 0.5) * 2);
      }
    });
    const up = (e: PointerEvent) => {
      if (this.dragging && !moved) { this.tx = this.ty = 0; this.rest = this.grav; } // tap re-centres
      this.dragging = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !this.dragging && !this.gyroOn) this.tx = this.ty = 0; });
  }

  private start() {
    if (this.raf) return;
    this.last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (this.gyroOn && this.grav && this.rest && !this.dragging) {
        // Rest pose re-centres slowly; tilt relative to it drives the layers.
        this.rest = [this.rest[0] + (this.grav[0] - this.rest[0]) * dt * 0.35, this.rest[1] + (this.grav[1] - this.rest[1]) * dt * 0.35];
        let dx = (this.grav[0] - this.rest[0]) / 0.26, dy = (this.grav[1] - this.rest[1]) / 0.26;
        if (Math.abs(dx) < 0.03) dx = 0;
        if (Math.abs(dy) < 0.03) dy = 0;
        this.tx = Math.tanh(1.15 * dx);
        this.ty = -Math.tanh(1.15 * dy);
      }
      const k = 1 - Math.exp(-dt / 0.09);
      this.x += (this.tx - this.x) * k;
      this.y += (this.ty - this.y) * k;
      this.bg.style.transform = `translate3d(${(-this.x * PARALLAX.bg.x).toFixed(3)}%, ${(-this.y * PARALLAX.bg.y).toFixed(3)}%, 0)`;
      this.char.style.transform = `translate3d(${(-this.x * PARALLAX.char.x).toFixed(3)}%, ${(-this.y * PARALLAX.char.y).toFixed(3)}%, 0)`;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}

function clamp(v: number) {
  return Math.max(-1, Math.min(1, v));
}
