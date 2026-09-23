// A minimal WebM (Matroska) muxer for one video track of encoded frames:
// EBML header, Segment with Info (duration), Tracks, one Cluster per key
// frame, and Cues so players can seek. Pure data in, bytes out: no DOM, so
// Node tests it. Sizes are all known because the whole file is built in
// memory once the frames are encoded.
//
// frames: [{ data: Uint8Array, key: boolean, timestampUs: number }] in
// decode order, with a key frame first.

const enc = new TextEncoder();

// EBML variable-length size: the shortest length that holds n.
function vintSize(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = new Uint8Array(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
      out[0] |= 1 << (8 - len);
      return out;
    }
  }
  throw new Error('webm: element too large');
}

function idBytes(id) {
  const out = [];
  let v = id;
  while (v > 0) { out.unshift(v & 0xff); v = Math.floor(v / 256); }
  return Uint8Array.from(out);
}

function uint(n) {
  const out = [];
  let v = n;
  do { out.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0);
  return Uint8Array.from(out);
}

function float64(x) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, x);
  return b;
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// An element: id, size, payload (bytes, or a list of child elements).
function el(id, payload) {
  const body = Array.isArray(payload) ? concat(payload) : payload;
  return concat([idBytes(id), vintSize(body.length), body]);
}

const ID = {
  EBML: 0x1A45DFA3, EBMLVersion: 0x4286, EBMLReadVersion: 0x42F7, EBMLMaxIDLength: 0x42F2, EBMLMaxSizeLength: 0x42F3,
  DocType: 0x4282, DocTypeVersion: 0x4287, DocTypeReadVersion: 0x4285,
  Segment: 0x18538067, Info: 0x1549A966, TimecodeScale: 0x2AD7B1, MuxingApp: 0x4D80, WritingApp: 0x5741, Duration: 0x4489,
  Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackUID: 0x73C5, TrackType: 0x83, CodecID: 0x86,
  DefaultDuration: 0x23E383, Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA,
  Cluster: 0x1F43B675, Timecode: 0xE7, SimpleBlock: 0xA3,
  Cues: 0x1C53BB6B, CuePoint: 0xBB, CueTime: 0xB3, CueTrackPositions: 0xB7, CueTrack: 0xF7, CueClusterPosition: 0xF1,
};
export const WEBM_IDS = ID;

// codecId: 'V_VP9' or 'V_VP8'. fps: the frame rate the frames were made at.
export function muxWebM({ codecId, width, height, fps, frames, app = 'hands sandbox' }) {
  if (!frames.length || !frames[0].key) throw new Error('webm: frames must start with a key frame');
  const frameMs = 1000 / fps;
  const durationMs = frames.length * frameMs;
  const header = el(ID.EBML, [
    el(ID.EBMLVersion, uint(1)), el(ID.EBMLReadVersion, uint(1)), el(ID.EBMLMaxIDLength, uint(4)), el(ID.EBMLMaxSizeLength, uint(8)),
    el(ID.DocType, enc.encode('webm')), el(ID.DocTypeVersion, uint(4)), el(ID.DocTypeReadVersion, uint(2)),
  ]);
  const info = el(ID.Info, [el(ID.TimecodeScale, uint(1000000)), el(ID.MuxingApp, enc.encode(app)), el(ID.WritingApp, enc.encode(app)), el(ID.Duration, float64(durationMs))]);
  const tracks = el(ID.Tracks, [el(ID.TrackEntry, [
    el(ID.TrackNumber, uint(1)), el(ID.TrackUID, uint(1)), el(ID.TrackType, uint(1)), el(ID.CodecID, enc.encode(codecId)),
    el(ID.DefaultDuration, uint(Math.round(1e9 / fps))),
    el(ID.Video, [el(ID.PixelWidth, uint(width)), el(ID.PixelHeight, uint(height))]),
  ])]);
  // One cluster per key frame; block times are relative to the cluster's,
  // in milliseconds, and must fit a signed 16-bit number.
  const clusters = [];
  let current = null;
  for (const f of frames) {
    const ms = Math.round(f.timestampUs / 1000);
    if (f.key || !current || ms - current.ms > 30000) { current = { ms, blocks: [] }; clusters.push(current); }
    const rel = ms - current.ms;
    const head = new Uint8Array(4);
    head[0] = 0x81; // track 1
    new DataView(head.buffer).setInt16(1, rel);
    head[3] = f.key ? 0x80 : 0x00;
    current.blocks.push(el(ID.SimpleBlock, concat([head, f.data])));
  }
  const clusterBytes = clusters.map((c) => el(ID.Cluster, [el(ID.Timecode, uint(c.ms)), ...c.blocks]));
  // Cues point at each cluster's offset from the start of the segment's data.
  let offset = info.length + tracks.length;
  const cuePoints = clusters.map((c, i) => {
    const cp = el(ID.CuePoint, [el(ID.CueTime, uint(c.ms)), el(ID.CueTrackPositions, [el(ID.CueTrack, uint(1)), el(ID.CueClusterPosition, uint(offset))])]);
    offset += clusterBytes[i].length;
    return cp;
  });
  const segment = el(ID.Segment, [info, tracks, ...clusterBytes, el(ID.Cues, cuePoints)]);
  return concat([header, segment]);
}

// Read back the top of a WebM file (for the tests): the elements under the
// segment, the codec, the size, the duration and the blocks.
export function readWebM(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readId = (o) => { const b = bytes[o]; const len = b >= 0x80 ? 1 : b >= 0x40 ? 2 : b >= 0x20 ? 3 : 4; let v = 0; for (let i = 0; i < len; i++) v = v * 256 + bytes[o + i]; return { v, len }; };
  const readSize = (o) => { const b = bytes[o]; let len = 1; while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++; let v = b & (0xff >> len); for (let i = 1; i < len; i++) v = v * 256 + bytes[o + i]; return { v, len }; };
  const children = (start, end) => { const out = []; let o = start; while (o < end) { const id = readId(o); const sz = readSize(o + id.len); const body = o + id.len + sz.len; out.push({ id: id.v, start: body, end: body + sz.v }); o = body + sz.v; } return out; };
  const top = children(0, bytes.length);
  const seg = top.find((e) => e.id === ID.Segment);
  // A live recording's segment has an unknown size (all ones): read to the end.
  const parts = children(seg.start, Math.min(seg.end, bytes.length));
  const find = (list, id) => list.find((e) => e.id === id);
  const uintAt = (e) => { let v = 0; for (let i = e.start; i < e.end; i++) v = v * 256 + bytes[i]; return v; };
  const info = children(find(parts, ID.Info).start, find(parts, ID.Info).end);
  const track = children(find(children(find(parts, ID.Tracks).start, find(parts, ID.Tracks).end), ID.TrackEntry).start, find(children(find(parts, ID.Tracks).start, find(parts, ID.Tracks).end), ID.TrackEntry).end);
  const video = children(find(track, ID.Video).start, find(track, ID.Video).end);
  const codec = new TextDecoder().decode(bytes.subarray(find(track, ID.CodecID).start, find(track, ID.CodecID).end));
  let blocks = 0;
  let keys = 0;
  for (const c of parts.filter((e) => e.id === ID.Cluster)) for (const b of children(c.start, c.end).filter((e) => e.id === ID.SimpleBlock)) { blocks++; if (bytes[b.start + 3] & 0x80) keys++; }
  return {
    ebml: top[0].id === ID.EBML,
    codec,
    width: uintAt(find(video, ID.PixelWidth)),
    height: uintAt(find(video, ID.PixelHeight)),
    // A live recording (MediaRecorder) may carry no duration.
    durationMs: find(info, ID.Duration) ? (find(info, ID.Duration).end - find(info, ID.Duration).start === 8 ? dv.getFloat64(find(info, ID.Duration).start) : dv.getFloat32(find(info, ID.Duration).start)) : null,
    clusters: parts.filter((e) => e.id === ID.Cluster).length,
    blocks,
    keys,
    cues: Boolean(find(parts, ID.Cues)),
  };
}
