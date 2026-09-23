// Small DOM helpers for the sandbox UI. Elements are built with
// createElement and textContent only: no innerHTML, no inline styles, so the
// strict CSP (script-src 'self'; style-src 'self') never has to bend.

export function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// A button that is always at least the 44 px touch target (see app.css).
export function button(text, className = '', onClick = null) {
  const b = el('button', `btn${className ? ` ${className}` : ''}`, text);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// A segmented control: one of several options is on. Returns the element and
// a set(value) that moves the highlight without firing onChange.
export function segmented(options, value, onChange, { label = '', className = '' } = {}) {
  const wrap = el('div', `seg${className ? ` ${className}` : ''}`);
  wrap.setAttribute('role', 'radiogroup');
  if (label) wrap.setAttribute('aria-label', label);
  const buttons = new Map();
  for (const [key, text] of options) {
    const b = button(text, 'seg-btn', () => { set(key); onChange(key); });
    b.setAttribute('role', 'radio');
    buttons.set(key, b);
    wrap.append(b);
  }
  function set(next) {
    for (const [key, b] of buttons) {
      const on = key === next;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }
  set(value);
  return { el: wrap, set, buttons };
}

// A toggle button with aria-pressed.
export function toggle(text, on, onChange, className = '') {
  const b = button(text, `toggle${className ? ` ${className}` : ''}`);
  const set = (v) => { b.classList.toggle('on', v); b.setAttribute('aria-pressed', v ? 'true' : 'false'); };
  b.addEventListener('click', () => { const next = b.getAttribute('aria-pressed') !== 'true'; set(next); onChange(next); });
  set(on);
  return { el: b, set };
}

// camelCase or snake keys to sentence case words: 'loadPebble' -> 'Load pebble'.
export function humanize(key) {
  const words = String(key).replace(/^preset:/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
