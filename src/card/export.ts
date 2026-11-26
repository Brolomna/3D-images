/** ZIP export for a Layered 3D card: the three layers, layers.json, a preview and a standalone viewer. */
import { zipSync } from 'fflate';
import type { CardStack, StackLayer } from '../core/cardstack';
import type { RGBAImage } from '../core/types';

async function encode(img: RGBAImage, type: 'image/webp' | 'image/png', quality = 0.88): Promise<{ bytes: Uint8Array; ext: string }> {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  const blob = await c.convertToBlob({ type, quality });
  // Browsers without WebP encoding (Safari) return PNG instead.
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: blob.type === 'image/webp' ? 'webp' : 'png' };
}

/** Every layer side by side on green, a third of the size (like the tool's preview.png). */
function previewStrip(layers: RGBAImage[]): RGBAImage {
  const { width: W, height: H } = layers[0];
  const w = Math.max(1, Math.round(W / 3)), h = Math.max(1, Math.round(H / 3));
  const n = layers.length;
  const out: RGBAImage = { width: w * n, height: h, data: new Uint8ClampedArray(w * n * h * 4) };
  for (let k = 0; k < n; k++) {
    const src = layers[k];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / w)), sy = Math.min(src.height - 1, Math.floor((y * src.height) / h));
      const p = (sy * src.width + sx) * 4, o = (y * w * n + k * w + x) * 4;
      const a = src.data[p + 3] / 255;
      out.data[o] = src.data[p] * a + 40 * (1 - a);
      out.data[o + 1] = src.data[p + 1] * a + 160 * (1 - a);
      out.data[o + 2] = src.data[p + 2] * a + 60 * (1 - a);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** File name for a layer: bg / char / frame (Howlfall's pack editor names), else layer_<id>. */
export function layerFile(l: Pick<StackLayer, 'role' | 'id'>, ext: string, used: Set<string>): string {
  const base = l.role === 'bg' || l.role === 'char' || l.role === 'frame' ? l.role : `layer_${l.id.replace(/[^\w-]+/g, '_')}`;
  let name = `${base}.${ext}`;
  for (let i = 2; used.has(name); i++) name = `${base}_${i}.${ext}`;
  used.add(name);
  return name;
}

/** A self-contained viewer page that shows the three files with gyro / drag tilt. */
export function viewerHtml(stack: Pick<CardStack, 'win' | 'size'>, layers: { file: string; role: string; still: boolean; motion: { x: number; y: number } }[]): string {
  const { win, size } = stack;
  let topFrom = layers.length;
  while (topFrom > 0 && layers[topFrom - 1].still) topFrom--;
  const rel = `left:${(-win.x / win.w) * 100}%;top:${(-win.y / win.h) * 100}%;width:${100 / win.w}%;height:${100 / win.h}%`;
  const inWin = layers.slice(0, topFrom).map((l, i) => l.role === 'bg'
    ? `<img class="bg m" data-i="${i}" src="${l.file}" alt="">`
    : `<img class="${l.role === 'char' ? 'char ' : ''}m" data-i="${i}" style="${rel}" src="${l.file}" alt="">`).join('');
  const top = layers.slice(topFrom).map((l) => `<img class="top" src="${l.file}" alt="">`).join('');
  const motion = layers.map((l) => (l.still ? { x: 0, y: 0 } : l.motion));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>3D card</title>
<style>
html,body{margin:0;height:100%;background:#0e0f12;color:#e7e9ee;font:14px system-ui,sans-serif}
body{display:grid;place-items:center;gap:12px;overflow:hidden;touch-action:none}
.card{position:relative;width:min(92vw,calc((100dvh - 90px)*${(size[0] / size[1]).toFixed(5)}));aspect-ratio:${size[0]}/${size[1]};user-select:none}
.win{position:absolute;left:${win.x * 100}%;top:${win.y * 100}%;width:${win.w * 100}%;height:${win.h * 100}%;overflow:hidden}
.win img{position:absolute;will-change:transform}
.bg{width:124%;height:118%;left:-12%;top:-9%;object-fit:cover}
.char{filter:drop-shadow(0 10px 14px rgba(0,0,0,.55))}
.top{position:absolute;inset:0;width:100%;height:100%}
img{pointer-events:none;-webkit-user-drag:none}
button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #444;background:#1d2027;color:inherit}
</style></head><body>
<div class="card" id="card"><div class="win">${inWin}</div>${top}</div>
<button id="m" hidden>✨ Turn on motion</button>
<script>
const M=${JSON.stringify(motion)};let x=0,y=0,tx=0,ty=0,last=performance.now(),grav=null,rest=null,gyro=false,drag=null,moved=false;
const card=document.getElementById('card'),m=document.getElementById('m'),L=[...document.querySelectorAll('.m')];
const cl=v=>Math.max(-1,Math.min(1,v));
if(typeof DeviceOrientationEvent!=='undefined'&&matchMedia('(pointer:coarse)').matches)m.hidden=false;
m.onclick=async()=>{try{if(typeof DeviceOrientationEvent.requestPermission==='function'&&await DeviceOrientationEvent.requestPermission()!=='granted')return}catch(e){return}
addEventListener('deviceorientation',e=>{if(e.beta==null)return;const b=e.beta*Math.PI/180,g=e.gamma*Math.PI/180;let gx=-Math.cos(b)*Math.sin(g),gy=Math.sin(b);
const a=((screen.orientation&&screen.orientation.angle)||0)*Math.PI/180,c=Math.cos(a),s=Math.sin(a);grav=[gx*c+gy*s,-gx*s+gy*c];if(!rest)rest=grav});gyro=true;m.hidden=true};
card.onpointerdown=e=>{moved=false;drag={x0:e.clientX,y0:e.clientY,tx,ty};card.setPointerCapture(e.pointerId)};
card.onpointermove=e=>{const r=card.getBoundingClientRect();if(drag){const dx=(e.clientX-drag.x0)/(r.width/2),dy=(e.clientY-drag.y0)/(r.height/2);if(Math.abs(dx)+Math.abs(dy)>.03)moved=true;tx=cl(drag.tx+dx);ty=cl(drag.ty+dy)}
else if(e.pointerType==='mouse'&&!gyro){tx=cl(((e.clientX-r.left)/r.width-.5)*2);ty=cl(((e.clientY-r.top)/r.height-.5)*2)}};
card.onpointerup=card.onpointercancel=()=>{if(drag&&!moved){tx=ty=0;rest=grav}drag=null};
(function tick(now){const dt=Math.min(.1,(now-last)/1000);last=now;
if(gyro&&grav&&rest&&!drag){rest=[rest[0]+(grav[0]-rest[0])*dt*.35,rest[1]+(grav[1]-rest[1])*dt*.35];let dx=(grav[0]-rest[0])/.26,dy=(grav[1]-rest[1])/.26;if(Math.abs(dx)<.03)dx=0;if(Math.abs(dy)<.03)dy=0;tx=Math.tanh(1.15*dx);ty=-Math.tanh(1.15*dy)}
const k=1-Math.exp(-dt/.09);x+=(tx-x)*k;y+=(ty-y)*k;
for(const el of L){const v=M[+el.dataset.i];el.style.transform='translate3d('+(-x*v.x)+'%,'+(-y*v.y)+'%,0)'}requestAnimationFrame(tick)})(last);
</script></body></html>`;
}

/**
 * Build the ZIP: every layer (WebP, or PNG where WebP can't be encoded) —
 * bg / char / frame use the names Howlfall's pack editor expects —
 * layers.json (window + each layer's movement), preview.png and viewer.html.
 */
export async function cardZip(stack: CardStack): Promise<Blob> {
  const encoded = await Promise.all(stack.layers.map((l) => encode(l.image, 'image/webp', l.role === 'bg' ? 0.84 : 0.88)));
  const preview = await encode(previewStrip(stack.layers.map((l) => l.image)), 'image/png');
  const used = new Set<string>();
  const entries = stack.layers.map((l, i) => ({ file: layerFile(l, encoded[i].ext, used), name: l.name, role: l.role, still: l.still, motion: l.still ? { x: 0, y: 0 } : l.motion, depth: l.depth == null ? null : Math.round(l.depth * 1000) / 1000 }));
  const info = {
    mode: stack.mode, size: stack.size, window: stack.window, win: stack.win,
    bannerTop: stack.bannerTop, threshold: stack.threshold == null ? null : Math.round(stack.threshold * 1000) / 1000,
    ownBackground: !!stack.ownBackground,
    layers: entries,
  };
  const enc = new TextEncoder();
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    'preview.png': [preview.bytes, { level: 0 }],
    'layers.json': [enc.encode(JSON.stringify(info, null, 1)), { level: 6 }],
    'viewer.html': [enc.encode(viewerHtml(stack, entries)), { level: 6 }],
  };
  entries.forEach((e, i) => { files[e.file] = [encoded[i].bytes, { level: 0 }]; });
  return new Blob([zipSync(files) as BlobPart], { type: 'application/zip' });
}
