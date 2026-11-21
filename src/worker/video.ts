/**
 * Wiggle video encoder (WebCodecs). Prefers MP4/H.264 for compatibility and
 * falls back to WebM/VP9 or VP8 where H.264 encoding is unavailable.
 */
import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from 'mp4-muxer';
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from 'webm-muxer';
import type { RGBAImage } from '../core/types';

/** H.264 High profile codec string for the smallest level that fits the frame. */
function avcCodec(w: number, h: number): string {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const levels: [number, string][] = [[3600, '1f'], [5120, '20'], [8192, '28'], [22080, '32'], [36864, '33'], [139264, '3c']];
  const lv = levels.find(([max]) => mbs <= max)?.[1] ?? '3c';
  return `avc1.6400${lv}`;
}

interface Candidate { container: 'mp4' | 'webm'; codec: string; muxCodec: string }

export async function encodeWiggleVideo(frames: RGBAImage[], frameMs: number, minDurationMs = 3000): Promise<Blob> {
  if (typeof VideoEncoder === 'undefined') throw new Error('Video export needs WebCodecs (recent Chrome, Edge, Safari or Firefox). Use GIF instead.');
  const { width, height } = frames[0];
  const fps = 1000 / frameMs;
  const bitrate = Math.round(Math.min(40e6, Math.max(2e6, width * height * fps * 0.2)));
  const candidates: Candidate[] = [
    { container: 'mp4', codec: avcCodec(width, height), muxCodec: 'avc' },
    { container: 'webm', codec: 'vp09.00.51.08', muxCodec: 'V_VP9' },
    { container: 'webm', codec: 'vp8', muxCodec: 'V_VP8' },
  ];
  let chosen: { c: Candidate; config: VideoEncoderConfig } | null = null;
  for (const c of candidates) {
    const config: VideoEncoderConfig = { codec: c.codec, width, height, bitrate, framerate: fps, latencyMode: 'quality' };
    if (c.muxCodec === 'avc') (config as VideoEncoderConfig & { avc?: { format: string } }).avc = { format: 'avc' };
    try {
      const s = await VideoEncoder.isConfigSupported(config);
      if (s.supported) { chosen = { c, config }; break; }
    } catch { /* try next */ }
  }
  if (!chosen) throw new Error(`This browser cannot encode ${width}×${height} video. Try a smaller size or GIF.`);

  const { c, config } = chosen;
  const mp4 = c.container === 'mp4';
  const target = mp4 ? new Mp4Target() : new WebmTarget();
  const muxer = mp4
    ? new Mp4Muxer({ target: target as Mp4Target, video: { codec: 'avc', width, height }, fastStart: 'in-memory' })
    : new WebmMuxer({ target: target as WebmTarget, video: { codec: c.muxCodec, width, height } });
  let error: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => (muxer as Mp4Muxer<Mp4Target>).addVideoChunk(chunk, meta),
    error: (e) => { error = e as Error; },
  });
  encoder.configure(config);
  const cycles = Math.max(1, Math.ceil(minDurationMs / (frames.length * frameMs)));
  const durUs = Math.round(frameMs * 1000);
  let n = 0;
  for (let cyc = 0; cyc < cycles; cyc++) {
    for (const f of frames) {
      const vf = new VideoFrame(f.data, { format: 'RGBA', codedWidth: width, codedHeight: height, timestamp: n * durUs, duration: durUs });
      encoder.encode(vf, { keyFrame: n % (frames.length * 4) === 0 });
      vf.close();
      n++;
      if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
    }
  }
  await encoder.flush();
  encoder.close();
  if (error) throw error;
  muxer.finalize();
  return new Blob([(target as Mp4Target).buffer], { type: mp4 ? 'video/mp4' : 'video/webm' });
}
