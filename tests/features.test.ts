import { describe, expect, it } from 'vitest';
import { normalizeDepth, warpHorizontal, type DepthMap } from '../src/core/depth';
import { displaceHorizontal } from '../src/core/displace';
import { composeAnaglyph, composeLayout } from '../src/core/formats';
import { encodeGif } from '../src/core/gif';
import { resolveOutputSize } from '../src/core/layout';
import { assembleMPO } from '../src/core/mpo';
import { StereoPipeline } from '../src/core/pipeline';
import { cloneSettings, DEFAULT_SETTINGS, type StereoSettings } from '../src/core/settings';
import { createImage, imagesEqual, type RGBAImage } from '../src/core/types';
import { decodeSettings, encodeSettings, settingsFromHash } from '../src/ui/share';
import { photo, px } from './fixtures';

function settings(patch: (s: StereoSettings) => void = () => {}): StereoSettings {
  const s = cloneSettings(DEFAULT_SETTINGS);
  patch(s);
  return s;
}

function constDepth(w: number, h: number, v: number): DepthMap {
  return { width: w, height: h, data: new Float32Array(w * h).fill(v) };
}

describe('depth-based rendering', () => {
  it('normalises robustly to 0..1 and can invert', () => {
    const raw: DepthMap = { width: 100, height: 1, data: Float32Array.from({ length: 100 }, (_, i) => i * 3 + 7) };
    const n = normalizeDepth(raw);
    expect(Math.min(...n.data)).toBe(0);
    expect(Math.max(...n.data)).toBe(1);
    expect(n.data[50]).toBeCloseTo(0.5, 1);
    expect(normalizeDepth(raw, true).data[0]).toBe(1);
  });

  it('constant depth at the focus plane equals the uniform shift (integer: exact)', () => {
    const base = photo(300, 50, 3);
    const d = constDepth(300, 50, 0.4);
    const params = { uniform: 12, strength: 20, focus: 0.4, eyeSign: -1 };
    const warped = warpHorizontal(base, d, 40, 220, params, 'bicubic', false);
    const uniform = displaceHorizontal(base, 12, 40, 220, 'bicubic', false);
    expect(imagesEqual(warped, uniform)).toBe(true);
  });

  it('constant depth with fractional shift matches the uniform shift within 1 level', () => {
    const base = photo(300, 50, 4);
    const warped = warpHorizontal(base, constDepth(300, 50, 0), 40, 220, { uniform: 7.4, strength: 0, focus: 0, eyeSign: -1 }, 'bicubic', false);
    const uniform = displaceHorizontal(base, 7.4, 40, 220, 'bicubic', false);
    for (let i = 0; i < warped.data.length; i++) expect(Math.abs(warped.data[i] - uniform.data[i])).toBeLessThanOrEqual(1);
  });

  it('near objects get more disparity, occlusions and holes are handled', () => {
    // Background: horizontal gradient (far). Foreground: solid red block (near).
    const W = 200, H = 20, mx = 40;
    const base = createImage(W, H);
    const depth = constDepth(W, H, 0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const fg = x >= 100 && x < 130;
      base.data.set(fg ? [255, 0, 0, 255] : [x, 128, 255 - x, 255], o);
      if (fg) depth.data[y * W + x] = 1;
    }
    // Right eye displaced, focus far: D = −S·d → foreground moves 10 px left.
    const S = 10;
    const out = warpHorizontal(base, depth, mx, W - 2 * mx, { uniform: 0, strength: S, focus: 0, eyeSign: -1 }, 'nearest', false);
    const eye = (x: number) => px(out, x, 5);
    // Foreground (originally at eye x 60..89) now at 50..79.
    expect(eye(52)).toEqual([255, 0, 0, 255]);
    expect(eye(78)).toEqual([255, 0, 0, 255]);
    // Background far from the object is unchanged.
    expect(eye(10)).toEqual(px(base, 10 + mx, 5));
    expect(eye(110)).toEqual(px(base, 110 + mx, 5));
    // Disoccluded strip right of the object is filled with background, not red.
    for (let x = 81; x < 90; x++) expect(eye(x)[0]).not.toBe(255);
  });

  it('pipeline uses the depth map, deterministically, with identical view sizes', () => {
    const src = photo(400, 700, 5);
    const depth: DepthMap = { width: 40, height: 70, data: Float32Array.from({ length: 2800 }, (_, i) => (i % 40) / 40) };
    const run = () => {
      const p = new StereoPipeline();
      p.setSource(src);
      p.setDepth(depth);
      return p.render(settings((s) => { s.output.resolution = '720p'; }), 1, { includeDepth: true });
    };
    const a = run(), b = run();
    expect(a.depthUsed).toBe(true);
    expect(imagesEqual(a.output, b.output)).toBe(true);
    expect([a.left.width, a.left.height]).toEqual([a.right.width, a.right.height]);
    expect(a.depth!.width).toBe(a.left.width);
    for (let i = 3; i < a.right.data.length; i += 4) expect(a.right.data[i]).toBe(255);
    // Without depth (or strength 0) the result is the uniform shift.
    const p = new StereoPipeline();
    p.setSource(src);
    p.setDepth(depth);
    const flat = p.render(settings((s) => { s.output.resolution = '720p'; s.depth.strength = 0; }));
    expect(flat.depthUsed).toBe(false);
  }, 30000);
});

describe('stereo formats', () => {
  const spec = DEFAULT_SETTINGS.output;
  it.each([
    ['sbs', 1080, 1920, 540, 1920],
    ['half-sbs', 1080, 1920, 1080, 1920],
    ['ou', 1080, 1920, 1080, 960],
    ['half-ou', 1080, 1920, 1080, 1920],
    ['anaglyph', 1080, 1920, 1080, 1920],
    ['wiggle', 1080, 1920, 1080, 1920],
    ['mpo', 1080, 1920, 1080, 1920],
  ] as const)('%s geometry', (format, w, h, ew, eh) => {
    expect(resolveOutputSize(spec, format)).toEqual({ width: w, height: h, eyeWidth: ew, eyeHeight: eh });
  });

  it('composes every still format at the output size', () => {
    for (const format of ['sbs', 'half-sbs', 'ou', 'half-ou', 'anaglyph'] as const) {
      const p = new StereoPipeline();
      p.setSource(photo(500, 400, 6));
      const s = settings((x) => { x.format = format; x.output.aspect = '16:9'; x.output.resolution = '720p'; });
      const r = p.render(s);
      expect([r.output.width, r.output.height]).toEqual([1280, 720]);
    }
  });

  it('over/under stacks left on top (parallel) and swaps for cross', () => {
    const l = photo(40, 30, 1), r = photo(40, 30, 2);
    const ou = composeLayout(l, r, 'ou', 'parallel', 'dubois', 'lanczos');
    expect(px(ou, 3, 3)).toEqual(px(l, 3, 3));
    expect(px(ou, 3, 33)).toEqual(px(r, 3, 3));
    expect(px(composeLayout(l, r, 'ou', 'cross', 'dubois', 'lanczos'), 3, 3)).toEqual(px(r, 3, 3));
  });

  it('half side-by-side squeezes each eye to half width', () => {
    const l = photo(80, 30, 1), r = photo(80, 30, 2);
    const h = composeLayout(l, r, 'half-sbs', 'parallel', 'dubois', 'lanczos');
    expect([h.width, h.height]).toEqual([80, 30]);
  });

  it('anaglyph takes red from the left eye and green/blue from the right eye', () => {
    const l = createImage(1, 1); l.data.set([200, 10, 20, 255]);
    const r = createImage(1, 1); r.data.set([30, 140, 150, 255]);
    expect(px(composeAnaglyph(l, r, 'color'), 0, 0)).toEqual([200, 140, 150, 255]);
    const d = px(composeAnaglyph(l, r, 'dubois'), 0, 0);
    expect(d[0]).toBeGreaterThan(d[1] - 200);
  });

  it('wiggle frames sweep from the reference to the displaced view and back', () => {
    const p = new StereoPipeline();
    p.setSource(photo(540, 1920, 7));
    const s = settings((x) => { x.format = 'wiggle'; x.output.resolution = '720p'; x.horizontalOffset = 12; });
    const two = p.renderWiggleFrames(s, 2);
    expect(two).toHaveLength(2);
    const r = p.render(s, 1, { compose: false });
    expect(imagesEqual(two[0], r.left)).toBe(true);
    expect(imagesEqual(two[1], r.right)).toBe(true);
    const six = p.renderWiggleFrames(s, 6);
    expect(six).toHaveLength(6);
    expect(imagesEqual(six[1], six[5])).toBe(true);
    expect(imagesEqual(six[3], r.right)).toBe(true);
  });

  it('encodes a looping GIF', () => {
    const bytes = encodeGif([photo(32, 24, 1), photo(32, 24, 2)], 140);
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe('GIF89a');
    expect(String.fromCharCode(...bytes)).toContain('NETSCAPE2.0');
    expect(bytes[bytes.length - 1]).toBe(0x3b);
  });

  it('assembles a valid two-image MPO', () => {
    const fakeJpeg = (fill: number, n: number) => Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
      ...new Array(n).fill(fill), 0xff, 0xd9,
    ]);
    const a = fakeJpeg(1, 100), b = fakeJpeg(2, 57);
    const mpo = assembleMPO(a, b);
    // First image: APP2 'MPF' right after APP0.
    expect([mpo[20], mpo[21]]).toEqual([0xff, 0xe2]);
    expect(String.fromCharCode(...mpo.slice(24, 27))).toBe('MPF');
    const header = 28;
    expect([...mpo.slice(header, header + 4)]).toEqual([0x4d, 0x4d, 0x00, 0x2a]);
    const u32 = (p: number) => ((mpo[p] << 24) | (mpo[p + 1] << 16) | (mpo[p + 2] << 8) | mpo[p + 3]) >>> 0;
    const u16 = (p: number) => (mpo[p] << 8) | mpo[p + 1];
    const ifd = header + u32(header + 4);
    const count = u16(ifd);
    let entriesOff = -1, n = -1;
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === 0xb001) n = u32(e + 8);
      if (u16(e) === 0xb002) entriesOff = u32(e + 8);
    }
    expect(n).toBe(2);
    const e1 = header + entriesOff, e2 = e1 + 16;
    expect(u32(e1)).toBe(0x20020002);
    const size1 = u32(e1 + 4);
    const size2 = u32(e2 + 4);
    const off2 = header + u32(e2 + 8);
    expect(size1 + size2).toBe(mpo.length);
    expect(off2).toBe(size1);
    expect([mpo[off2], mpo[off2 + 1]]).toEqual([0xff, 0xd8]);
    expect([mpo[size1 - 2], mpo[size1 - 1]]).toEqual([0xff, 0xd9]);
    expect(String.fromCharCode(...mpo.slice(off2 + 24, off2 + 27))).toBe('MPF');
  });
});

describe('stereo window edge mask', () => {
  it('blanks the monocular strips for a uniform shift', () => {
    const src = photo(540, 1920, 9);
    const p = new StereoPipeline();
    p.setSource(src);
    const r = p.render(settings((s) => { s.horizontalOffset = 10; s.edgeMask = true; s.depth.enabled = false; }));
    expect(px(r.right, 9, 100)).toEqual([0, 0, 0, 255]);
    expect(px(r.right, 10, 100)).not.toEqual([0, 0, 0, 255]);
    expect(px(r.left, 530, 100)).toEqual([0, 0, 0, 255]);
    expect(px(r.left, 529, 100)).toEqual(px(src, 529, 100));
  });
});

describe('share links', () => {
  it('round-trips settings and keeps defaults compact', () => {
    expect(encodeSettings(DEFAULT_SETTINGS)).toBe('');
    const s = settings((x) => { x.horizontalOffset = 22.5; x.format = 'anaglyph'; x.depth.strength = 31; x.background = { kind: 'color', color: '#ff0000' }; });
    const back = decodeSettings(encodeSettings(s))!;
    expect(back).toEqual(s);
    expect(settingsFromHash(`#s=${encodeSettings(s)}`)).toEqual(s);
    expect(settingsFromHash('#nothing')).toBeNull();
  });
  it('ignores malformed or hostile links', () => {
    expect(decodeSettings('!!!')).toBeNull();
    const evil = btoa(JSON.stringify({ horizontalOffset: 'x', __proto__: { a: 1 }, unknownKey: 5 })).replace(/=+$/, '');
    expect(decodeSettings(evil)!.horizontalOffset).toBe(14);
  });
});

import { motionOffsets, motionTiming, renderMotionFrame } from '../src/core/motion';
import type { BaseFrame } from '../src/core/views';

describe('3D photo motion', () => {
  // Scene: gradient background (far, d=0) with a red square (near, d=1).
  function scene(W = 200, H = 160, m = 40) {
    const image = createImage(W, H);
    const depth = constDepth(W, H, 0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const fg = x >= 90 && x < 110 && y >= 70 && y < 90;
      image.data.set(fg ? [255, 0, 0, 255] : [x, y, 128, 255], (y * W + x) * 4);
      if (fg) depth.data[y * W + x] = 1;
    }
    const base: BaseFrame = { image, eyeW: W - 2 * m, eyeH: H - 2 * m, marginX: m, marginY: m, hasAlpha: false };
    return { base, depth };
  }
  const red = (img: RGBAImage, x: number, y: number) => px(img, x, y)[0] === 255 && px(img, x, y)[1] === 0;

  it('timing gives whole frames per loop', () => {
    expect(motionTiming({ path: 'circle', amplitude: 20, durationMs: 3000, file: 'video' })).toEqual({ count: 90, frameMs: 1000 / 30 });
    expect(motionTiming({ path: 'circle', amplitude: 20, durationMs: 3000, file: 'gif' }).count).toBe(45);
  });

  it('paths move the camera as described', () => {
    expect(motionOffsets('horizontal', 10, 0.25).hx).toBeCloseTo(-10);
    expect(motionOffsets('horizontal', 10, 0.25).vy).toBe(0);
    expect(motionOffsets('vertical', 10, 0.25).vy).toBeCloseTo(-10);
    expect(motionOffsets('circle', 10, 0).hx).toBeCloseTo(-10);
    expect(motionOffsets('zoom', 10, 0.5).radial).toBeCloseTo(10);
    expect(motionOffsets('zoom', 10, 0).radial).toBeCloseTo(0);
  });

  it('without depth, or at the focus depth, frames equal the still photo', () => {
    const { base } = scene();
    const ref = renderMotionFrame(base, null, 0.5, 'circle', 10, 0.3, 'bicubic');
    expect(ref.width).toBe(120);
    const flat = renderMotionFrame(base, constDepth(200, 160, 0.5), 0.5, 'circle', 10, 0.3, 'bicubic');
    expect(imagesEqual(ref, flat)).toBe(true);
  });

  it('near objects move against a still background (horizontal sway)', () => {
    const { base, depth } = scene();
    // Square at eye x 50..69, y 30..49. Focus far → background still, square moves.
    const f = renderMotionFrame(base, depth, 0, 'horizontal', 8, 0.25, 'nearest');
    expect(red(f, 43, 40)).toBe(true); // moved 8 px left
    expect(red(f, 61, 40)).toBe(true);
    expect(red(f, 65, 40)).toBe(false); // revealed background, not smeared red
    expect(px(f, 5, 5)).toEqual(px(base.image, 45, 45)); // background unchanged
  });

  it('vertical sway moves near objects vertically', () => {
    const { base, depth } = scene();
    const f = renderMotionFrame(base, depth, 0, 'vertical', 8, 0.25, 'nearest');
    expect(red(f, 55, 23)).toBe(true); // moved 8 px up
    expect(red(f, 55, 45)).toBe(false);
  });

  it('pipeline renders deterministic full-size motion frames', () => {
    const p = new StereoPipeline();
    p.setSource(photo(400, 700, 5));
    p.setDepth({ width: 40, height: 70, data: Float32Array.from({ length: 2800 }, (_, i) => (i % 40) / 40) });
    const s = settings((x) => { x.format = 'motion'; x.output.resolution = '720p'; });
    const m = p.motionRenderer(s);
    expect([m.width, m.height, m.hasDepth]).toEqual([720, 1280, true]);
    const a = m.frame(0.1), b = p.motionRenderer(s).frame(0.1);
    expect(imagesEqual(a, b)).toBe(true);
    expect(imagesEqual(a, m.frame(0.4))).toBe(false);
    let opaque = true;
    for (let i = 3; i < a.data.length; i += 4) if (a.data[i] !== 255) opaque = false;
    expect(opaque).toBe(true);
  }, 30000);
});

import { buildTexture, DEFAULT_STEREOGRAM, generateAutostereogram, patternWidth, shapeDepth } from '../src/core/autostereogram';

describe('hidden 3D autostereogram', () => {
  const sg = (patch: Partial<typeof DEFAULT_STEREOGRAM> = {}) => ({ ...DEFAULT_STEREOGRAM, guides: false, ...patch });
  const W = 600, H = 200;

  it('builds deterministic, seamless pattern tiles of exactly one pattern width', () => {
    for (const pattern of ['organic', 'dots', 'photo', 'custom'] as const) {
      const a = buildTexture(sg({ pattern }), 100, 80, photo(300, 200, 1), photo(64, 64, 2));
      const b = buildTexture(sg({ pattern }), 100, 80, photo(300, 200, 1), photo(64, 64, 2));
      expect([a.width, a.height]).toEqual([100, 80]);
      expect(imagesEqual(a, b)).toBe(true);
    }
    expect(imagesEqual(buildTexture(sg(), 100, 80, null, null), buildTexture(sg({ seed: 2 }), 100, 80, null, null))).toBe(false);
  });

  it('a flat background repeats exactly every pattern width', () => {
    const P = patternWidth(W, sg());
    expect(P).toBe(100);
    const img = generateAutostereogram(constDepth(W, H, 0), buildTexture(sg(), P, H, null, null), sg());
    for (const y of [0, 77, 199]) for (let x = 0; x + P < W; x += 7) expect(px(img, x + P, y)).toEqual(px(img, x, y));
  });

  it('encodes a near shape as a shorter repeat distance (decodable)', () => {
    const depth = constDepth(W, H, 0);
    for (let y = 50; y < 150; y++) for (let x = 200; x < 400; x++) depth.data[y * W + x] = 1;
    const s = sg({ depth: 0.33, pattern: 'dots' });
    const P = patternWidth(W, s);
    const img = generateAutostereogram(depth, buildTexture(s, P, H, null, null), s);
    // sep(1) = (1 − μ)·2P/(2 − μ) ≈ 80 px for μ = 0.33, P = 100.
    const near = Math.round(((1 - 0.33) * 2 * P) / (2 - 0.33));
    const mismatch = (shift: number, y: number) => {
      let m = 0;
      for (let x = 260; x < 320; x++) {
        const a = px(img, x, y), b = px(img, x + shift, y);
        m += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      }
      return m;
    };
    const bestShift = (y: number) => {
      let best = 0, bestM = Infinity;
      for (let sh = 60; sh <= 110; sh++) { const m = mismatch(sh, y); if (m < bestM) { bestM = m; best = sh; } }
      return best;
    };
    // Inside the shape the pattern repeats at the near separation, outside at P.
    expect(Math.abs(bestShift(100) - near)).toBeLessThanOrEqual(1);
    expect(bestShift(20)).toBe(P);
    expect(mismatch(P, 20)).toBe(0);
  });

  it('shape modes, cutoff and guide dots', () => {
    const ramp: DepthMap = { width: 100, height: 10, data: Float32Array.from({ length: 1000 }, (_, i) => (i % 100) / 99) };
    const sil = shapeDepth(ramp, sg({ shape: 'silhouette', cutoff: 0.5 }));
    expect(sil.data[5 * 100 + 10]).toBeCloseTo(0, 1);
    expect(sil.data[5 * 100 + 95]).toBeCloseTo(1, 1);
    const layers = shapeDepth(ramp, sg({ shape: 'layers', cutoff: 0 }));
    expect(new Set(Array.from(layers.data.slice(500, 600), (v) => Math.round(v * 100))).size).toBeLessThan(40);
    const g = generateAutostereogram(constDepth(W, H, 0), buildTexture(sg(), 100, H, null, null), sg({ guides: true }));
    const r = Math.round(W / 120), cy = Math.round(r * 3);
    expect(px(g, W / 2 - 50, cy)).toEqual([0, 0, 0, 255]);
    expect(px(g, W / 2 + 50, cy)).toEqual([0, 0, 0, 255]);
  });

  it('pipeline hides the photo depth, deterministically', () => {
    const run = () => {
      const p = new StereoPipeline();
      p.setSource(photo(400, 700, 5));
      p.setDepth({ width: 40, height: 70, data: Float32Array.from({ length: 2800 }, (_, i) => ((i % 40) > 15 && (i % 40) < 25 ? 1 : 0)) });
      return p.renderStereogram(settings((x) => { x.format = 'stereogram'; x.output.resolution = '720p'; }));
    };
    const a = run(), b = run();
    expect(a.hasDepth).toBe(true);
    expect([a.image.width, a.image.height]).toEqual([720, 1280]);
    expect(imagesEqual(a.image, b.image)).toBe(true);
    const flat = new StereoPipeline();
    flat.setSource(photo(400, 700, 5));
    expect(flat.renderStereogram(settings((x) => { x.format = 'stereogram'; x.output.resolution = '720p'; })).hasDepth).toBe(false);
  });
});

import { applyDepthContrast } from '../src/core/depth';

describe('depth contrast and extreme depth', () => {
  it('contrast pushes near and far apart while keeping 0, 0.5 and 1 fixed', () => {
    const ramp: DepthMap = { width: 5, height: 1, data: Float32Array.from([0, 0.25, 0.5, 0.75, 1]) };
    expect(applyDepthContrast(ramp, 0)).toBe(ramp);
    const c = applyDepthContrast(ramp, 0.6).data;
    expect(c[0]).toBeCloseTo(0, 5);
    expect(c[2]).toBeCloseTo(0.5, 5);
    expect(c[4]).toBeCloseTo(1, 5);
    expect(c[1]).toBeLessThan(0.25);
    expect(c[3]).toBeGreaterThan(0.75);
  });

  it('very strong depth (200 px) still renders full, opaque, same-size views', () => {
    const p = new StereoPipeline();
    p.setSource(photo(400, 700, 5));
    p.setDepth({ width: 40, height: 70, data: Float32Array.from({ length: 2800 }, (_, i) => (i % 40) / 40) });
    const r = p.render(settings((s) => { s.output.resolution = '720p'; s.depth.strength = 200; s.depth.contrast = 1; }));
    expect(r.depthUsed).toBe(true);
    expect([r.left.width, r.left.height]).toEqual([r.right.width, r.right.height]);
    let opaque = true;
    for (let i = 3; i < r.right.data.length; i += 4) if (r.right.data[i] !== 255) opaque = false;
    expect(opaque).toBe(true);
    expect(imagesEqual(r.left, r.right)).toBe(false);
  }, 30000);
});
