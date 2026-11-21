export type DepthRequest = { type: 'estimate'; id: number; width: number; height: number; buffer: ArrayBuffer };

export type DepthResponse =
  | { type: 'progress'; id: number; stage: string; loaded?: number; total?: number }
  | { type: 'depth'; id: number; width: number; height: number; buffer: ArrayBuffer; ms: number }
  | { type: 'error'; id: number; message: string };

/** Hugging Face model used for monocular depth estimation (runs fully in-browser). */
export const DEPTH_MODEL_ID = 'onnx-community/depth-anything-v2-small';
/** Longest side of the image handed to the model (it resizes to ~518 px internally). */
export const DEPTH_INPUT_MAX_SIDE = 1024;
