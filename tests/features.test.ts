import { describe, expect, it } from 'vitest';
import { normalizeDepth, warpHorizontal, type DepthMap } from '../src/core/depth';
import { displaceHorizontal } from '../src/core/displace';
import { composeAnaglyph, composeLayout } from '../src/core/formats';
import { encodeGif } from '../src/core/gif';
import { resolveOutputSize } from '../src/core/layout';
import { assembleMPO } from '../src/core/mpo';
import { StereoPipeline } from '../src/core/pipeline';
import { cloneSettings, DEFAULT_SETTINGS, type StereoSettings } from '../src/core/settings';
import { createImage, imagesEqual } from '../src/core/types';
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
  });
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
