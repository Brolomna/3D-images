# Stereo 3D Photo Generator

Turns an ordinary 2D photograph into a **side-by-side stereoscopic image**. The app makes two copies of the same photo and shifts one of them by a set number of pixels. The resulting binocular disparity lets you perceive depth with parallel or cross-eyed free-viewing, or with a stereo viewer.

This is **not** a Magic Eye / random-dot stereogram generator. It adds no patterns, textures, shadows or depth overlays, and uses no AI generation. The photo's content and colours are preserved; the only operations are deterministic resampling and translation.

## Default configuration

| Setting | Default |
|---|---|
| Output | 1080 × 1920 PNG (9:16 @ 1080p) |
| Layout | two 540 × 1920 views, left \| right |
| Left image | original |
| Right image | shifted **14 px** horizontally (to the right) and **0.6 px** vertically (down) |
| Resize filter | Lanczos-3 |
| Sub-pixel filter | Bicubic (Catmull-Rom) |

**Reset defaults** restores this configuration at any time.

## Running

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (relative paths, host anywhere)
npm test           # unit tests (Vitest)
npm run test:e2e   # browser end-to-end test (Playwright + Chromium)
```

### GitHub Pages

`.github/workflows/pages.yml` tests, builds and deploys the app on every push to `main` (or manually from the Actions tab). One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**. The site is then served at `https://<owner>.github.io/<repo>/`.

Everything runs client-side. Images are never uploaded to a server.

## Features

- **Import:** JPEG, PNG, WEBP (native decoding with EXIF orientation and colour-profile conversion to sRGB) and TIFF (via UTIF). You can also drag & drop or paste. Images are processed at full source resolution.
- **Aspect ratio:** 9:16, 1:1, 16:9, 4:3 or a custom ratio. The ratio can describe the whole output or each eye.
- **Resolution:** 720p, 1080p, 1440p, 4K, 8K or custom pixel dimensions. The output width is always kept even, so both eyes are exactly the same size.
- **Fitting:** *Fill* (cover), *Fit* (no cropping; the background is a blurred copy of the photo, a solid colour or transparency), *Stretch*, or *manual crop*. In manual crop you drag and resize an aspect-locked rectangle on the original. Image scale and crop-position sliders are also available.
- **Stereo controls:**
  - Horizontal offset: −100 to +100 px slider, numeric entry and presets 0/5/10/14/20/30.
  - Vertical offset: −10 to +10 px with fractional steps, presets 0/0.3/0.6/1/2, an on/off switch, and a warning above 2 px.
  - Offset direction, choice of which eye is displaced, and parallel or cross arrangement.
  - Edge handling: *Extend* fills revealed edges with the surrounding real image, then edge pixels. *Crop* zooms both views equally so no edge is revealed.
- **Interpolation:** nearest, bilinear, bicubic or Lanczos, chosen separately for resizing and for sub-pixel displacement.
- **Preview modes:** side-by-side, synchronised L/R compare (shared zoom and pan, crosshair, pixel readout), wiggle, difference ×4, red/cyan anaglyph check, and the original with its visible region. Thumbnails show the original, left eye, right eye and final output. Zoom with the wheel, the buttons or a double-click.
- **Keyboard:** ←/→ nudges the horizontal offset (hold Shift for 0.1 px steps). ↑/↓ nudges the vertical offset by 0.1 px. Ctrl/⌘+S exports.
- **Export:** PNG (default; lossless pure-JS encoder, byte-exact), JPEG or WEBP with adjustable quality. Export always renders at full output resolution.
- **Layout:** a dark, responsive interface. On narrow screens the controls stack vertically, with the preview first.

## How it works

```
source ─► Resize/Crop ─► base frame (+ overscan margins, cached)
                              ├─► Left view  = exact crop of the frame
                              └─► Right view = H-displace ─► V-displace
                                                   └─► Side-by-side composition ─► Preview / Export
```

The modules in `src/` are:

| # | Module | File |
|---|---|---|
| 1 | Image import | `io/import.ts` |
| 2 | Resizing & cropping | `core/layout.ts` (geometry), `core/resample.ts` (separable streaming resampler), `core/background.ts` |
| 3–4 | Left / right view generators | `core/views.ts` |
| 5–6 | Horizontal / vertical displacement processors | `core/displace.ts` |
| 7 | Side-by-side composition | `core/compose.ts` |
| 8 | Preview renderer | `ui/preview.ts` |
| 9 | Export engine | `worker/stereo.worker.ts`, `core/encode.ts` |

Key properties:

- **Offsets are in output pixels.** The photo is resized **once** into the eye frame at output resolution, and the displacement is applied to that frame. The two views are never resized independently. When the live preview runs at a reduced scale (only above about 2.3 MP per eye), the offsets are scaled with it.
- **Exact and sub-pixel shifts.** Integer offsets are pure pixel copies. Fractional offsets such as 0.6 px use a single fixed interpolation kernel, so the operation is a true translation.
- **No blank borders.** The base frame is rendered with overscan margins that hold real neighbouring image content. Edge pixels are used only where the photo itself ends.
- **Real-time editing.** The resized base frame is cached in a Web Worker. Changing an offset re-runs only the displacement and composition steps, which take about 50 ms at 1080 × 1920.
- **Deterministic output.** The same input and settings always give identical bytes. The end-to-end test checks that a PNG exported from the browser matches the Node.js reference render byte for byte.
- **Alpha handling.** Transparent PNGs are filtered with alpha weighting, which avoids dark fringes.

## Tests

`tests/core.test.ts` (59 tests) uses synthetic portrait, poster, landscape, illustration, dark, bright, text/logo and transparent images. It verifies that:

1. Both halves are identical at zero displacement, in every fit mode.
2. Integer horizontal displacement is pixel-exact (±1 to ±100 px).
3. Fractional vertical displacement matches the analytic interpolation (0.3, 0.5, 0.6, −0.6 and 2.25 px).
4. Both views always have identical dimensions, for every aspect ratio.
5. Output size and aspect-ratio presets resolve correctly, for example 9:16 @ 1080p → 1080 × 1920 and 16:9 @ 8K → 7680 × 4320.
6. No transparent or blank borders appear with the largest offsets, in either edge mode.
7. The exported PNG decodes to exactly the preview buffer.
8. Original pixels are unchanged: when the source matches the eye size, the left view equals the source for every filter.
9. Rendering is deterministic, and offset changes reuse the cached frame.

`e2e/smoke.mjs` drives the real UI in Chromium. It uploads PNG and TIFF files, checks the defaults, exports and compares the result against the reference render. It also checks the presets, the view modes, manual crop and the mobile layout.
