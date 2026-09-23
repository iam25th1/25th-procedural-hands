// Per-viewer UI preferences (camera settings, whether the control centre is
// open, the skin tone) in localStorage. Storage can be missing or throw
// (private windows, blocked site data), so every access is guarded and the
// UI works the same without it, falling back to its defaults.

const PREFIX = 'hands-sandbox:';

export function load(key, fallback) {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(PREFIX + key);
    return raw === null || raw === undefined ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Nothing to do: the preference lasts for this visit only.
  }
}
