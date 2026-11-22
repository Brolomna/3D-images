# Stereo 3D Photo Generator

**Live app: https://brolomna.github.io/3D-images/**

Turns an ordinary 2D photograph into a **3D image**. You pick a **3D style** from visual cards:
- stereoscopic side-by-side, half side-by-side or over/under (for 3D TVs and VR);
- red/cyan anaglyph;
- MPO;
- glasses-free **wiggle** or **3D photo motion** animations.

The app **estimates the photo's depth itself**. Near parts of the scene get more disparity than far parts, so the subject genuinely stands out from the background instead of the whole picture floating as one flat card.

This is **not** a Magic Eye / random-dot stereogram generator. It adds no patterns, shadows or depth overlays, and it generates no new image content. Every output pixel is resampled from the original photo. The depth model only decides how far each pixel moves.

Everything runs in the browser. Photos never leave your device.

## Default configuration

| Setting | Default |
|---|---|
| Output | 1080 × 1920 PNG, side-by-side (two 540 × 1920 views, left \| right) |
| Left image | original |
| Right image | depth-based disparity: base shift **14 px** right, ± up to 8 px from depth (strength 16 px, focus 50 %) |
| Vertical offset | **0 px** |
| Resize filter | Lanczos-3 |
| Sub-pixel filter | Bicubic (Catmull-Rom) |

**Reset defaults** restores this. Turning **Automatic depth** off gives the plain uniform shift, so 14 px / 0.6 px reproduces the original Howlfall treatment.

## Running

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (relative paths, host anywhere)
npm test           # unit tests (Vitest)
npm run test:e2e   # browser end-to-end test (Playwright + Chromium; downloads the depth model)
```

### GitHub Pages

`.github/workflows/pages.yml` tests, builds and deploys the app on every push to `main`. You can also run it manually from the Actions tab. It needs a one-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Features

### Automatic depth
- **Depth estimation:** [Depth Anything V2 (small, int8 ONNX)](https://huggingface.co/onnx-community/depth-anything-v2-small) runs on your device with transformers.js and ONNX Runtime WebAssembly, in a background worker.
  - The ~27 MB model downloads from Hugging Face on first use and is cached by the browser.
  - The ONNX Runtime binary is served with the app.
- **Controls:**
  - **Depth strength:** the extra disparity between the nearest and farthest point, in output pixels.
  - **Focus plane:** the depth that stays at the base offset.
  - **Smoothing:** reduces warping at depth edges.
  - **Invert depth:** swaps near and far.
- **Depth preview:** a dedicated *Depth* view shows the estimated map (bright = near).
- **Fallback:** if depth estimation is unavailable (offline on first use, or very old browsers), the app falls back to the uniform shift and tells you.

### Framing
- **Import:** JPEG, PNG, WEBP (native decoding with EXIF orientation and colour-profile conversion to sRGB) and TIFF. You can also drag & drop or paste.
- **Aspect ratio:** 9:16, 1:1, 16:9, 4:3 or custom, applied to the whole output or to each eye.
- **Resolution:** 720p, 1080p, 1440p, 4K, 8K or custom pixel dimensions.
- **Fitting:** Fill, Fit (with a blurred, solid-colour or transparent background), Stretch, or a manual crop with an aspect-locked rectangle. Image scale and crop-position sliders are also available.

### Stereo controls
- **Base horizontal offset:** −100 to +100 px, with presets 0/5/10/14/20/30.
- **Vertical offset:** −10 to +10 px, fractional, with an on/off switch and a comfort warning above 2 px.
- **Configuration:** offset direction, which eye is displaced, and parallel (L | R) or cross (R | L) arrangement.
- **Edges:** *Extend* fills revealed edges with the surrounding real image. *Crop* zooms both views equally. An optional **stereo window mask** blanks the edge strips that only one eye can see.
- **Interpolation:** nearest, bilinear, bicubic or Lanczos, chosen separately for resizing and for sub-pixel displacement.

### 3D styles
The **Choose 3D style** panel shows live thumbnails of *your* photo in every style, each with what you need to view it.

| Style | Output |
|---|---|
| Side-by-side | Two full views, W/2 × H each (PNG / JPEG / WEBP) |
| Half side-by-side | Each eye rendered W × H, squeezed to W/2 (3D TVs, VR players) |
| Over / under, Half over / under | Views stacked vertically |
| Anaglyph | Red/cyan; Dubois (default), half-colour, full-colour or grey |
| Wiggle | Animated GIF or video (MP4/H.264, WebM fallback). Classic 2-frame flip or a smooth 6/12-frame sweep, adjustable speed |
| MPO | Multi-Picture JPEG with a left + right pair (CIPA DC-007), readable by 3D cameras, 3D displays, the Nintendo 3DS and StereoPhoto Maker |
| 3D photo motion | A glasses-free looping parallax animation, MP4 (30 fps) or GIF (15 fps). A virtual camera moves in front of the photo and near parts move more than far parts. Camera paths: circle, left-right sway, up-down sway, or zoom. Movement amount and loop length (1.5–8 s) are adjustable. It needs the depth map, and the depth panel's focus plane sets which depth stays still |

Exports always render at full resolution. The *Output* preview shows exactly what will be exported.

### Workflow
- **Batch:** process many photos with the current settings and download them as one ZIP. Dropping several files on the page does the same.
- **Share links:** the settings that differ from the defaults are stored in the URL (`#s=…`), and *Copy settings link* shares them. Photos are never part of the link.
- **Installable and offline:** the app is a PWA. After the first visit it works offline, and the depth model also works offline once it has been downloaded.
- **Preview modes:** output (wiggle and motion styles play animated), synchronised L/R compare with pixel readout, wiggle, difference ×4, anaglyph check, depth map, and the original with the crop editor.
- **Keyboard:** ←/→ nudges the offset (hold Shift for 0.1 px steps). ↑/↓ nudges the vertical offset. Ctrl/⌘+S exports.

## How it works

```
source ─► Resize/Crop ─► base frame (+ overscan margins, cached)
depth model ─► normalise/smooth ─► depth frame aligned with the base (cached)
                              ├─► reference view = exact crop of the base frame
                              └─► displaced view = per-pixel depth warp (or uniform shift) ─► vertical shift
                                         └─► format composition ─► preview / export
```

| # | Module | File |
|---|---|---|
| 1 | Image import | `io/import.ts` |
| 2 | Resizing & cropping | `core/layout.ts`, `core/resample.ts`, `core/background.ts` |
| 3–4 | Left / right view generators | `core/views.ts` |
| 5–6 | Displacement processors (uniform + depth warp) | `core/displace.ts`, `core/depth.ts` |
| — | Depth estimation | `depth/depth.worker.ts`, `depth/client.ts` |
| 7 | Composition engine (all formats) | `core/compose.ts`, `core/formats.ts` |
| 8 | Preview renderer | `ui/preview.ts` |
| 9 | Export engine | `worker/stereo.worker.ts`, `worker/video.ts`, `core/encode.ts`, `core/gif.ts`, `core/mpo.ts` |
| — | 3D photo motion | `core/motion.ts` (2-pass depth warp: horizontal, then vertical via transposition) |

Key properties:

- **Offsets in output pixels.** The photo is resized **once** into the eye frame at output resolution, and both views come from that same frame. They are never resized independently.
- **Depth warp.** Each output pixel is inverse-mapped to a sub-pixel source position.
  - Where two surfaces overlap, the nearer one wins.
  - Holes revealed behind foreground objects are filled by mirroring the neighbouring background, never by smearing the object.
  - With zero depth strength the warp reduces exactly to the uniform shift.
- **Exact shifts.** Integer uniform offsets are pure pixel copies. Fractional offsets use a fixed interpolation kernel.
- **No blank borders.** Overscan margins hold real neighbouring image content.
- **Real-time editing.** The resized frame and the aligned depth frame are cached. Changing an offset or the depth strength re-runs only the warp and composition steps.
- **Deterministic output.** For a given photo and depth map, the same settings always give identical bytes. The end-to-end test checks that a browser export matches the Node.js reference render byte for byte.

## Tests

- `tests/core.test.ts` covers geometry, kernels, exact and fractional displacement, borders, content preservation, determinism and lossless PNG.
- `tests/features.test.ts` covers:
  - depth normalisation;
  - depth warp equal to the uniform shift for flat depth;
  - occlusion and disocclusion handling;
  - geometry and composition of every format;
  - anaglyph colour mapping and wiggle frames;
  - GIF and MPO structure;
  - the stereo window mask;
  - share-link round trips and robustness;
  - motion paths, timing, near-vs-far parallax with no smearing, and deterministic full-size frames.

`e2e/smoke.mjs` drives the real UI in Chromium:
- It uploads PNG and TIFF files and waits for automatic depth analysis.
- It verifies byte-identical exports against Node.
- It exports every style through the picker cards and checks the files: PNG dimensions, MPO structure, GIF, MP4/WebM, and the 3D photo motion video and GIF frame counts.
- It checks batch ZIP, share links, presets, view modes, the mobile layout, and the production service worker working offline.
