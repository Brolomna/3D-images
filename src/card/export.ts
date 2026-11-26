/** ZIP export for a Layered 3D card: the three layers, layers.json, a preview and a standalone viewer. */
import { zipSync } from 'fflate';
import type { CardLayers } from '../core/cardlayers';
import type { RGBAImage } from '../core/types';
import { PARALLAX } from './viewer';

async function encode(img: RGBAImage, type: 'image/webp' | 'image/png', quality = 0.88): Promise<{ bytes: Uint8Array; ext: string }> {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  const blob = await c.convertToBlob({ type, quality });
  // Browsers without WebP encoding (Safari) return PNG instead.
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: blob.type === 'image/webp' ? 'webp' : 'png' };
}

/** frame | background | character on green, a third of the size (like the tool's preview.png). */
function previewStrip(l: Pick<CardLayers, 'frame' | 'char' | 'bg'>): RGBAImage {
  const { width: W, height: H } = l.frame;
  const w = Math.max(1, Math.round(W / 3)), h = Math.max(1, Math.round(H / 3));
  const out: RGBAImage = { width: w * 3, height: h, data: new Uint8ClampedArray(w * 3 * h * 4) };
  const layers = [l.frame, l.bg, l.char];
  for (let k = 0; k < 3; k++) {
    const src = layers[k];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / w)), sy = Math.min(src.height - 1, Math.floor((y * src.height) / h));
      const p = (sy * src.width + sx) * 4, o = (y * w * 3 + k * w + x) * 4;
      const a = src.data[p + 3] / 255;
      out.data[o] = src.data[p] * a + 40 * (1 - a);
      out.data[o + 1] = src.data[p + 1] * a + 160 * (1 - a);
      out.data[o + 2] = src.data[p + 2] * a + 60 * (1 - a);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** A self-contained viewer page that shows the three files with gyro / drag tilt. */
export function viewerHtml(info: CardLayers['info'], files: { frame: string; char: string; bg: string }): string {
  const { win, size } = info;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>3D card</title>
<style>
html,body{margin:0;height:100%;background:#0e0f12;color:#e7e9ee;font:14px system-ui,sans-serif}
body{display:grid;place-items:center;gap:12px;overflow:hidden;touch-action:none}
.card{position:relative;width:min(92vw,calc((100dvh - 90px)*${(size[0] / size[1]).toFixed(5)}));aspect-ratio:${size[0]}/${size[1]};user-select:none}
.win{position:absolute;left:${win.x * 100}%;top:${win.y * 100}%;width:${win.w * 100}%;height:${win.h * 100}%;overflow:hidden}
.bg{position:absolute;width:124%;height:118%;left:-12%;top:-9%;object-fit:cover;will-change:transform}
.char{position:absolute;left:${(-win.x / win.w) * 100}%;top:${(-win.y / win.h) * 100}%;width:${100 / win.w}%;height:${100 / win.h}%;filter:drop-shadow(0 10px 14px rgba(0,0,0,.55));will-change:transform}
.frame{position:absolute;inset:0;width:100%;height:100%}
img{pointer-events:none;-webkit-user-drag:none}
button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid #444;background:#1d2027;color:inherit}
</style></head><body>
<div class="card" id="card"><div class="win"><img class="bg" id="bg" src="${files.bg}" alt=""><img class="char" id="ch" src="${files.char}" alt=""></div><img class="frame" src="${files.frame}" alt=""></div>
<button id="m" hidden>✨ Turn on motion</button>
<script>
const P=${JSON.stringify(PARALLAX)};let x=0,y=0,tx=0,ty=0,last=performance.now(),grav=null,rest=null,gyro=false,drag=null,moved=false;
const card=document.getElementById('card'),bg=document.getElementById('bg'),ch=document.getElementById('ch'),m=document.getElementById('m');
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
bg.style.transform='translate3d('+(-x*P.bg.x)+'%,'+(-y*P.bg.y)+'%,0)';ch.style.transform='translate3d('+(-x*P.char.x)+'%,'+(-y*P.char.y)+'%,0)';requestAnimationFrame(tick)})(last);
</script></body></html>`;
}

/** Build the ZIP: frame / char / bg (WebP, or PNG where WebP can't be encoded), layers.json, preview.png, viewer.html. */
export async function cardZip(l: Pick<CardLayers, 'frame' | 'char' | 'bg' | 'info'>): Promise<Blob> {
  const [frame, char, bg, preview] = await Promise.all([
    encode(l.frame, 'image/webp', 0.88), encode(l.char, 'image/webp', 0.88), encode(l.bg, 'image/webp', 0.84), encode(previewStrip(l), 'image/png'),
  ]);
  const names = { frame: `frame.${frame.ext}`, char: `char.${char.ext}`, bg: `bg.${bg.ext}` };
  const enc = new TextEncoder();
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    [names.frame]: [frame.bytes, { level: 0 }],
    [names.char]: [char.bytes, { level: 0 }],
    [names.bg]: [bg.bytes, { level: 0 }],
    'preview.png': [preview.bytes, { level: 0 }],
    'layers.json': [enc.encode(JSON.stringify(l.info, null, 1)), { level: 6 }],
    'viewer.html': [enc.encode(viewerHtml(l.info, names)), { level: 6 }],
  };
  return new Blob([zipSync(files) as BlobPart], { type: 'application/zip' });
}
