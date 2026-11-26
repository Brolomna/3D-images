/** Main-thread client for the Layered 3D card worker. */
import type { CardSettings } from '../core/cardlayers';
import type { AutoSettings, CardStack, PaintLayer } from '../core/cardstack';
import type { DepthMap } from '../core/depth';
import type { RGBAImage } from '../core/types';
import type { CardRequest, CardResponse } from './protocol';

export type CardProgress = { stage: string; loaded?: number; total?: number };
export interface CardResult { stack: CardStack; ms: number; model: string | null }

export class CardClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: CardResult) => void; reject: (e: Error) => void; onProgress?: (p: CardProgress) => void }>();

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./card.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<CardResponse>) => {
        const m = ev.data;
        const p = this.pending.get(m.id);
        if (!p) return;
        if (m.type === 'progress') { p.onProgress?.(m); return; }
        this.pending.delete(m.id);
        if (m.type === 'error') { p.reject(new Error(m.message)); return; }
        const layers = m.stack.layers.map((l) => ({
          ...l, image: { width: l.image.width, height: l.image.height, data: new Uint8ClampedArray(l.image.buffer) } as RGBAImage,
        }));
        p.resolve({ stack: { ...m.stack, layers }, ms: m.ms, model: m.model });
      };
      this.worker.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'Card worker failed'));
        this.pending.clear();
      };
    }
    return this.worker;
  }

  private send(msg: CardRequest, transfer: Transferable[], onProgress?: (p: CardProgress) => void): Promise<CardResult> {
    return new Promise((resolve, reject) => {
      this.pending.set(msg.id, { resolve, reject, onProgress });
      this.ensure().postMessage(msg, transfer);
    });
  }

  /** ✨ Auto split; `key` identifies the card so the cut-out is reused across threshold changes. */
  auto(key: string, card: RGBAImage, bg: RGBAImage | null, depth: DepthMap | null, settings: CardSettings, auto: AutoSettings, onProgress?: (p: CardProgress) => void): Promise<CardResult> {
    const c = card.data.slice(), b = bg ? bg.data.slice() : null, d = depth ? depth.data.slice() : null;
    const transfer: Transferable[] = [c.buffer];
    if (b) transfer.push(b.buffer);
    if (d) transfer.push(d.buffer);
    return this.send({
      type: 'auto', id: this.nextId++, key, settings: JSON.parse(JSON.stringify(settings)), auto: { ...auto },
      card: { width: card.width, height: card.height, buffer: c.buffer },
      bg: bg && b ? { width: bg.width, height: bg.height, buffer: b.buffer } : null,
      depth: depth && d ? { width: depth.width, height: depth.height, buffer: d.buffer } : null,
    }, transfer, onProgress);
  }

  /** ✏️ Build from painted masks. */
  manual(card: RGBAImage, layers: PaintLayer[], mw: number, mh: number, depth: DepthMap | null, settings: CardSettings): Promise<CardResult> {
    const c = card.data.slice(), d = depth ? depth.data.slice() : null;
    const masks = layers.map((l) => ({ id: l.id, name: l.name, role: l.role, still: l.still, mask: l.mask.slice().buffer as ArrayBuffer }));
    const transfer: Transferable[] = [c.buffer, ...masks.map((m) => m.mask)];
    if (d) transfer.push(d.buffer);
    return this.send({
      type: 'manual', id: this.nextId++, settings: JSON.parse(JSON.stringify(settings)), mw, mh, layers: masks,
      card: { width: card.width, height: card.height, buffer: c.buffer },
      depth: depth && d ? { width: depth.width, height: depth.height, buffer: d.buffer } : null,
    }, transfer);
  }
}
