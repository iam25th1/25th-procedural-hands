// The video muxers, under Node: files built from synthetic encoded frames read
// back with the structure a player needs. The real encoders and playback are
// checked in a browser by hands:check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { muxWebM, readWebM } from '../app/capture/webm.js';
import { muxMp4, readMp4 } from '../app/capture/mp4.js';

const frames = (n, keyEvery = 120) => Array.from({ length: n }, (_, i) => ({
  data: Uint8Array.from({ length: 50 + (i % 7) * 13 }, (__, k) => (i * 31 + k) & 255),
  key: i % keyEvery === 0,
  timestampUs: Math.round((i * 1e6) / 60),
}));

test('webm: header, one track, a cluster per key frame, cues, every frame a block, duration at 60 fps', () => {
  const f = frames(300);
  const r = readWebM(muxWebM({ codecId: 'V_VP9', width: 1920, height: 1080, fps: 60, frames: f }));
  assert.equal(r.ebml, true);
  assert.equal(r.codec, 'V_VP9');
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1080);
  assert.equal(r.blocks, 300);
  assert.equal(r.keys, 3);
  assert.equal(r.clusters, 3);
  assert.equal(r.cues, true);
  assert.ok(Math.abs(r.durationMs - 5000) < 1e-9);
});

test('mp4: moov before mdat, every sample inside mdat, key frames listed, size and duration at 60 fps', () => {
  const f = frames(180, 60);
  const avcC = Uint8Array.of(1, 0x64, 0, 0x33, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x33, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80);
  const r = readMp4(muxMp4({ avcC, width: 1280, height: 720, fps: 60, frames: f }));
  assert.equal(r.brand, 'isom');
  assert.equal(r.moovBeforeMdat, true);
  assert.equal(r.samples, 180);
  assert.equal(r.keys, 3);
  assert.equal(r.width, 1280);
  assert.equal(r.height, 720);
  assert.ok(Math.abs(r.durationS - 3) < 1e-9);
  assert.equal(r.samplesInsideMdat, true);
  assert.equal(r.avcC, true);
});

test('muxers refuse a stream that does not start on a key frame', () => {
  const f = frames(10);
  f[0].key = false;
  assert.throws(() => muxWebM({ codecId: 'V_VP9', width: 2, height: 2, fps: 60, frames: f }), /key frame/);
  assert.throws(() => muxMp4({ avcC: Uint8Array.of(1), width: 2, height: 2, fps: 60, frames: f }), /key frame/);
});
