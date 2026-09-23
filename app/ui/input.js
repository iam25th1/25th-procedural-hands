// Pointer input on the 3D view. One finger or the mouse either drags the
// selected hand's target or, in "Move camera" mode, turns the camera; two
// fingers pinch to zoom; the wheel zooms. The camera changes only here,
// from the user's own hands on the screen, never by itself.

export function attachInput(canvas, handlers) {
  const pointers = new Map();
  let drag = null; // 'hand' | 'camera' | null
  let pinch = 0;

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  function down(e) {
    if (e.button !== undefined && e.button > 0) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 2) {
      // A second finger turns whatever the first was doing into a pinch.
      if (drag === 'hand') handlers.dragEnd();
      drag = null;
      pinch = spread();
      return;
    }
    if (pointers.size > 2) return;
    const p = local(e);
    if (handlers.cameraMode()) drag = 'camera';
    else drag = handlers.dragStart(p) ? 'hand' : null;
    e.preventDefault();
  }

  function move(e) {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2) {
      const d = spread();
      if (pinch > 0 && d > 0) handlers.zoom(pinch / d);
      pinch = d;
      return;
    }
    if (drag === 'camera') handlers.orbit(p.x - prev.x, p.y - prev.y);
    else if (drag === 'hand') handlers.dragMove(p);
  }

  function up(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (drag === 'hand') handlers.dragEnd();
    drag = null;
    if (pointers.size < 2) pinch = 0;
  }

  function wheel(e) {
    e.preventDefault();
    handlers.zoom(Math.exp(e.deltaY * 0.0015));
  }

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}
