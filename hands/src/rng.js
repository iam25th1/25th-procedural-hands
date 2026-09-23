// mulberry32: tiny, fast, seedable PRNG. Not for security; it seeds the rig's
// idle phases, the physics world and procedural meshes so replays repeat.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Approximate standard normal using the sum of three uniforms.
export function gauss(rng) {
  return (rng() + rng() + rng() - 1.5) * 2;
}
