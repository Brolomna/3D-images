/** Main-thread client for the Layered 3D card worker. */
import type { CardLayers, CardSettings } from '../core/cardlayers';
import type { RGBAImage } from '../core/types';
import type { CardRequest, CardResponse } from './protocol';

export type CardProgress = { stage: string; loaded?: number; total?: number };
export interface CardResult extends Omit<CardLayers, 'info'> { info: CardLayers['info']; ms: number; model: string }

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
        const img = (r: { width: number; height: number; buffer: ArrayBuffer }): RGBAImage => ({ width: r.width, height: r.height, data: new Uint8ClampedArray(r.buffer) });
        p.resolve({ frame: img(m.frame), char: img(m.char), bg: img(m.bg), info: m.info, ms: m.ms, model: m.model });
      };
      this.worker.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'Card worker failed'));
        this.pending.clear();
      };
    }
    return this.worker;
  }

  split(card: RGBAImage, bg: RGBAImage | null, settings: CardSettings, onProgress?: (p: CardProgress) => void): Promise<CardResult> {
    const id = this.nextId++;
    const c = card.data.slice(), b = bg ? bg.data.slice() : null;
    const msg: CardRequest = {
      type: 'split', id, settings: JSON.parse(JSON.stringify(settings)),
      card: { width: card.width, height: card.height, buffer: c.buffer },
      bg: bg && b ? { width: bg.width, height: bg.height, buffer: b.buffer } : null,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.ensure().postMessage(msg, b ? [c.buffer, b.buffer] : [c.buffer]);
    });
  }
}
