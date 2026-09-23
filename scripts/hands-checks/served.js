// The sandbox only works if every module it pulls in is servable: the app,
// the hands module (with three rewritten to the vendor path) and three and
// anime.js from the /vendor/ whitelist. This walks the import graph from the
// app entry the way the browser would and confirms every edge resolves.
import fs from 'node:fs';
import path from 'node:path';
import { resolvePath, rewriteThreeSpecifier } from '../../server/static.js';

const ENTRIES = ['/main.js', '/vendor/three.module.js', '/vendor/anime.esm.js'];
const IMPORT_RE = /(?:^|[\s;{}])(?:import|export)\s*(?:[^'"]*?from\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

export function servedGraph(entries = ENTRIES) {
  const seen = new Set();
  const queue = [...entries];
  let edges = 0;
  const missing = [];
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const hit = resolvePath(url);
    if (!hit || !fs.existsSync(hit.file)) { missing.push(url); continue; }
    let src = fs.readFileSync(hit.file, 'utf8');
    if (hit.rewrite) src = rewriteThreeSpecifier(src);
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2];
      if (!spec.startsWith('.') && !spec.startsWith('/')) { missing.push(`${url} imports bare '${spec}'`); continue; }
      edges++;
      queue.push(spec.startsWith('/') ? spec : path.posix.join(path.posix.dirname(url), spec));
    }
  }
  return { seen, edges, missing };
}

export const servedChecks = [{
  name: 'served: app, hands module, three and anime graphs resolve through the whitelist',
  async run() {
    const { seen, edges, missing } = servedGraph();
    return { pass: missing.length === 0, worst: missing.length, limit: 0, unit: 'unresolved', note: missing.length ? missing.join(', ') : `${seen.size} files, ${edges} edges` };
  },
}];
