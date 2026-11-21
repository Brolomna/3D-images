import type { CropRect } from '../core/layout';
import type { StereoSettings } from '../core/settings';

export type WorkerRequest =
  | { type: 'source'; id: number; width: number; height: number; buffer: ArrayBuffer }
  | { type: 'render'; id: number; settings: StereoSettings; scale: number }
  | { type: 'export'; id: number; settings: StereoSettings };

export interface RenderInfo {
  fullWidth: number;
  fullHeight: number;
  renderScale: number;
  dx: number;
  dy: number;
  visible: CropRect;
  baseReused: boolean;
  ms: number;
  timings: { base: number; views: number; compose: number };
}

export type WorkerResponse =
  | { type: 'source-ready'; id: number }
  | { type: 'rendered'; id: number; width: number; height: number; buffer: ArrayBuffer; info: RenderInfo }
  | { type: 'progress'; id: number; stage: string }
  | { type: 'exported'; id: number; blob: Blob; width: number; height: number }
  | { type: 'error'; id: number; message: string };
