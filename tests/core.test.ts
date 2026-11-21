import { describe, expect, it } from 'vitest';
import { decode } from 'fast-png';
import { encodePNG } from '../src/core/encode';
import { computeTaps } from '../src/core/kernels';
import { computeMapping, resolveOutputSize, type OutputSizeSpec } from '../src/core/layout';
import { StereoPipeline } from '../src/core/pipeline';
import { cloneSettings, DEFAULT_SETTINGS, type StereoSettings } from '../src/core/settings';
import { imagesEqual, type Interpolation, type RGBAImage } from '../src/core/types';
import { illustration, photo, px, solid, textImage, transparentImage } from './fixtures';

const INTERPS: Interpolation[] = ['nearest', 'bilinear', 'bicubic', 'lanczos'];

function settings(patch: (s: StereoSettings) => void = () => {}): StereoSettings {
  const s = cloneSettings(DEFAULT_SETTINGS);
  patch(s);
  return s;
}

function render(src: RGBAImage, s: StereoSettings, scale = 1) {
  const p = new StereoPipeline();
  p.setSource(src);
  return p.render(s, scale);
}

function spec(patch: Partial<OutputSizeSpec>): OutputSizeSpec {
  return { ...DEFAULT_SETTINGS.output, ...patch };
}

const SOURCES: Record<string, () => RGBAImage> = {
  portrait: () => photo(300, 520, 1),
  poster: () => photo(540, 960, 2),
  landscape: () => photo(640, 360, 3),
  illustration: () => illustration(400, 400),
  dark: () => photo(320, 480, 4, 0.12),
  bright: () => photo(320, 480, 5, 1.6),
  text: () => textImage(480, 270),
};

describe('output size & aspect ratio', () => {
  it('default is 1080×1920 with two 540×1920 eyes', () => {
    const r = resolveOutputSize(DEFAULT_SETTINGS.output);
    expect(r).toEqual({ width: 1080, height: 1920, eyeWidth: 540, eyeHeight: 1920 });
  });
  it.each([
    ['9:16', '720p', 720, 1280],
    ['1:1', '1080p', 1080, 1080],
    ['16:9', '1080p', 1920, 1080],
    ['16:9', '1440p', 2560, 1440],
    ['16:9', '4k', 3840, 2160],
    ['4:3', '1080p', 1440, 1080],
    ['16:9', '8k', 7680, 4320],
    ['9:16', '8k', 4320, 7680],
  ] as const)('%s @ %s → %i×%i', (aspect, resolution, w, h) => {
    const r = resolveOutputSize(spec({ aspect, resolution }));
    expect([r.width, r.height]).toEqual([w, h]);
    expect(r.eyeWidth * 2).toBe(r.width);
  });
  it('custom dimensions are forced to an even width', () => {
    const r = resolveOutputSize(spec({ resolution: 'custom', customWidth: 1001, customHeight: 777 }));
    expect(r.width % 2).toBe(0);
    expect(r.height).toBe(777);
  });
  it('aspect may apply to each eye', () => {
    const r = resolveOutputSize(spec({ aspect: '9:16', resolution: '1080p', aspectTarget: 'eye' }));
    expect(r.eyeWidth / r.eyeHeight).toBeCloseTo(9 / 16, 2);
  });
  it('fill covers, fit contains, stretch matches exactly', () => {
    const base = { scale: 1, posX: 0.5, posY: 0.5, crop: { x: 0, y: 0, w: 1, h: 1 } };
    const fill = computeMapping(1600, 900, 540, 1920, { ...base, fit: 'fill' });
    expect(900 * fill.sy).toBeCloseTo(1920);
    expect(1600 * fill.sx).toBeGreaterThan(540);
    const fit = computeMapping(1600, 900, 540, 1920, { ...base, fit: 'fit' });
    expect(1600 * fit.sx).toBeCloseTo(540);
    expect(fit.offY).toBeGreaterThan(0);
    const st = computeMapping(1600, 900, 540, 1920, { ...base, fit: 'stretch' });
    expect([1600 * st.sx, 900 * st.sy]).toEqual([540, 1920]);
  });
});

describe('kernels', () => {
  it.each(INTERPS)('%s taps are normalised', (k) => {
    for (const u of [3.3, 10.5, 7.99]) for (const fs of [1, 2.7]) {
      const t = computeTaps(u, 100, k, fs);
      expect(t.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    }
  });
  it.each(INTERPS)('%s resize preserves a constant colour', (k) => {
    const r = render(solid(97, 211, [12, 200, 77, 255]), settings((s) => {
      s.resizeInterpolation = k; s.output.resolution = 'custom'; s.output.customWidth = 120; s.output.customHeight = 333;
    }));
    for (let i = 0; i < r.output.data.length; i += 4) {
      expect(Array.from(r.output.data.subarray(i, i + 4))).toEqual([12, 200, 77, 255]);
    }
  });
});

describe('stereo views', () => {
  it.each(Object.keys(SOURCES))('%s: halves identical at zero displacement (all fit modes)', (name) => {
    for (const fit of ['fill', 'fit', 'stretch', 'manual'] as const) {
      const r = render(SOURCES[name](), settings((s) => {
        s.horizontalOffset = 0; s.verticalOffset = 0; s.layout.fit = fit;
        s.layout.crop = { x: 0.1, y: 0.05, w: 0.4, h: 0.8 };
      }));
      expect(imagesEqual(r.left, r.right)).toBe(true);
      expect(r.left.width).toBe(540);
      expect(r.left.height).toBe(1920);
    }
  });

  it.each([14, -14, 1, 37, 100, -100])('integer horizontal displacement %i is exact', (h) => {
    const r = render(photo(800, 900, 7), settings((s) => { s.horizontalOffset = Math.abs(h); s.direction = h < 0 ? -1 : 1; s.verticalOffset = 0; }));
    const { left, right } = r;
    for (const y of [0, 333, 1919]) for (let x = 0; x < 540; x++) {
      const sx = x - h;
      if (sx < 0 || sx >= 540) continue;
      expect(px(right, x, y)).toEqual(px(left, sx, y));
    }
  });

  it('default 14 px / 0 px displaces the RIGHT eye only', () => {
    const src = photo(540, 1920, 8);
    const r = render(src, DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.verticalOffset).toBe(0);
    expect(r.dx).toBe(14);
    expect(r.dy).toBe(0);
    // Left eye is the untouched photo (source already at eye resolution).
    expect(imagesEqual(r.left, src)).toBe(true);
    expect(imagesEqual(r.right, src)).toBe(false);
  });

  it('fractional vertical displacement interpolates accurately (bilinear)', () => {
    const src = photo(540, 1920, 9);
    for (const dy of [0.3, 0.5, 0.6, -0.6, 2.25]) {
      const r = render(src, settings((s) => { s.horizontalOffset = 0; s.verticalOffset = dy; s.shiftInterpolation = 'bilinear'; }));
      const iy = Math.floor(dy);
      const t = dy - iy;
      for (const [x, y] of [[10, 100], [270, 960], [539, 1500]]) {
        const a = px(src, x, y - iy);
        const b = px(src, x, y - iy - 1);
        const expected = a.map((v, i) => (i === 3 ? 255 : Math.round((1 - t) * v + t * b[i])));
        px(r.right, x, y).forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThanOrEqual(1));
      }
    }
  });

  it.each(INTERPS)('fractional displacement works with %s', (k) => {
    const r = render(photo(600, 1000, 10), settings((s) => { s.shiftInterpolation = k; s.horizontalOffset = 14.5; }));
    expect(r.right.width).toBe(r.left.width);
    expect(imagesEqual(r.left, r.right)).toBe(false);
  });

  it.each(Object.keys(SOURCES))('%s: no blank borders with large offsets', (name) => {
    for (const fit of ['fill', 'fit'] as const) for (const edgeMode of ['extend', 'crop'] as const) {
      const r = render(SOURCES[name](), settings((s) => {
        s.layout.fit = fit; s.edgeMode = edgeMode; s.horizontalOffset = 100; s.verticalOffset = 10;
      }));
      for (const img of [r.left, r.right]) {
        for (let y = 0; y < img.height; y += 7) for (const x of [0, 1, 50, img.width - 1]) {
          const p = px(img, x, y);
          expect(p[3]).toBe(255);
        }
      }
      // Edge column of the displaced view must not be a constant black strip
      // (dark source naturally has dark pixels, so compare against the image).
      if (name !== 'dark' && name !== 'text') {
        let sum = 0;
        for (let y = 0; y < r.right.height; y++) sum += px(r.right, 0, y)[0] + px(r.right, 0, y)[1] + px(r.right, 0, y)[2];
        expect(sum).toBeGreaterThan(0);
      }
    }
  });

  it('extend mode uses surrounding real image content when available', () => {
    // Landscape filled into portrait: lots of real content beside the frame.
    const src = photo(1600, 900, 11);
    const r = render(src, settings((s) => { s.verticalOffset = 0; s.horizontalOffset = 30; s.resizeInterpolation = 'bilinear'; }));
    // Columns revealed on the left are not just replicas of column 0.
    expect(px(r.right, 0, 500)).not.toEqual(px(r.right, 29, 500));
  });

  it('transparent PNG content keeps its alpha in fill mode', () => {
    const r = render(transparentImage(300, 300), settings((s) => { s.output.aspect = '1:1'; s.output.resolution = '720p'; }));
    expect(px(r.left, 0, 0)[3]).toBe(0);
    expect(px(r.left, 180, 360)[3]).toBe(255);
  });

  it('views always have identical dimensions', () => {
    for (const aspect of ['9:16', '1:1', '16:9', '4:3'] as const) {
      const r = render(photo(500, 300, 12), settings((s) => { s.output.aspect = aspect; s.output.resolution = '720p'; s.horizontalOffset = 33.3; }));
      expect([r.left.width, r.left.height]).toEqual([r.right.width, r.right.height]);
      expect(r.output.width).toBe(r.left.width * 2);
      expect(r.output.height).toBe(r.left.height);
    }
  });

  it('composition places left|right (parallel) or right|left (cross)', () => {
    const r = render(photo(540, 1920, 13), settings((s) => { s.arrangement = 'cross'; }));
    expect(px(r.output, 0, 5)).toEqual(px(r.right, 0, 5));
    expect(px(r.output, 540, 5)).toEqual(px(r.left, 0, 5));
  });

  it('shifted eye can be the left one and direction is reversible', () => {
    const src = photo(540, 1920, 14);
    const a = render(src, settings((s) => { s.shiftedEye = 'left'; s.verticalOffset = 0; }));
    expect(imagesEqual(a.right, src)).toBe(true);
    expect(px(a.left, 100, 10)).toEqual(px(src, 86, 10));
    const b = render(src, settings((s) => { s.direction = -1; s.verticalOffset = 0; }));
    expect(px(b.right, 100, 10)).toEqual(px(src, 114, 10));
  });
});

describe('content preservation, determinism & export', () => {
  it.each(INTERPS)('original pixels unchanged when source matches eye size (%s)', (k) => {
    const src = photo(540, 1920, 15);
    const r = render(src, settings((s) => { s.resizeInterpolation = k; s.horizontalOffset = 0; s.verticalOffset = 0; }));
    expect(imagesEqual(r.left, src)).toBe(true);
  });

  it('deterministic across runs and cache states', () => {
    const src = photo(700, 1100, 16);
    const s = settings();
    const a = render(src, s).output;
    const p = new StereoPipeline();
    p.setSource(src);
    p.render(settings((x) => { x.horizontalOffset = 90; }));
    const b = p.render(s); // reuses a base with larger margins
    expect(b.baseReused).toBe(true);
    expect(imagesEqual(a, b.output)).toBe(true);
  });

  it('offset change reuses the cached base frame', () => {
    const p = new StereoPipeline();
    p.setSource(photo(400, 700, 17));
    p.render(settings());
    expect(p.render(settings((s) => { s.horizontalOffset = 5; s.verticalOffset = 1; })).baseReused).toBe(true);
    expect(p.render(settings((s) => { s.layout.scale = 1.2; })).baseReused).toBe(false);
  });

  it('PNG export is lossless (decoded export === preview buffer)', () => {
    for (const src of [photo(300, 500, 18), transparentImage(200, 200)]) {
      const r = render(src, settings((s) => { s.output.resolution = '720p'; }));
      const png = decode(encodePNG(r.output));
      expect([png.width, png.height]).toEqual([r.output.width, r.output.height]);
      const rgba = png.channels === 4 ? png.data : expandRGB(png.data as Uint8Array);
      expect(bytesEqual(rgba as Uint8Array, r.output.data)).toBe(true);
    }
  });

  it('preview at reduced scale scales the offsets proportionally', () => {
    const r = render(photo(800, 1400, 19), settings((s) => { s.verticalOffset = 0.6; }), 0.5);
    expect(r.left.width).toBe(270);
    expect(r.dx).toBeCloseTo(7);
    expect(r.dy).toBeCloseTo(0.3);
  });
});

function expandRGB(d: Uint8Array): Uint8Array {
  const out = new Uint8Array((d.length / 3) * 4);
  for (let i = 0, j = 0; i < d.length; i += 3, j += 4) {
    out[j] = d[i]; out[j + 1] = d[i + 1]; out[j + 2] = d[i + 2]; out[j + 3] = 255;
  }
  return out;
}

function bytesEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
