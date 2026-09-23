import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Clock, STEP } from '../src/clock.js';

test('clock advances in exact fixed steps and never drifts', () => {
  const c = new Clock({ seed: 7 });
  let calls = 0;
  c.onStep((dt, t) => { calls++; assert.equal(dt, STEP); assert.equal(t, calls * STEP); });
  assert.equal(c.advance(0.1), 6);
  assert.equal(c.frame, 6);
  assert.equal(c.time, 6 * STEP);
  c.advance(1 / 60 * 0.5);
  assert.equal(c.frame, 6);
  c.advance(1 / 60 * 0.5);
  assert.equal(c.frame, 7);
  assert.equal(calls, 7);
});

test('rate scales wall time, pause stops it, single steps still work', () => {
  const c = new Clock({ seed: 1, rate: 0.25 });
  c.advance(0.2);
  assert.equal(c.frame, 3);
  c.rate = 0;
  c.advance(10);
  assert.equal(c.frame, 3);
  c.step();
  assert.equal(c.frame, 4);
});

test('long stalls are clamped', () => {
  const c = new Clock({ seed: 1 });
  c.advance(30);
  assert.equal(c.frame, 15);
});

test('same seed gives the same random sequence after reset; stepTo is exact', () => {
  const a = new Clock({ seed: 42 });
  const seqA = [a.random(), a.random(), a.random()];
  a.reset();
  const seqB = [a.random(), a.random(), a.random()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, [new Clock({ seed: 43 }).random(), 0, 0].slice(0, 1).concat(seqA.slice(1)));
  a.reset();
  a.stepTo(0.5);
  assert.equal(a.frame, 30);
  assert.equal(a.time, 0.5);
  a.stepTo(0.5 + STEP / 2);
  assert.equal(a.frame, 30);
});
