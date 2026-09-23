// Hash of every source file the checks depend on, so hands:matrix can refuse
// to read a check report produced from different code.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['hands/src', 'app', 'scripts', 'server'];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'fonts' && !e.name.startsWith('.')) walk(full, out); } else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

export function sourceHash() {
  const h = crypto.createHash('sha256');
  for (const d of DIRS) for (const f of walk(path.join(ROOT, d), [])) { h.update(path.relative(ROOT, f)); h.update(fs.readFileSync(f)); }
  return h.digest('hex').slice(0, 16);
}
