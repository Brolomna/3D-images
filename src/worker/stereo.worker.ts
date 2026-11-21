/// <reference lib="webworker" />
/**
 * Processing worker: owns the source pixels, depth map and pipelines so the
 * UI never blocks. Hosts modules 2–7 (via StereoPipeline) and the Export
 * Engine (module 9) for every output format.
 */
import type { DepthMap } from '../core/depth';
import { encodePNG } from '../core/encode';
import { encodeGif } from '../core/gif';
import { resolveOutputSize } from '../core/layout';
import { assembleMPO } from '../core/mpo';
import { StereoPipeline } from '../core/pipeline';
import type { StereoSettings } from '../core/settings';
import type { RGBAImage } from '../core/types';
import type { RawDepth, WorkerRequest, WorkerResponse } from './protocol';
import { encodeWiggleVideo } from './video';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const preview = new StereoPipeline();
let exportPipeline: StereoPipeline | null = null;
let source: RGBAImage | null = null;
let depth: DepthMap | null = null;

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

const toDepth = (d: RawDepth | null): DepthMap | null => (d ? { width: d.width, height: d.height, data: new Float32Array(d.buffer) } : null);

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'source') {
      source = { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.buffer) };
      depth = null;
      preview.setSource(source);
      exportPipeline = null;
      post({ type: 'ok', id: msg.id });
    } else if (msg.type === 'depth') {
      depth = toDepth(msg.depth);
      preview.setDepth(depth);
      exportPipeline?.setDepth(depth);
      post({ type: 'ok', id: msg.id });
    } else if (msg.type === 'render') {
      const t0 = performance.now();
      const r = preview.render(msg.settings, msg.scale, { compose: false, includeDepth: msg.includeDepth });
      const left = r.left.data.buffer as ArrayBuffer;
      const right = (r.right === r.left ? r.right.data.slice() : r.right.data).buffer as ArrayBuffer;
      const dbuf = r.depth ? (r.depth.data.buffer as ArrayBuffer) : null;
      post({
        type: 'rendered', id: msg.id, eyeW: r.left.width, eyeH: r.left.height, left, right, depth: dbuf,
        info: {
          fullWidth: r.size.width, fullHeight: r.size.height, eyeWidth: r.size.eyeWidth, eyeHeight: r.size.eyeHeight,
          renderScale: r.renderScale, dx: r.dx, dy: r.dy, depthUsed: r.depthUsed, visible: r.visible,
          baseReused: r.baseReused, ms: performance.now() - t0, timings: r.timings,
        },
      }, dbuf ? [left, right, dbuf] : [left, right]);
    } else if (msg.type === 'export') {
      let pipeline: StereoPipeline;
      if (msg.item) {
        pipeline = new StereoPipeline();
        pipeline.setSource({ width: msg.item.width, height: msg.item.height, data: new Uint8ClampedArray(msg.item.buffer) });
        pipeline.setDepth(toDepth(msg.item.depth));
      } else {
        if (!source) throw new Error('No image loaded');
        if (!exportPipeline) {
          exportPipeline = new StereoPipeline();
          exportPipeline.setSource(source);
          exportPipeline.setDepth(depth);
        }
        pipeline = exportPipeline;
      }
      const progress = (stage: string) => post({ type: 'progress', id: msg.id, stage });
      const out = await exportFormat(pipeline, msg.settings, progress);
      post({ type: 'exported', id: msg.id, ...out });
    }
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};

async function encodeCanvas(img: RGBAImage, type: 'image/jpeg' | 'image/webp', quality: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const c = canvas.getContext('2d');
  if (!c) throw new Error('OffscreenCanvas 2D unavailable');
  c.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  const blob = await canvas.convertToBlob({ type, quality: Math.min(1, Math.max(0.1, quality)) });
  if (blob.type !== type) throw new Error(`${type} encoding is not supported in this browser.`);
  return blob;
}

async function exportFormat(p: StereoPipeline, s: StereoSettings, progress: (s: string) => void) {
  const size = resolveOutputSize(s.output, s.format);
  progress('Rendering full resolution…');
  if (s.format === 'wiggle') {
    const frames = p.renderWiggleFrames(s, s.wiggleFrames, 1);
    if (s.wiggleFile === 'gif') {
      progress('Encoding GIF…');
      const bytes = encodeGif(frames, s.wiggleFrameMs);
      return { blob: new Blob([bytes as BlobPart], { type: 'image/gif' }), ext: 'gif', width: size.width, height: size.height };
    }
    progress('Encoding video…');
    const blob = await encodeWiggleVideo(frames, s.wiggleFrameMs);
    return { blob, ext: blob.type === 'video/mp4' ? 'mp4' : 'webm', width: size.width, height: size.height };
  }
  if (s.format === 'mpo') {
    const r = p.render(s, 1, { compose: false });
    progress('Encoding MPO…');
    const [l, rr] = await Promise.all([
      encodeCanvas(r.left, 'image/jpeg', s.exportQuality),
      encodeCanvas(r.right, 'image/jpeg', s.exportQuality),
    ]);
    const bytes = assembleMPO(new Uint8Array(await l.arrayBuffer()), new Uint8Array(await rr.arrayBuffer()));
    return { blob: new Blob([bytes as BlobPart], { type: 'image/mpo' }), ext: 'mpo', width: size.width, height: size.height };
  }
  const r = p.render(s, 1);
  progress(`Encoding ${s.exportFormat.toUpperCase()}…`);
  let blob: Blob;
  if (s.exportFormat === 'png') blob = new Blob([encodePNG(r.output) as BlobPart], { type: 'image/png' });
  else blob = await encodeCanvas(r.output, s.exportFormat === 'jpeg' ? 'image/jpeg' : 'image/webp', s.exportQuality);
  const ext = s.exportFormat === 'jpeg' ? 'jpg' : s.exportFormat;
  return { blob, ext, width: r.output.width, height: r.output.height };
}
