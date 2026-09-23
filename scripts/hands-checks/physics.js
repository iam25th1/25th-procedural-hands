// The interaction physics measured on its own (the manipulation checks
// measure it in use): resting, bouncing and sliding bodies of each shape,
// the one degree of freedom props, the rope, contact-only pushing and a
// bit for bit replay.
import { World, Prop, Rope } from '../../hands/src/physics.js';
import { quat, v3 } from '../../hands/src/math.js';
import { capsuleObjectDistance } from '../../hands/src/grasp.js';

const DT = 1 / 60;
const run = (w, seconds, each = null) => { for (let i = 0; i < Math.round(seconds / DT); i++) { if (each) each(i); w.step(DT); } };
const Z_TO_X = quat.fromTo([0, 0, 0, 1], [0, 0, 1], [1, 0, 0]);
const MM = 0.001;

export const physicsChecks = [
  {
    name: 'physics: sphere, box and capsule bodies fall and come to rest on the ground and on a table, then sleep',
    async run() {
      const w = new World({ seed: 1, groundY: 0 });
      w.addStatic({ name: 'table', shape: 'box', pos: [1, 0.3, 0], hx: 0.4, hy: 0.02, hz: 0.4 });
      const bodies = [
        w.add({ name: 'sphere', shape: 'sphere', r: 0.03, mass: 0.2, pos: [0, 0.3, 0], restitution: 0 }),
        w.add({ name: 'box', shape: 'box', hx: 0.05, hy: 0.03, hz: 0.04, mass: 0.5, pos: [0.3, 0.3, 0], restitution: 0 }),
        w.add({ name: 'capsule', shape: 'capsule', r: 0.015, h: 0.05, mass: 0.2, pos: [-0.3, 0.3, 0], rot: Z_TO_X, restitution: 0 }),
        w.add({ name: 'box on table', shape: 'box', hx: 0.05, hy: 0.05, hz: 0.05, mass: 1, pos: [1, 0.6, 0], rot: quat.fromAxisAngle([0, 0, 0, 1], [0, 1, 0], 0.3), restitution: 0 }),
      ];
      run(w, 3);
      const rest = [0, 0, 0, 0.32];
      let worst = 0;
      const notes = [];
      bodies.forEach((b, i) => { const e = Math.abs(b.lowest() - rest[i]); worst = Math.max(worst, e); if (!b.asleep) notes.push(`${b.name} awake`); });
      return { pass: worst < 1 * MM && notes.length === 0, worst: worst / MM, limit: 1, unit: 'mm off its surface', note: notes.join(', ') || 'all four resting and asleep' };
    },
  },
  {
    name: 'physics: restitution bounces a ball, friction stops a slide, a resting box does not creep',
    async run() {
      const w = new World({ seed: 1, groundY: 0 });
      w.addStatic({ name: 'table', shape: 'box', pos: [5, -0.03, 0], hx: 1, hy: 0.03, hz: 1, friction: 0.6 });
      const ball = w.add({ name: 'ball', shape: 'sphere', r: 0.03, mass: 0.06, pos: [0, 0.5, 0], restitution: 0.6 });
      const slide = w.add({ name: 'slide', shape: 'box', hx: 0.05, hy: 0.05, hz: 0.05, mass: 1, pos: [5, 0.05, 0], vel: [0.8, 0, 0], friction: 0.5 });
      const still = w.add({ name: 'still', shape: 'box', hx: 0.05, hy: 0.05, hz: 0.05, mass: 1, pos: [5, 0.05, 0.4], friction: 0.5 });
      let landed = false;
      let peak = 0;
      run(w, 2, () => { if (ball.pos[1] < 0.1 && ball.vel[1] >= 0) landed = true; if (landed) peak = Math.max(peak, ball.pos[1]); });
      const creep = v3.dist(still.pos, [5, 0.05, 0.4]);
      const pass = peak > 0.1 && v3.len(slide.vel) < 0.01 && slide.pos[0] > 5.05 && creep < 1 * MM;
      return { pass, worst: creep / MM, limit: 1, unit: 'mm creep', note: `ball back up to ${(peak * 100).toFixed(1)} cm from 50; slide stopped after ${((slide.pos[0] - 5) * 100).toFixed(1)} cm` };
    },
  },
  {
    name: 'physics: hinges keep their limits, a switch snaps to a well, a sprung button returns, a drawer holds where left',
    async run() {
      const w = new World({ seed: 1 });
      const lever = w.add(new Prop({ name: 'lever', type: 'hinge', anchor: [0, 0, 0], axis: [1, 0, 0], min: 0, max: 1, inertia: 0.05, damping: 0.5, parts: [{ name: 'arm', shape: 'capsule', r: 0.01, h: 0.1, pos: [0, 0.1, 0] }] }));
      const sw = w.add(new Prop({ name: 'switch', type: 'hinge', anchor: [0, 0, 1], axis: [1, 0, 0], min: -0.42, max: 0.42, q: 0.05, inertia: 2e-5, damping: 6e-4, detents: { wells: [-0.38, 0.38], k: 0.012 }, parts: [{ name: 't', shape: 'capsule', r: 0.005, h: 0.009, pos: [0, 0, 0.016] }] }));
      const btn = w.add(new Prop({ name: 'button', type: 'slider', anchor: [0, 0, 2], axis: [0, 0, -1], min: 0, max: 0.008, q: 0.008, inertia: 0.02, damping: 1.2, spring: { k: 90, rest: 0 }, parts: [{ name: 'cap', shape: 'box', hx: 0.01, hy: 0.01, hz: 0.005 }] }));
      const drawer = w.add(new Prop({ name: 'drawer', type: 'slider', anchor: [0, 0, 3], axis: [0, 0, 1], min: 0, max: 0.2, q: 0.1, inertia: 1.5, damping: 6, friction: 3, parts: [{ name: 'front', shape: 'box', hx: 0.1, hy: 0.05, hz: 0.01 }] }));
      lever.qd = 50;
      let leverMax = 0;
      run(w, 1.5, () => { leverMax = Math.max(leverMax, lever.q); });
      const pass = leverMax <= 1 + 1e-9 && Math.abs(sw.q - 0.38) < 0.02 && btn.q < 0.0005 && Math.abs(drawer.q - 0.1) < 1e-9;
      return { pass, worst: leverMax, limit: 1, unit: 'rad lever max', note: `switch ${sw.q.toFixed(3)} rad (well 0.38); button ${(btn.q / MM).toFixed(2)} mm (rest 0); drawer ${drawer.q.toFixed(3)} m (left at 0.1)` };
    },
  },
  {
    name: 'physics: a rope hangs from its pinned top at its length (stretch under 2 percent)',
    async run() {
      const w = new World({ seed: 1 });
      const rope = w.add(new Rope({ name: 'rope', top: [0, 1, 0], length: 1, segments: 20, r: 0.012 }));
      run(w, 4);
      const pinned = v3.dist(rope.points[0], [0, 1, 0]);
      const stretch = rope.maxStretch();
      return { pass: pinned < 1e-9 && stretch < 0.02, worst: stretch * 100, limit: 2, unit: 'percent', note: `top ${pinned.toExponential(1)} m off its pin; bottom at ${rope.points[rope.n - 1][1].toFixed(3)} m` };
    },
  },
  {
    name: 'physics: a hand moves an object only through contact, the object stops the hand passing into it, a rung holds a load',
    async run() {
      const w = new World({ seed: 1, groundY: 0 });
      const box = w.add({ name: 'box', shape: 'box', hx: 0.05, hy: 0.05, hz: 0.05, mass: 1, pos: [0, 0.05, 0], friction: 0.3 });
      w.addStatic({ name: 'rung', shape: 'capsule', a: [-0.3, 0.5, 1], b: [0.3, 0.5, 1], r: 0.016 });
      const ball = w.add({ name: 'ball', shape: 'sphere', r: 0.03, mass: 0.1, pos: [0, 0.8, 1], restitution: 0 });
      let x = -0.1;
      let early = 0;
      let deepest = 0;
      run(w, 1.5, (i) => {
        // How far the finger is into the box after the last step (the world
        // has answered the last move), then the next move.
        if (i > 0) deepest = Math.max(deepest, -capsuleObjectDistance({ shape: 'box', hx: 0.05, hy: 0.05, hz: 0.05, pos: box.pos, rot: box.rot }, [x, 0.05, -0.02], [x, 0.05, 0.02], 0.008, 10));
        if (i * DT < 0.5) x += 0.2 * DT;
        w.setHandCapsules([{ side: 'right', name: 'finger', digit: 'index', segment: 'phalanx-distal', a: [x, 0.05, -0.02], b: [x, 0.05, 0.02], r: 0.008 }], DT);
        if (x + 0.008 < -0.05 - 0.002) early = Math.max(early, Math.abs(box.pos[0]));
      });
      const pass = early < 1e-4 && box.pos[0] > 0.02 && deepest < 1 * MM && ball.pos[1] > 0.5;
      return { pass, worst: deepest / MM, limit: 1, unit: 'mm finger into box', note: `box moved ${(early * 1000).toFixed(3)} mm before the touch, ${(box.pos[0] * 100).toFixed(1)} cm after; ball resting on the rung at ${ball.pos[1].toFixed(3)} m` };
    },
  },
  {
    name: 'physics: fixed timestep and seeded, the same calls replay bit for bit',
    async run() {
      const make = (vx) => {
        const w = new World({ seed: 3, groundY: 0 });
        w.add({ name: 'a', shape: 'sphere', r: 0.03, mass: 0.2, pos: [0, 0.4, 0], vel: [vx, 0, 0.1], restitution: 0.4 });
        w.add({ name: 'b', shape: 'box', hx: 0.05, hy: 0.03, hz: 0.04, mass: 0.5, pos: [0.05, 0.6, 0.02], rot: quat.fromAxisAngle([0, 0, 0, 1], [1, 1, 0], 0.4) });
        w.add(new Rope({ name: 'r', top: [1, 1, 0], length: 0.6, segments: 12 }));
        run(w, 3);
        return w.stateValues();
      };
      const a = make(0.3);
      const b = make(0.3);
      const mism = a.reduce((n, v, i) => n + (Object.is(v, b[i]) ? 0 : 1), 0);
      const differs = make(0.31).some((v, i) => v !== a[i]);
      return { pass: mism === 0 && differs, worst: mism, limit: 0, unit: 'mismatches', note: `${a.length} state values; a changed input ${differs ? 'changes' : 'does not change'} them` };
    },
  },
];
