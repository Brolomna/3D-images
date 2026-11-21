/// <reference lib="webworker" />
/**
 * Monocular depth estimation worker (Depth Anything V2 small, int8 ONNX).
 *
 * The model weights (~27 MB) are downloaded from Hugging Face on first use
 * and cached by the browser; the ONNX Runtime WebAssembly binary is served
 * with the app. Output is the raw relative inverse-depth map (larger = nearer)
 * at the model's resolution — the stereo pipeline normalises and aligns it.
 */
import { AutoModelForDepthEstimation, AutoProcessor, RawImage, env } from '@huggingface/transformers';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { DEPTH_MODEL_ID, type DepthRequest, type DepthResponse } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

env.allowLocalModels = false;
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean } };
if (onnx.wasm) {
  onnx.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href };
  // Multi-threading needs cross-origin isolation, which static hosts like
  // GitHub Pages do not provide.
  if (!(self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated) onnx.wasm.numThreads = 1;
}

type Loaded = { model: Awaited<ReturnType<typeof AutoModelForDepthEstimation.from_pretrained>>; processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> };
let loading: Promise<Loaded> | null = null;

function post(msg: DepthResponse, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

function load(id: number): Promise<Loaded> {
  if (!loading) {
    const files = new Map<string, { loaded: number; total: number }>();
    const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.file) {
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        post({ type: 'progress', id, stage: 'Downloading depth model', loaded, total });
      }
    };
    loading = (async () => {
      post({ type: 'progress', id, stage: 'Loading depth model' });
      const [model, processor] = await Promise.all([
        AutoModelForDepthEstimation.from_pretrained(DEPTH_MODEL_ID, { dtype: 'q8', device: 'wasm', progress_callback } as never),
        AutoProcessor.from_pretrained(DEPTH_MODEL_ID, { progress_callback } as never),
      ]);
      return { model, processor };
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

ctx.onmessage = async (ev: MessageEvent<DepthRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'estimate') return;
  try {
    const { model, processor } = await load(msg.id);
    post({ type: 'progress', id: msg.id, stage: 'Analysing depth' });
    const t0 = performance.now();
    const image = new RawImage(new Uint8ClampedArray(msg.buffer), msg.width, msg.height, 4);
    const inputs = await (processor as unknown as (img: unknown) => Promise<Record<string, unknown>>)(image.rgb());
    const { predicted_depth } = await (model as unknown as (i: unknown) => Promise<{ predicted_depth: { dims: number[]; data: Float32Array } }>)(inputs);
    const dims = predicted_depth.dims;
    const h = dims[dims.length - 2];
    const w = dims[dims.length - 1];
    const data = Float32Array.from(predicted_depth.data.subarray(0, w * h));
    post({ type: 'depth', id: msg.id, width: w, height: h, buffer: data.buffer, ms: performance.now() - t0 }, [data.buffer]);
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
