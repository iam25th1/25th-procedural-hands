// Cross-platform source check: node --check over every JS file in every
// source folder, and an em dash scan over every text file. No shell globs,
// so it behaves the same on macOS, Linux and Windows.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS_DIRS = ['server', 'hands', 'app', 'scripts', 'test'];
const TEXT_DIRS = ['server', 'hands', 'app', 'scripts', 'test', 'docs', '.'];
const JS_EXT = new Set(['.js', '.mjs', '.cjs']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.md', '.json', '.svg', '.txt', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'artifacts', 'fonts']);
const EM_DASH = String.fromCharCode(0x2014);

function walk(dir, exts, out, recurse) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recurse && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full, exts, out, true);
      continue;
    }
    if (exts.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

let failures = 0;
const jsFiles = [];
for (const d of JS_DIRS) walk(path.join(ROOT, d), JS_EXT, jsFiles, true);
for (const file of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failures++;
    console.error(`syntax: ${path.relative(ROOT, file)}\n${r.stderr.trim()}`);
  }
}
const textFiles = new Set();
for (const d of TEXT_DIRS) for (const f of walk(path.join(ROOT, d), TEXT_EXT, [], d !== '.')) textFiles.add(f);
for (const file of textFiles) {
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (line.includes(EM_DASH)) {
      failures++;
      console.error(`em dash: ${path.relative(ROOT, file)}:${i + 1}`);
    }
  });
}
console.log(`check: ${jsFiles.length} js files parsed across ${JS_DIRS.join(', ')}; ${textFiles.size} text files scanned for em dashes; ${failures} problem(s)`);
process.exit(failures ? 1 : 0);
