/** Main-thread client for the depth-estimation worker. */
import type { DepthMap } from '../core/depth';
import type { RGBAImage } from '../core/types';
import { DEPTH_INPUT_MAX_SIDE, type DepthRequest, type DepthResponse } from './protocol';

export type DepthProgress = { stage: string; loaded?: number; total?: number };

export class DepthClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (d: DepthMap) => void; reject: (e: Error) => void; onProgress?: (p: DepthProgress) => void }>();

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./depth.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<DepthResponse>) => {
        const m = ev.data;
        const p = this.pending.get(m.id);
        if (!p) return;
        if (m.type === 'progress') { p.onProgress?.(m); return; }
        this.pending.delete(m.id);
        if (m.type === 'error') p.reject(new Error(m.message));
        else p.resolve({ width: m.width, height: m.height, data: new Float32Array(m.buffer) });
      };
      this.worker.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'Depth worker failed'));
        this.pending.clear();
      };
    }
    return this.worker;
  }

  /** Estimate a relative inverse-depth map (larger = nearer) for an image. */
  estimate(img: RGBAImage, onProgress?: (p: DepthProgress) => void): Promise<DepthMap> {
    const small = downscale(img, DEPTH_INPUT_MAX_SIDE);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      const msg: DepthRequest = { type: 'estimate', id, width: small.width, height: small.height, buffer: small.data.buffer as ArrayBuffer };
      this.ensure().postMessage(msg, [msg.buffer]);
    });
  }
}

/** Area-average downscale (copy when already small). */
function downscale(img: RGBAImage, maxSide: number): RGBAImage {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (s === 1) return { width: img.width, height: img.height, data: img.data.slice() };
  const w = Math.max(1, Math.round(img.width * s));
  const h = Math.max(1, Math.round(img.height * s));
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(new ImageData(img.data.slice(), img.width, img.height), 0, 0);
  const d = new OffscreenCanvas(w, h);
  const g = d.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, 0, 0, w, h);
  return { width: w, height: h, data: g.getImageData(0, 0, w, h).data };
}
