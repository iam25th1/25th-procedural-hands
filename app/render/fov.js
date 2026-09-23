// Vertical field of view by orientation: portrait phones need a taller cone.
// Shared by the view and the shot framing (no three.js here).
export function fovFor(aspect) {
  if (aspect < 0.8) return 72;
  if (aspect < 1.3) return 62;
  return 52;
}
