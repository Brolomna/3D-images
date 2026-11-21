/** Main-thread client for the processing worker, with render coalescing. */
import type { StereoSettings } from '../core/settings';
import type { RGBAImage } from '../core/types';
import type { RenderInfo, WorkerRequest, WorkerResponse } from './protocol';

export interface RenderOutput {
  image: ImageData;
  info: RenderInfo;
}

type Pending = { resolve: (v: never) => void; reject: (e: Error) => void; onProgress?: (s: string) => void };

export class StereoWorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private rendering = false;
  private queued: { settings: StereoSettings; scale: number } | null = null;
  onRender: (out: RenderOutput) => void = () => {};
  onError: (msg: string) => void = () => {};

  constructor() {
    this.worker = new Worker(new URL('./stereo.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.handle(ev.data);
    this.worker.onerror = (ev) => this.onError(ev.message || 'Worker error');
  }

  private call<T>(msg: WorkerRequest, transfer: Transferable[] = [], onProgress?: (s: string) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(msg.id, { resolve: resolve as (v: never) => void, reject, onProgress });
      this.worker.postMessage(msg, transfer);
    });
  }

  private handle(msg: WorkerResponse) {
    const p = this.pending.get(msg.id);
    if (msg.type === 'progress') {
      p?.onProgress?.(msg.stage);
      return;
    }
    this.pending.delete(msg.id);
    if (!p) return;
    if (msg.type === 'error') p.reject(new Error(msg.message));
    else p.resolve(msg as never);
  }

  async setSource(img: RGBAImage): Promise<void> {
    const copy = img.data.slice();
    this.queued = null;
    await this.call({ type: 'source', id: this.nextId++, width: img.width, height: img.height, buffer: copy.buffer }, [copy.buffer]);
  }

  /** True when no preview render is running or queued. */
  get idle(): boolean {
    return !this.rendering && !this.queued;
  }

  /** Request a preview render. Only the latest request is processed when busy. */
  requestRender(settings: StereoSettings, scale: number): void {
    this.queued = { settings: JSON.parse(JSON.stringify(settings)), scale };
    if (!this.rendering) void this.pump();
  }

  private async pump() {
    while (this.queued) {
      const job = this.queued;
      this.queued = null;
      this.rendering = true;
      try {
        const r = await this.call<Extract<WorkerResponse, { type: 'rendered' }>>({ type: 'render', id: this.nextId++, settings: job.settings, scale: job.scale });
        const image = new ImageData(new Uint8ClampedArray(r.buffer), r.width, r.height);
        this.onRender({ image, info: r.info });
      } catch (e) {
        this.onError((e as Error).message);
      } finally {
        this.rendering = false;
      }
    }
  }

  async exportImage(settings: StereoSettings, onProgress: (s: string) => void) {
    return this.call<Extract<WorkerResponse, { type: 'exported' }>>({ type: 'export', id: this.nextId++, settings: JSON.parse(JSON.stringify(settings)) }, [], onProgress);
  }
}
