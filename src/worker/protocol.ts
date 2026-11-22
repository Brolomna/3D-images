import type { CropRect } from '../core/layout';
import type { SceneSettings } from '../core/scene';
import type { StereoSettings } from '../core/settings';

export interface RawDepth { width: number; height: number; buffer: ArrayBuffer }

export type WorkerRequest =
  | { type: 'source'; id: number; width: number; height: number; buffer: ArrayBuffer }
  | { type: 'depth'; id: number; depth: RawDepth | null }
  | { type: 'texture'; id: number; texture: { width: number; height: number; buffer: ArrayBuffer } | null }
  | { type: 'scene'; id: number; scene: SceneSettings }
  | { type: 'scene-bg'; id: number; bg: { width: number; height: number; buffer: ArrayBuffer; depth: RawDepth } | null }
  | {
    type: 'render'; id: number; settings: StereoSettings; scale: number; includeDepth: boolean;
    /** For the motion style: number of preview frames and their render scale. */
    motion: { frames: number; scale: number } | null;
  }
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
  | { type: 'scene-ready'; id: number; applied: boolean; preview: { width: number; height: number; buffer: ArrayBuffer } | null; ms: number }
  | {
    type: 'rendered'; id: number; eyeW: number; eyeH: number;
    left: ArrayBuffer; right: ArrayBuffer; depth: ArrayBuffer | null; info: RenderInfo;
    motion: { width: number; height: number; frames: ArrayBuffer[]; hasDepth: boolean } | null;
    /** Finished single image for the stereogram style. */
    special: { width: number; height: number; buffer: ArrayBuffer; hasDepth: boolean; sketch: ArrayBuffer | null } | null;
  }
  | { type: 'progress'; id: number; stage: string }
  | { type: 'exported'; id: number; blob: Blob; ext: string; width: number; height: number }
  | { type: 'error'; id: number; message: string };
