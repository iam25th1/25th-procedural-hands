// Per-finger control, counting, finger sets and the gesture registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, STEP, GESTURES, COUNTING, registerGesture, limitMargin, penetration, objectPenetration, DIGITS } from '../src/index.js';
import { COUPLING, LIMITS_DEG } from '../src/anatomy.js';
import { XR_PREFIX } from '../src/skeleton.js';

const run = (h, seconds, fn) => { for (let i = 0; i < Math.round(seconds / STEP); i++) { h.step(); if (fn) fn(i * STEP); } };
const deg = (r) => (r * 180) / Math.PI;
const FINGERS = ['index', 'middle', 'ring', 'little'];
const jn = (f, seg) => `${XR_PREFIX[f]}-${seg}`;
const NEIGHBOURS = { index: ['middle'], middle: ['index', 'ring'], ring: ['middle', 'little'], little: ['ring'] };

test('each finger reaches its full range on every joint, independently, on either hand, while neighbours stay inside natural coupling', () => {
  for (const side of ['left', 'right']) {
    for (const f of FINGERS) {
      const h = create({ reducedMotion: true });
      h.setPose('both', 'open', { snap: true });
      for (const d of FINGERS) h.setFinger(side, d, 0, 0, { snap: true });
      h.setFingerJoint(side, f, 'mcp', 1);
      h.setFingerJoint(side, f, 'pip', 1);
      h.setFingerJoint(side, f, 'dip', 1);
      run(h, 1.2);
      const L = LIMITS_DEG.finger;
      assert.ok(deg(h.joint(side, jn(f, 'phalanx-proximal')).channels.flex) >= L.mcp.flex[1] - 1.5, `${side} ${f} MCP full`);
      assert.ok(deg(h.joint(side, jn(f, 'phalanx-intermediate')).channels.flex) >= L.pip.flex[1] - 1.5, `${side} ${f} PIP full`);
      assert.ok(deg(h.joint(side, jn(f, 'phalanx-distal')).channels.flex) >= L.dip.flex[1] - 1.5, `${side} ${f} DIP full`);
      // Neighbours are under control at curl 0 (so they do not follow at all)
      // and the one finger curls alone.
      for (const n of NEIGHBOURS[f]) assert.ok(deg(h.joint(side, jn(n, 'phalanx-intermediate')).channels.flex) < 3, `${side} ${n} held straight while ${f} curls`);
      // Released neighbours follow by at most the enslaving fraction.
      for (const d of FINGERS) if (d !== f) h.releaseFingers(side, d);
      run(h, 1.2);
      for (const n of NEIGHBOURS[f]) {
        const k = (COUPLING.enslave[n] || {})[f] || 0;
        const got = deg(h.joint(side, jn(n, 'phalanx-intermediate')).channels.flex);
        assert.ok(got <= k * L.pip.flex[1] + 4, `${side} ${n} follows ${f} by ${got.toFixed(1)} deg, coupling allows ${(k * L.pip.flex[1]).toFixed(1)}`);
      }
      assert.ok(limitMargin(h.skeleton).worst >= -1e-6);
    }
  }
});

test('thumb: full curl, spread and opposition, clamped to its limits', () => {
  for (const side of ['left', 'right']) {
    const h = create({ reducedMotion: true });
    h.setPose(side, 'open', { snap: true });
    h.setFingerJoint(side, 'thumb', 'mcp', 1);
    h.setFingerJoint(side, 'thumb', 'ip', 1);
    run(h, 1.2);
    assert.ok(deg(h.joint(side, 'thumb-phalanx-proximal').channels.flex) >= LIMITS_DEG.thumb.mcp.flex[1] - 1.5);
    assert.ok(deg(h.joint(side, 'thumb-phalanx-distal').channels.flex) >= LIMITS_DEG.thumb.ip.flex[1] - 1.5);
    h.setThumbOpposition(side, 1);
    run(h, 1.2);
    const cmc = h.joint(side, 'thumb-metacarpal').channels;
    assert.ok(deg(cmc.abd) > 30, `${side} opposition lifts the thumb palmar (${deg(cmc.abd).toFixed(1)})`);
    assert.ok(deg(cmc.twist) > 10, `${side} opposition pronates the thumb (${deg(cmc.twist).toFixed(1)})`);
    h.setFinger(side, 'thumb', 1, 0);
    h.setThumbOpposition(side, 0);
    run(h, 1.2);
    assert.ok(deg(h.joint(side, 'thumb-metacarpal').channels.flex) > 40, 'curl sweeps the thumb across the palm');
    assert.ok(limitMargin(h.skeleton).worst >= -1e-6);
  }
});

test('per-finger control blends over whatever pose is active, at any time', () => {
  const h = create({ reducedMotion: true });
  h.setPose('right', 'fist', { snap: true });
  h.setFinger('right', 'index', 0);
  run(h, 1);
  assert.ok(deg(h.joint('right', 'index-finger-phalanx-intermediate').channels.flex) < 8, 'index straightens out of the fist');
  assert.ok(deg(h.joint('right', 'ring-finger-phalanx-intermediate').channels.flex) > 90, 'the rest of the fist holds');
  h.gesture('v', { hand: 'right' });
  run(h, 1);
  assert.ok(deg(h.joint('right', 'middle-finger-phalanx-intermediate').channels.flex) < 8, 'the V plays under the control');
  assert.ok(deg(h.joint('right', 'index-finger-phalanx-intermediate').channels.flex) < 8);
});

function audit(h, label) {
  const m = limitMargin(h.skeleton);
  assert.ok(m.worst >= -1e-6, `${label}: past a limit at ${m.where} by ${-m.worst} deg`);
  for (const side of ['left', 'right']) {
    const p = penetration(h.skeleton, side);
    assert.ok(p.worst <= 1, `${label} ${side}: self-penetration ${p.worst.toFixed(2)} mm at ${p.where}`);
  }
}

test('counting 1 to 5 both ways on both hands: the right digits extend, the rest fold, no self-penetration', () => {
  for (const style of ['index', 'thumb']) {
    for (let n = 1; n <= 5; n++) {
      const h = create({ reducedMotion: true });
      h.count('both', n, style, { snap: true });
      run(h, 0.6);
      audit(h, `${style} ${n}`);
      const up = new Set(COUNTING[style][n - 1]);
      for (const side of ['left', 'right']) {
        for (const f of FINGERS) {
          const pip = deg(h.joint(side, jn(f, 'phalanx-intermediate')).channels.flex);
          if (up.has(f)) assert.ok(pip < 20, `${style} ${n} ${side} ${f} extended (${pip.toFixed(1)})`);
          else assert.ok(pip > 80, `${style} ${n} ${side} ${f} folded (${pip.toFixed(1)})`);
        }
        const tip = h.joint(side, 'thumb-tip').pos;
        const idx = h.joint(side, 'index-finger-metacarpal').pos;
        const wr = h.joint(side, 'wrist').pos;
        const out = Math.hypot(tip[0] - idx[0], tip[1] - idx[1], tip[2] - idx[2]);
        if (up.has('thumb')) assert.ok(out > 0.07, `${style} ${n} ${side} thumb out (${out.toFixed(3)} m from the index base)`);
        void wr;
      }
    }
  }
});

test('any combination of digits from a set: middle only, index and little, thumb and little, none', () => {
  for (const set of [['middle'], ['index', 'little'], ['thumb', 'little'], ['ring'], [], ['thumb', 'index', 'middle', 'ring', 'little']]) {
    const h = create({ reducedMotion: true });
    h.showFingers('both', set, { snap: true });
    run(h, 0.6);
    audit(h, `set ${set.join('+') || 'none'}`);
    for (const f of FINGERS) {
      const pip = deg(h.joint('right', jn(f, 'phalanx-intermediate')).channels.flex);
      if (set.includes(f)) assert.ok(pip < 20, `${set} ${f} extended`);
      else assert.ok(pip > 80, `${set} ${f} folded`);
    }
  }
  assert.throws(() => create().showFingers('right', ['toe']), /unknown digit/);
});

test('every gesture is reachable, inside limits and free of self-penetration on both hands, sampled at 60 fps', () => {
  for (const [name, entry] of Object.entries(GESTURES)) {
    const h = create({ reducedMotion: false });
    h.gesture(name);
    run(h, 2.0, (t) => { if (t > 0.3) audit(h, `${name} at ${t.toFixed(2)} s`); });
    // Reachable: the pose the gesture names is where the digits ended up.
    if (entry.pose && !entry.osc) {
      const target = h.rig.targetChannels('right');
      for (const f of FINGERS) {
        const name2 = jn(f, 'phalanx-intermediate');
        const got = h.joint('right', name2).channels.flex;
        assert.ok(Math.abs(got - target[name2].flex) < 0.12, `${name} ${f} reached (${deg(got).toFixed(1)} vs ${deg(target[name2].flex).toFixed(1)})`);
      }
    }
    if (entry.object) {
      const held = h.held('right');
      assert.ok(held, `${name} holds its object`);
      const p = objectPenetration(h.skeleton, 'right', held, h.contacts('right'));
      assert.ok(p.worst <= 1, `${name} object penetration ${p.worst.toFixed(2)} mm`);
    }
  }
});

test('adding a gesture is data: register an entry and play it', () => {
  registerGesture('rockOn', { pose: 'set:index+little', label: 'Rock on' });
  const h = create({ reducedMotion: true });
  h.gesture('rockOn', { hand: 'left' });
  run(h, 1);
  assert.ok(deg(h.joint('left', 'pinky-finger-phalanx-intermediate').channels.flex) < 20);
  assert.ok(deg(h.joint('left', 'middle-finger-phalanx-intermediate').channels.flex) > 80);
  audit(h, 'rockOn');
  delete GESTURES.rockOn;
  assert.ok(DIGITS.length === 5);
});
