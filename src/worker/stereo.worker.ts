/// <reference lib="webworker" />
/**
 * Processing worker: owns the source pixels, depth map and pipelines so the
 * UI never blocks. Hosts modules 2–7 (via StereoPipeline) and the Export
 * Engine (module 9) for every output format.
 */
import type { DepthMap } from '../core/depth';
import { encodePNG } from '../core/encode';
import { buildPalette, encodeGif, encodeGifStream } from '../core/gif';
import { motionTiming } from '../core/motion';
import { resolveOutputSize } from '../core/layout';
import { assembleMPO } from '../core/mpo';
import { buildScene, downscale, type SceneResult, type SceneSettings } from '../core/scene';
import { StereoPipeline } from '../core/pipeline';
import type { StereoSettings } from '../core/settings';
import type { RGBAImage } from '../core/types';
import type { RawDepth, WorkerRequest, WorkerResponse } from './protocol';
import { encodeVideo, encodeWiggleVideo } from './video';
import { cutout, depthPng, frameName, normaliseRaw, png, resizeDepth, type Part } from '../core/parts';
import type { PartsKind } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const preview = new StereoPipeline();
let exportPipeline: StereoPipeline | null = null;
let source: RGBAImage | null = null;
let depth: DepthMap | null = null;
let texture: RGBAImage | null = null;
let scene: SceneSettings | null = null;
let sceneBg: { image: RGBAImage; depth: DepthMap } | null = null;
let sceneApplied = false;

/**
 * Point the pipelines at the right source: the original photo + model depth,
 * or the 3D Scene composite + its normalised depth. Returns a small preview
 * of the composite when a scene is applied.
 */
function applyScene(): { applied: boolean; preview: RGBAImage | null } {
  if (!source) return { applied: false, preview: null };
  if (scene?.enabled && depth) {
    const r = buildScene(source, depth, scene, sceneBg);
    preview.setSource(r.image);
    preview.setDepth(r.depth, true);
    preview.setCustomTexture(texture);
    exportPipeline = null;
    exportSource = r;
    sceneApplied = true;
    return { applied: true, preview: downscale(r.image, 1600) };
  }
  if (sceneApplied) {
    preview.setSource(source);
    preview.setCustomTexture(texture);
    exportPipeline = null;
    sceneApplied = false;
  }
  exportSource = null;
  preview.setDepth(depth);
  exportPipeline?.setDepth(depth);
  return { applied: false, preview: null };
}
let exportSource: SceneResult | null = null;

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
      preview.setCustomTexture(texture);
      sceneApplied = false;
      exportSource = null;
      exportPipeline = null;
      post({ type: 'ok', id: msg.id });
    } else if (msg.type === 'depth') {
      depth = toDepth(msg.depth);
      applyScene();
      post({ type: 'ok', id: msg.id });
    } else if (msg.type === 'scene' || msg.type === 'scene-bg') {
      if (msg.type === 'scene') scene = msg.scene;
      else sceneBg = msg.bg ? {
        image: { width: msg.bg.width, height: msg.bg.height, data: new Uint8ClampedArray(msg.bg.buffer) },
        depth: toDepth(msg.bg.depth)!,
      } : null;
      const t0 = performance.now();
      const r = msg.type === 'scene' || scene?.enabled ? applyScene() : { applied: sceneApplied, preview: null };
      const buf = r.preview ? (r.preview.data.slice().buffer as ArrayBuffer) : null;
      post({
        type: 'scene-ready', id: msg.id, applied: r.applied, ms: performance.now() - t0,
        preview: r.preview && buf ? { width: r.preview.width, height: r.preview.height, buffer: buf } : null,
      }, buf ? [buf] : []);
    } else if (msg.type === 'texture') {
      texture = msg.texture ? { width: msg.texture.width, height: msg.texture.height, data: new Uint8ClampedArray(msg.texture.buffer) } : null;
      preview.setCustomTexture(texture);
      exportPipeline?.setCustomTexture(texture);
      post({ type: 'ok', id: msg.id });
    } else if (msg.type === 'render') {
      const t0 = performance.now();
      const r = preview.render(msg.settings, msg.scale, { compose: false, includeDepth: msg.includeDepth });
      const left = r.left.data.buffer as ArrayBuffer;
      const right = (r.right === r.left ? r.right.data.slice() : r.right.data).buffer as ArrayBuffer;
      let special: { width: number; height: number; buffer: ArrayBuffer; hasDepth: boolean; sketch: ArrayBuffer | null } | null = null;
      let depthImg = r.depth;
      if (msg.settings.format === 'stereogram') {
        const st = preview.renderStereogram(msg.settings, msg.scale);
        special = {
          width: st.image.width, height: st.image.height, buffer: st.image.data.buffer as ArrayBuffer, hasDepth: st.hasDepth,
          sketch: st.sketch ? (st.sketch.data.buffer as ArrayBuffer) : null,
        };
        if (msg.includeDepth) depthImg = st.depth ?? undefined; // show the hidden shape
      }
      const dbuf = depthImg ? (depthImg.data.buffer as ArrayBuffer) : null;
      let motion: { width: number; height: number; frames: ArrayBuffer[]; hasDepth: boolean } | null = null;
      if (msg.motion && msg.settings.format === 'motion') {
        const m = preview.motionRenderer(msg.settings, msg.motion.scale);
        const n = Math.max(2, msg.motion.frames);
        const frames = m.hasDepth
          ? Array.from({ length: n }, (_, i) => m.frame(i / n).data.buffer as ArrayBuffer)
          : [m.frame(0).data.buffer as ArrayBuffer];
        motion = { width: m.width, height: m.height, frames, hasDepth: m.hasDepth };
      }
      const transfer: Transferable[] = [left, right, ...(dbuf ? [dbuf] : []), ...(motion?.frames ?? []), ...(special ? [special.buffer] : []), ...(special?.sketch ? [special.sketch] : [])];
      post({
        motion,
        special,
        type: 'rendered', id: msg.id, eyeW: r.left.width, eyeH: r.left.height, left, right, depth: dbuf,
        info: {
          fullWidth: r.size.width, fullHeight: r.size.height, eyeWidth: r.size.eyeWidth, eyeHeight: r.size.eyeHeight,
          renderScale: r.renderScale, dx: r.dx, dy: r.dy, depthUsed: r.depthUsed, visible: r.visible,
          baseReused: r.baseReused, ms: performance.now() - t0, timings: r.timings,
        },
      }, transfer);
    } else if (msg.type === 'parts') {
      const files = await buildParts(msg.settings, msg.kind, (stage) => post({ type: 'progress', id: msg.id, stage }));
      const out = files.map((f) => ({ name: f.name, bytes: f.bytes.slice().buffer as ArrayBuffer }));
      post({ type: 'parts-ready', id: msg.id, files: out }, out.map((f) => f.bytes));
    } else if (msg.type === 'export') {
      let pipeline: StereoPipeline;
      const progress = (stage: string) => post({ type: 'progress', id: msg.id, stage });
      if (msg.item) {
        pipeline = new StereoPipeline();
        const itemSrc = { width: msg.item.width, height: msg.item.height, data: new Uint8ClampedArray(msg.item.buffer) };
        const itemDepth = toDepth(msg.item.depth);
        if (msg.settings.scene?.enabled && itemDepth) {
          progress('Building 3D scene…');
          const r = buildScene(itemSrc, itemDepth, msg.settings.scene, sceneBg);
          pipeline.setSource(r.image);
          pipeline.setDepth(r.depth, true);
        } else {
          pipeline.setSource(itemSrc);
          pipeline.setDepth(itemDepth);
        }
        pipeline.setCustomTexture(texture);
      } else {
        pipeline = fullPipeline();
      }
      const out = await exportFormat(pipeline, msg.settings, progress);
      post({ type: 'exported', id: msg.id, ...out });
    }
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};

/** Full-resolution export pipeline for the current photo (or scene). */
function fullPipeline(): StereoPipeline {
  if (!source) throw new Error('No image loaded');
  if (!exportPipeline) {
    exportPipeline = new StereoPipeline();
    if (exportSource) {
      exportPipeline.setSource(exportSource.image);
      exportPipeline.setDepth(exportSource.depth, true);
    } else {
      exportPipeline.setSource(source);
      exportPipeline.setDepth(depth);
    }
    exportPipeline.setCustomTexture(texture);
  }
  return exportPipeline;
}

/** The pictures behind each style, as separate files. */
async function buildParts(s: StereoSettings, kind: PartsKind, progress: (stage: string) => void): Promise<Part[]> {
  const p = fullPipeline();
  const files: Part[] = [];
  const all = kind === 'all';
  const stereo = s.format !== 'motion' && s.format !== 'stereogram' && s.format !== 'card';
  if (kind === 'views' || (all && stereo)) {
    progress('Rendering the eye views…');
    const r = p.render(s, 1, { compose: false });
    files.push(png('left.png', r.left), png('right.png', r.right));
    if (all && s.format !== 'wiggle' && s.format !== 'mpo') files.push(png(`output_${s.format}.png`, p.render(s, 1).output));
  }
  if (kind === 'depthmap') {
    progress('Preparing the depth map…');
    const framed = p.framedDepth(s, 1);
    if (!framed) throw new Error('The depth map is not ready yet.');
    files.push(depthPng('depth_map.png', framed));
  }
  if (kind === 'depth' || all) {
    progress('Preparing the depth maps…');
    const framed = p.framedDepth(s, 1);
    const d = p.getDepth();
    if (!framed || !d) throw new Error('The depth map is not ready yet.');
    files.push(depthPng('depth.png', framed));
    const src = p.getSource()!;
    const full = d.normalized ? d.map : normaliseRaw(d.map);
    files.push(depthPng('depth_full_photo.png', resizeDepth(full, src.width, src.height)));
  }
  if ((kind === 'frames' || all) && s.format === 'wiggle') {
    progress('Rendering the wiggle frames…');
    const frames = p.renderWiggleFrames(s, s.wiggleFrames, 1);
    frames.forEach((f, i) => files.push(png(frameName('wiggle_frame', i, frames.length), f)));
  }
  if ((kind === 'frames' || all) && s.format === 'motion') {
    const m = p.motionRenderer(s, 1);
    if (!m.hasDepth) throw new Error('The depth map is not ready yet.');
    const { count } = motionTiming(s.motion);
    for (let i = 0; i < count; i++) {
      if (i % 5 === 0) progress(`Rendering motion frames ${i + 1}/${count}…`);
      files.push(png(frameName('motion_frame', i, count), m.frame(i / count)));
    }
  }
  if (all && s.format === 'stereogram') {
    progress('Rendering the stereogram parts…');
    const st = p.renderStereogram(s, 1);
    files.push(png('stereogram.png', st.image));
    if (st.sketch) files.push(png('stereogram_sketch.png', st.sketch));
    if (st.shape) files.push(depthPng('stereogram_hidden_shape.png', st.shape));
  }
  if (all && exportSource && source) {
    progress('Adding the 3D Scene parts…');
    files.push(png('scene_photo.png', exportSource.image));
    files.push(png('scene_subject_cutout.png', cutout(source, exportSource.alpha)));
    files.push(png('scene_background.png', exportSource.background));
    files.push(depthPng('scene_depth.png', exportSource.depth));
  }
  return files;
}

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
  if (s.format === 'motion') {
    const m = p.motionRenderer(s, 1);
    if (!m.hasDepth) throw new Error('The 3D photo motion needs the depth map, which is not available yet.');
    const { count, frameMs } = motionTiming(s.motion);
    const pct = (i: number) => `${Math.round((100 * i) / count)}%`;
    if (s.motion.file === 'gif') {
      progress('Building colour palette…');
      const palette = buildPalette([0, 0.25, 0.5, 0.75].map((t) => m.frame(t)));
      const bytes = encodeGifStream(count, (i) => m.frame(i / count), frameMs, palette, (i) => {
        if (i % 3 === 0) progress(`Encoding GIF ${pct(i + 1)}…`);
      });
      return { blob: new Blob([bytes as BlobPart], { type: 'image/gif' }), ext: 'gif', width: m.width, height: m.height };
    }
    const blob = await encodeVideo(m.width, m.height, frameMs, count, (i) => m.frame(i / count), 0, (done, total) => {
      if (done % 3 === 0) progress(`Rendering video ${Math.round((100 * done) / total)}%…`);
    });
    return { blob, ext: blob.type === 'video/mp4' ? 'mp4' : 'webm', width: m.width, height: m.height };
  }
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
  let r: { output: RGBAImage };
  if (s.format === 'stereogram') {
    const st = p.renderStereogram(s, 1);
    if (!st.hasDepth) throw new Error('The stereogram needs the depth map, which is not available yet.');
    r = { output: st.image };
  } else {
    r = p.render(s, 1);
  }
  progress(`Encoding ${s.exportFormat.toUpperCase()}…`);
  let blob: Blob;
  if (s.exportFormat === 'png') blob = new Blob([encodePNG(r.output) as BlobPart], { type: 'image/png' });
  else blob = await encodeCanvas(r.output, s.exportFormat === 'jpeg' ? 'image/jpeg' : 'image/webp', s.exportQuality);
  const ext = s.exportFormat === 'jpeg' ? 'jpg' : s.exportFormat;
  return { blob, ext, width: r.output.width, height: r.output.height };
}
