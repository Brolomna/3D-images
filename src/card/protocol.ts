import type { CardSettings } from '../core/cardlayers';

export interface RawImage { width: number; height: number; buffer: ArrayBuffer }

export type CardRequest = {
  type: 'split';
  id: number;
  card: RawImage;
  bg: RawImage | null;
  settings: CardSettings;
};

export type CardResponse =
  | { type: 'progress'; id: number; stage: string; loaded?: number; total?: number }
  | {
    type: 'done'; id: number; ms: number; model: string;
    frame: RawImage; char: RawImage; bg: RawImage;
    info: import('../core/cardlayers').CardLayers['info'];
  }
  | { type: 'error'; id: number; message: string };

/**
 * BiRefNet_lite (MIT) segmentation models, tried in order.
 * The 1024 px model needs ~6.7 GB of working memory, so it only runs on a
 * GPU (WebGPU, half precision); the 512 px export (~2 GB) runs on the CPU
 * (WebAssembly) and its matte is sharpened against the photo afterwards.
 */
export interface CardModel { name: string; url: string; mb: number; size: number; gpuOnly: boolean }
export const CARD_MODELS: CardModel[] = [
  { name: 'BiRefNet_lite 1024 fp16', url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx', mb: 115, size: 1024, gpuOnly: true },
  { name: 'BiRefNet_lite 512', url: 'https://huggingface.co/studioludens/birefnet-lite-512/resolve/main/onnx/model.onnx', mb: 192, size: 512, gpuOnly: false },
];
