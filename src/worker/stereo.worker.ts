/// <reference lib="webworker" />
/**
 * Processing worker: owns the source pixels and the pipelines so the UI never
 * blocks. Hosts modules 2–7 (via StereoPipeline) and the Export Engine (9).
 */
import { encodePNG } from '../core/encode';
import { StereoPipeline } from '../core/pipeline';
import type { StereoSettings } from '../core/settings';
import type { RGBAImage } from '../core/types';
import type { WorkerRequest, WorkerResponse } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const preview = new StereoPipeline();
let exportPipeline: StereoPipeline | null = null;
let source: RGBAImage | null = null;

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'source') {
      source = { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.buffer) };
      preview.setSource(source);
      exportPipeline = null;
      post({ type: 'source-ready', id: msg.id });
    } else if (msg.type === 'render') {
      const t0 = performance.now();
      const r = preview.render(msg.settings, msg.scale);
      const buf = r.output.data.buffer as ArrayBuffer;
      post({
        type: 'rendered', id: msg.id, width: r.output.width, height: r.output.height, buffer: buf,
        info: {
          fullWidth: r.size.width, fullHeight: r.size.height, renderScale: r.renderScale,
          dx: r.dx, dy: r.dy, visible: r.visible, baseReused: r.baseReused,
          ms: performance.now() - t0, timings: r.timings,
        },
      }, [buf]);
    } else if (msg.type === 'export') {
      if (!source) throw new Error('No image loaded');
      post({ type: 'progress', id: msg.id, stage: 'Rendering full resolution…' });
      if (!exportPipeline) {
        exportPipeline = new StereoPipeline();
        exportPipeline.setSource(source);
      }
      const r = exportPipeline.render(msg.settings, 1);
      post({ type: 'progress', id: msg.id, stage: `Encoding ${msg.settings.exportFormat.toUpperCase()}…` });
      const blob = await encode(r.output, msg.settings);
      post({ type: 'exported', id: msg.id, blob, width: r.output.width, height: r.output.height });
    }
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};

async function encode(img: RGBAImage, s: StereoSettings): Promise<Blob> {
  if (s.exportFormat === 'png') {
    const bytes = encodePNG(img);
    return new Blob([bytes as BlobPart], { type: 'image/png' });
  }
  const canvas = new OffscreenCanvas(img.width, img.height);
  const c = canvas.getContext('2d');
  if (!c) throw new Error('OffscreenCanvas 2D unavailable');
  c.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  const type = s.exportFormat === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const blob = await canvas.convertToBlob({ type, quality: Math.min(1, Math.max(0.1, s.exportQuality)) });
  if (blob.type !== type) throw new Error(`${s.exportFormat.toUpperCase()} encoding is not supported in this browser.`);
  return blob;
}
