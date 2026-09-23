// Sandbox entry. With ?shot=1 it renders one exact frame for the gallery and
// the checks; otherwise it starts the interactive sandbox (scenes Hands,
// and Sandbox on one injected clock).
import { parseShot } from '/shot.js';
import { renderShot } from '/shot-render.js';

const shot = parseShot(location.search);
const canvas = document.getElementById('view');

if (shot.shot) {
  document.documentElement.classList.add('ui-hidden');
  let info = null;
  let error = null;
  let frame = null;
  try {
    frame = renderShot(canvas, shot);
    info = frame.info;
  } catch (e) {
    error = String((e && e.stack) || e);
  }
  // advance(t): the same run stepped on to a later time and drawn again,
  // for strips of frames from one scenario.
  window.__handsShot = { ready: true, info, error, params: shot, advance: (t) => { try { return { info: frame.advance(t) }; } catch (e) { return { error: String((e && e.stack) || e) }; } } };
} else {
  // The interactive app loads only when it is wanted: shot mode stays lean.
  import('/ui/app.js').then(({ startApp }) => startApp({ canvas, shot }));
}
