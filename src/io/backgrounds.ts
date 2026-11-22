/**
 * Custom 3D Scene backgrounds, saved in the browser (IndexedDB) so they can
 * be reused as presets. Each entry keeps the image (downscaled), its
 * estimated depth map and a small thumbnail. Nothing leaves the device.
 */
import type { DepthMap } from '../core/depth';
import type { RGBAImage } from '../core/types';

export interface SavedBackground {
  id: string;
  name: string;
  image: RGBAImage;
  depth: DepthMap;
  thumb: string; // data URL
  created: number;
}

interface Row {
  id: string;
  name: string;
  w: number;
  h: number;
  rgba: ArrayBuffer;
  dw: number;
  dh: number;
  depth: ArrayBuffer;
  thumb: string;
  created: number;
}

const DB = 'stereo3d';
const STORE = 'backgrounds';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

function fromRow(r: Row): SavedBackground {
  return {
    id: r.id, name: r.name, thumb: r.thumb, created: r.created,
    image: { width: r.w, height: r.h, data: new Uint8ClampedArray(r.rgba) },
    depth: { width: r.dw, height: r.dh, data: new Float32Array(r.depth) },
  };
}

export async function listBackgrounds(): Promise<SavedBackground[]> {
  try {
    const rows = await tx<Row[]>('readonly', (s) => s.getAll() as IDBRequest<Row[]>);
    return rows.map(fromRow).sort((a, b) => a.created - b.created);
  } catch {
    return []; // storage unavailable (private mode etc.)
  }
}

export async function getBackground(id: string): Promise<SavedBackground | null> {
  try {
    const r = await tx<Row | undefined>('readonly', (s) => s.get(id) as IDBRequest<Row | undefined>);
    return r ? fromRow(r) : null;
  } catch {
    return null;
  }
}

export async function saveBackground(name: string, image: RGBAImage, depth: DepthMap): Promise<SavedBackground> {
  const id = `bg_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const thumb = makeThumb(image);
  const row: Row = {
    id, name, w: image.width, h: image.height, rgba: image.data.slice().buffer as ArrayBuffer,
    dw: depth.width, dh: depth.height, depth: depth.data.slice().buffer as ArrayBuffer, thumb, created: Date.now(),
  };
  try {
    await tx('readwrite', (s) => s.put(row));
  } catch {
    /* not persisted, still usable this session */
  }
  return fromRow(row);
}

export async function deleteBackground(id: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch { /* ignore */ }
}

function makeThumb(img: RGBAImage): string {
  const c = document.createElement('canvas');
  const s = Math.min(1, 160 / Math.max(img.width, img.height));
  c.width = Math.max(1, Math.round(img.width * s));
  c.height = Math.max(1, Math.round(img.height * s));
  const src = document.createElement('canvas');
  src.width = img.width; src.height = img.height;
  src.getContext('2d')!.putImageData(new ImageData(img.data.slice(), img.width, img.height), 0, 0);
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}
