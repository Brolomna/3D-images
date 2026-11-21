/** Main-thread client for the processing worker, with render coalescing. */
import type { DepthMap } from '../core/depth';
import type { StereoSettings } from '../core/settings';
import type { RGBAImage } from '../core/types';
import type { RawDepth, RenderInfo, WorkerRequest, WorkerResponse } from './protocol';

export interface RenderOutput {
  left: RGBAImage;
  right: RGBAImage;
  depth: RGBAImage | null;
  info: RenderInfo;
}

export type ExportResult = Extract<WorkerResponse, { type: 'exported' }>;
type Pending = { resolve: (v: never) => void; reject: (e: Error) => void; onProgress?: (s: string) => void };

function rawDepth(d: DepthMap | null): RawDepth | null {
  if (!d) return null;
  const copy = d.data.slice();
  return { width: d.width, height: d.height, buffer: copy.buffer };
}

export class StereoWorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private rendering = false;
  private queued: { settings: StereoSettings; scale: number; includeDepth: boolean } | null = null;
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

  /** True when no preview render is running or queued. */
  get idle(): boolean {
    return !this.rendering && !this.queued;
  }

  async setSource(img: RGBAImage): Promise<void> {
    const copy = img.data.slice();
    this.queued = null;
    await this.call({ type: 'source', id: this.nextId++, width: img.width, height: img.height, buffer: copy.buffer }, [copy.buffer]);
  }

  async setDepth(d: DepthMap | null): Promise<void> {
    const depth = rawDepth(d);
    await this.call({ type: 'depth', id: this.nextId++, depth }, depth ? [depth.buffer] : []);
  }

  /** Request a preview render. Only the latest request is processed when busy. */
  requestRender(settings: StereoSettings, scale: number, includeDepth: boolean): void {
    this.queued = { settings: JSON.parse(JSON.stringify(settings)), scale, includeDepth };
    if (!this.rendering) void this.pump();
  }

  private async pump() {
    while (this.queued) {
      const job = this.queued;
      this.queued = null;
      this.rendering = true;
      try {
        const r = await this.call<Extract<WorkerResponse, { type: 'rendered' }>>({ type: 'render', id: this.nextId++, ...job });
        const img = (b: ArrayBuffer): RGBAImage => ({ width: r.eyeW, height: r.eyeH, data: new Uint8ClampedArray(b) });
        this.onRender({ left: img(r.left), right: img(r.right), depth: r.depth ? img(r.depth) : null, info: r.info });
      } catch (e) {
        this.onError((e as Error).message);
      } finally {
        this.rendering = false;
      }
    }
  }

  exportImage(settings: StereoSettings, onProgress: (s: string) => void): Promise<ExportResult> {
    return this.call<ExportResult>({ type: 'export', id: this.nextId++, settings: JSON.parse(JSON.stringify(settings)) }, [], onProgress);
  }

  /** Export a different image (batch mode) without touching the loaded one. */
  exportItem(settings: StereoSettings, img: RGBAImage, depth: DepthMap | null, onProgress: (s: string) => void): Promise<ExportResult> {
    const copy = img.data.slice();
    const d = rawDepth(depth);
    const transfer: Transferable[] = [copy.buffer];
    if (d) transfer.push(d.buffer);
    return this.call<ExportResult>({
      type: 'export', id: this.nextId++, settings: JSON.parse(JSON.stringify(settings)),
      item: { width: img.width, height: img.height, buffer: copy.buffer, depth: d },
    }, transfer, onProgress);
  }
}
