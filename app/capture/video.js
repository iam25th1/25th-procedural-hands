// Video capture of the 3D view, in two modes, both saved to the device.
//
// Live: canvas.captureStream into a MediaRecorder, started and stopped by the
// user. The codec is the most efficient one the browser records (tried in
// order with MediaRecorder.isTypeSupported: AV1, VP9, H.264 High, H.264,
// VP8), at an explicit high bitrate, not the browser's default.
//
// Offline: the quality path. The scene is stepped off the injected clock one
// fixed 1/60 s step per frame and every frame goes through a WebCodecs
// VideoEncoder, whatever the display rate: nothing is dropped and the file
// is 60 fps. The encoded frames are muxed here (webm.js, mp4.js).
//
// Files are saved with showSaveFilePicker where the browser has it, else as
// a download; either way the user chooses what happens to them.
import { muxWebM } from './webm.js';
import { muxMp4 } from './mp4.js';

export const FPS = 60;

// Bits per second for a size: 0.2 bits a pixel a frame, 8 to 40 Mbit/s.
export function bitrateFor(width, height, fps = FPS) {
  return Math.round(Math.min(40e6, Math.max(8e6, width * height * fps * 0.2)));
}

// Live ------------------------------------------------------------------------

const LIVE_TYPES = [
  ['video/webm;codecs=av01', 'AV1', 'webm'],
  ['video/mp4;codecs=av01', 'AV1', 'mp4'],
  ['video/webm;codecs=vp9', 'VP9', 'webm'],
  ['video/mp4;codecs=vp09', 'VP9', 'mp4'],
  ['video/mp4;codecs=avc1.640033', 'H.264 High', 'mp4'],
  ['video/mp4;codecs=avc1', 'H.264', 'mp4'],
  ['video/webm;codecs=vp8', 'VP8', 'webm'],
  ['video/webm', 'WebM', 'webm'],
  ['video/mp4', 'MP4', 'mp4'],
];

export function liveSupported() {
  return typeof MediaRecorder === 'function' && typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
}

export function pickLiveType() {
  for (const [type, label, ext] of LIVE_TYPES) if (MediaRecorder.isTypeSupported(type)) return { type, label, ext };
  return null;
}

// Starts recording at once. Returns { info, stop() -> Promise<{ blob, ... }> }.
export function startLive(canvas) {
  const pick = pickLiveType();
  if (!pick) throw new Error('This browser cannot record video from the page');
  const width = canvas.width;
  const height = canvas.height;
  const bitrate = bitrateFor(width, height);
  const stream = canvas.captureStream(FPS);
  const rec = new MediaRecorder(stream, { mimeType: pick.type, videoBitsPerSecond: bitrate });
  const chunks = [];
  rec.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) chunks.push(e.data); });
  const stopped = new Promise((resolve, reject) => {
    rec.addEventListener('stop', () => resolve());
    rec.addEventListener('error', (e) => reject(e.error || new Error('recording failed')));
  });
  rec.start(1000);
  const info = { mode: 'live', codec: pick.label, mime: pick.type, ext: pick.ext, width, height, bitrate, fps: FPS };
  return {
    info,
    async stop() {
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      for (const t of stream.getTracks()) t.stop();
      return { ...info, blob: new Blob(chunks, { type: pick.type.split(';')[0] }) };
    },
  };
}

// Offline ---------------------------------------------------------------------

const OFFLINE_CODECS = [
  { codec: 'vp09.00.41.08', label: 'VP9', container: 'webm', codecId: 'V_VP9', mime: 'video/webm' },
  { codec: 'avc1.640033', label: 'H.264 High', container: 'mp4', mime: 'video/mp4', avc: true },
  { codec: 'avc1.4d0033', label: 'H.264 Main', container: 'mp4', mime: 'video/mp4', avc: true },
  { codec: 'vp8', label: 'VP8', container: 'webm', codecId: 'V_VP8', mime: 'video/webm' },
];

export function offlineSupported() {
  return typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';
}

async function pickOffline(width, height, bitrate) {
  for (const c of OFFLINE_CODECS) {
    const config = { codec: c.codec, width, height, bitrate, framerate: FPS, latencyMode: 'quality', ...(c.avc ? { avc: { format: 'avc' } } : {}) };
    try {
      const s = await VideoEncoder.isConfigSupported(config);
      if (s && s.supported) return { ...c, config: s.config || config };
    } catch {
      // Not this one; try the next.
    }
  }
  return null;
}

// Which encoder offline rendering will use, asked once ahead of time so a
// click can name the file (and ask where to save it) straight away.
export async function probeOffline(width = 1920, height = 1080) {
  if (!offlineSupported()) return null;
  const pick = await pickOffline(width, height, bitrateFor(width, height));
  return pick ? { codec: pick.label, mime: pick.mime, ext: pick.container } : null;
}

// Renders `frames` frames: drawFrame(i) (it may return a promise) steps the scene and draws frame i into
// the canvas (at the output size); every one is encoded. onProgress(done, of)
// is called as it goes; abort.aborted stops it. Resolves to the file.
export async function renderOffline({ canvas, frames, drawFrame, onProgress = () => {}, abort = { aborted: false } }) {
  const width = canvas.width;
  const height = canvas.height;
  const bitrate = bitrateFor(width, height);
  const pick = await pickOffline(width, height, bitrate);
  if (!pick) throw new Error('This browser has no video encoder for the page (WebCodecs)');
  const out = [];
  let description = null;
  let failure = null;
  const encoder = new VideoEncoder({
    output(chunk, meta) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      if (meta && meta.decoderConfig && meta.decoderConfig.description) description = new Uint8Array(meta.decoderConfig.description.buffer ? meta.decoderConfig.description.buffer : meta.decoderConfig.description).slice();
      out.push({ data, key: chunk.type === 'key', timestampUs: chunk.timestamp });
    },
    error(e) { failure = e; },
  });
  encoder.configure(pick.config);
  const waitQueue = () => new Promise((resolve) => { const check = () => (encoder.encodeQueueSize <= 2 ? resolve() : setTimeout(check, 1)); check(); });
  try {
    for (let i = 0; i < frames; i++) {
      if (abort.aborted) throw new DOMException('Rendering cancelled', 'AbortError');
      if (failure) throw failure;
      await drawFrame(i);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
      frame.close();
      if (encoder.encodeQueueSize > 2) await waitQueue();
      if (i % 3 === 2 || i === frames - 1) {
        onProgress(i + 1, frames);
        // Let the page paint the progress.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failure) throw failure;
  if (out.length !== frames) throw new Error(`the encoder returned ${out.length} of ${frames} frames`);
  let bytes;
  if (pick.container === 'webm') bytes = muxWebM({ codecId: pick.codecId, width, height, fps: FPS, frames: out });
  else {
    if (!description) throw new Error('the H.264 encoder gave no decoder configuration');
    bytes = muxMp4({ avcC: description, width, height, fps: FPS, frames: out });
  }
  return { mode: 'offline', codec: pick.label, mime: pick.mime, ext: pick.container, width, height, bitrate, fps: FPS, frames, blob: new Blob([bytes], { type: pick.mime }) };
}

// Saving ----------------------------------------------------------------------

// A file name carrying the scene, the action and the time.
export function videoName(scene, action, ext, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const slug = (s) => String(s || 'free').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'free';
  return `hands-${slug(scene)}-${slug(action)}-${stamp}.${ext}`;
}

// Must be called straight from the user's click (the picker needs the
// gesture). Resolves to a file handle, 'cancelled', or null when the browser
// has no picker (then the file is downloaded instead).
export function askWhereToSave(name, mime, ext) {
  if (typeof window.showSaveFilePicker !== 'function') return Promise.resolve(null);
  try {
    return window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Video', accept: { [mime]: [`.${ext}`] } }] })
      .catch((e) => (e && e.name === 'AbortError' ? 'cancelled' : null));
  } catch {
    return Promise.resolve(null);
  }
}

export async function saveVideo(blob, name, handle) {
  if (handle && handle !== 'cancelled') {
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return 'saved';
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return 'downloaded';
}
