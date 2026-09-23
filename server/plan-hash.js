// Hash of the sources a recorded plan table depends on: the hands module and
// the scripted scenarios with their world. The table records this hash when
// it is built; the server serves the table only while it still matches, so a
// plan recorded from older code can never be replayed against newer code.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['hands/src', 'app/scenes'];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

export function planSourceHash() {
  const h = crypto.createHash('sha256');
  for (const d of DIRS) for (const f of walk(path.join(ROOT, d), [])) { h.update(path.relative(ROOT, f)); h.update(fs.readFileSync(f)); }
  return h.digest('hex').slice(0, 16);
}

export const PLAN_TABLE = path.join(ROOT, 'app', 'scenes', 'plans.json');
