import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startScenario } from '../app/scenes/runner.js';
import { teeSource, streamSource } from '../app/plan/sources.js';

// One copy solves and records through a tee (the worker), another answers
// only from the stream of those records (the page): both end in the same
// state, bit for bit, and the page's copy solves nothing, including after
// the run has left its script (a finger moved mid action).
function play(source, { disturbAt = null } = {}) {
  const p = startScenario('pullLever', { planSource: source });
  let n = 0;
  while (!p.done) {
    if (n === disturbAt) p.sb.hands.setFingerJoint('right', 'index', 'pip', 0.6);
    p.step();
    n++;
  }
  return p.sb.hands.hash();
}

test('plan stream: the page copy answered from the worker copy ends in the same state and solves nothing', () => {
  for (const disturbAt of [null, 90]) {
    const records = [];
    const tee = teeSource(null, records);
    const want = play(tee, { disturbAt });
    assert.ok(records.length > 20, 'the worker copy recorded its solves');
    const stream = streamSource();
    stream.push(records);
    const got = play(stream, { disturbAt });
    assert.equal(got, want);
    assert.equal(stream.used, records.length);
    assert.equal(stream.live, 0);
    assert.equal(stream.miss, null);
  }
});

test('plan stream: a call that does not match the next answer parts the copies and later solves run on the page', () => {
  const records = [];
  play(teeSource(null, records));
  const stream = streamSource();
  stream.push(records.slice(1)); // the first answer is missing
  const hash = play(stream);
  assert.ok(stream.miss && stream.miss.at === 0);
  assert.ok(stream.live > 0);
  // Parted, it solves for itself and still ends where a plain run does.
  assert.equal(hash, play(null));
});
