// A minimal MP4 (ISO BMFF) muxer for one H.264 video track: ftyp, then moov
// ahead of mdat (so a player can start before it has the whole file), one
// chunk holding every sample, a sync sample table for the key frames and a
// composition offset table if the encoder reordered frames. Pure data in,
// bytes out: no DOM, so Node tests it.
//
// avcC: the AVCDecoderConfigurationRecord (VideoEncoder's
// decoderConfig.description with avc format 'avc').
// frames: [{ data: Uint8Array, key: boolean, timestampUs: number }] in
// decode order.

const TIMESCALE = 60000; // track ticks per second: 1000 ticks a frame at 60 fps

function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; }
function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n); return b; }
function i32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n); return b; }
function str(s) { return new TextEncoder().encode(s); }
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function box(type, ...parts) { const body = concat(parts); return concat([u32(body.length + 8), str(type), body]); }
function full(type, version, flags, ...parts) { return box(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts); }
const zeros = (n) => new Uint8Array(n);
const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

export function muxMp4({ avcC, width, height, fps, frames }) {
  if (!frames.length || !frames[0].key) throw new Error('mp4: frames must start with a key frame');
  const delta = Math.round(TIMESCALE / fps);
  const n = frames.length;
  const duration = n * delta;
  const moovMs = Math.round((duration / TIMESCALE) * 1000);
  // Composition offsets: presentation minus decode time, per sample.
  const t0 = frames[0].timestampUs;
  const offsets = frames.map((f, i) => Math.round(((f.timestampUs - t0) / 1e6) * TIMESCALE) - i * delta);
  const reordered = offsets.some((o) => o !== 0);

  const stsdEntry = box('avc1',
    zeros(6), u16(1), // reserved, data reference index
    zeros(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1),
    Uint8Array.of(0, ...zeros(31)), u16(0x0018), u16(0xffff),
    box('avcC', avcC));
  const stbl = box('stbl',
    full('stsd', 0, 0, u32(1), stsdEntry),
    full('stts', 0, 0, u32(1), u32(n), u32(delta)),
    ...(reordered ? [full('ctts', 1, 0, u32(n), ...frames.flatMap((f, i) => [u32(1), i32(offsets[i])]))] : []),
    full('stss', 0, 0, u32(frames.filter((f) => f.key).length), ...frames.flatMap((f, i) => (f.key ? [u32(i + 1)] : []))),
    full('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
    full('stsz', 0, 0, u32(0), u32(n), ...frames.map((f) => u32(f.data.length))),
    full('stco', 0, 0, u32(1), u32(0))); // offset patched below
  const trak = box('trak',
    full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(moovMs), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16)),
    box('mdia',
      full('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(duration), u16(0x55c4), u16(0)),
      full('hdlr', 0, 0, u32(0), str('vide'), zeros(12), str('Video\0')),
      box('minf',
        full('vmhd', 0, 1, zeros(8)),
        box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
        stbl)));
  const moov = box('moov',
    full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(moovMs), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2)),
    trak);
  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
  const mdatBody = concat(frames.map((f) => f.data));
  const out = concat([ftyp, moov, u32(mdatBody.length + 8), str('mdat'), mdatBody]);
  // Patch the one chunk offset: the first sample starts right after mdat's header.
  const stco = findBox(out, 'stco');
  new DataView(out.buffer).setUint32(stco + 16, ftyp.length + moov.length + 8);
  return out;
}

// Offset of the first box of a type anywhere in the file (depth first).
export function findBox(bytes, type, start = 0, end = bytes.length) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf']);
  let o = start;
  while (o + 8 <= end) {
    const size = dv.getUint32(o);
    const t = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    if (t === type) return o;
    if (containers.has(t)) { const hit = findBox(bytes, type, o + 8, o + size); if (hit >= 0) return hit; }
    if (size < 8) break;
    o += size;
  }
  return -1;
}

// Read back what a player needs (for the tests): sample count, key frames,
// size, duration and whether every sample lies inside mdat.
export function readMp4(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (t) => findBox(bytes, t);
  const stsz = at('stsz');
  const n = dv.getUint32(stsz + 16);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += dv.getUint32(stsz + 20 + i * 4);
  const first = dv.getUint32(at('stco') + 16);
  const mdat = at('mdat');
  const mdhd = at('mdhd');
  const tkhd = at('tkhd');
  return {
    brand: String.fromCharCode(...bytes.subarray(8, 12)),
    moovBeforeMdat: at('moov') < mdat,
    samples: n,
    keys: dv.getUint32(at('stss') + 12),
    width: dv.getUint32(tkhd + 84) >>> 16,
    height: dv.getUint32(tkhd + 88) >>> 16,
    durationS: dv.getUint32(mdhd + 24) / dv.getUint32(mdhd + 20),
    samplesInsideMdat: first === mdat + 8 && first + sum === mdat + dv.getUint32(mdat),
    // avcC sits inside the avc1 sample entry, after its fixed fields.
    avcC: (() => { const e = at('stsd'); const avc1 = e + 16; const t = (o) => String.fromCharCode(...bytes.subarray(o + 4, o + 8)); return t(avc1) === 'avc1' && t(avc1 + 86) === 'avcC'; })(),
  };
}
