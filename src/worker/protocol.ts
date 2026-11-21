import type { CropRect } from '../core/layout';
import type { StereoSettings } from '../core/settings';

export interface RawDepth { width: number; height: number; buffer: ArrayBuffer }

export type WorkerRequest =
  | { type: 'source'; id: number; width: number; height: number; buffer: ArrayBuffer }
  | { type: 'depth'; id: number; depth: RawDepth | null }
  | { type: 'render'; id: number; settings: StereoSettings; scale: number; includeDepth: boolean }
  | {
    type: 'export';
    id: number;
    settings: StereoSettings;
    /** Optional standalone source (batch mode); otherwise the loaded image. */
    item?: { width: number; height: number; buffer: ArrayBuffer; depth: RawDepth | null };
  };

export interface RenderInfo {
  fullWidth: number;
  fullHeight: number;
  eyeWidth: number;
  eyeHeight: number;
  renderScale: number;
  dx: number;
  dy: number;
  depthUsed: boolean;
  visible: CropRect;
  baseReused: boolean;
  ms: number;
  timings: { base: number; views: number; compose: number };
}

export type WorkerResponse =
  | { type: 'ok'; id: number }
  | {
    type: 'rendered'; id: number; eyeW: number; eyeH: number;
    left: ArrayBuffer; right: ArrayBuffer; depth: ArrayBuffer | null; info: RenderInfo;
  }
  | { type: 'progress'; id: number; stage: string }
  | { type: 'exported'; id: number; blob: Blob; ext: string; width: number; height: number }
  | { type: 'error'; id: number; message: string };
