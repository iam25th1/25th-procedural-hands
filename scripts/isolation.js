// Isolation rule for the hands module: every file under hands/src may import
// only files inside hands/ or the three package, and may not touch window or
// document. A small lexer strips comments and string contents first, so a
// word in a comment or a string never trips the rule and an import hidden
// behind a comment is never missed.
import fs from 'node:fs';
import path from 'node:path';

// Returns { code, strings }: code with comments removed and string bodies
// blanked, and every string literal with the index where it started.
export function lex(src) {
  let code = '';
  const strings = [];
  let i = 0;
  const n = src.length;
  const braceStack = [];
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; code += ' '; continue; }
    if (c === '\'' || c === '"') {
      const start = code.length;
      let s = '';
      i++;
      while (i < n && src[i] !== c) { if (src[i] === '\\') { s += src[i + 1]; i += 2; continue; } s += src[i++]; }
      i++;
      strings.push({ at: start, value: s });
      code += `${c}${c}`;
      continue;
    }
    if (c === '`' || (c === '}' && braceStack.length && braceStack[braceStack.length - 1] === 'tpl')) {
      if (c === '}') braceStack.pop();
      const start = code.length;
      let s = '';
      i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { s += src[i + 1]; i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { braceStack.push('tpl'); i += 2; break; }
        s += src[i++];
      }
      if (src[i] === '`') i++;
      strings.push({ at: start, value: s, template: true });
      code += '``';
      if (braceStack.length && braceStack[braceStack.length - 1] === 'tpl' && src[i - 1] === '{') code += '${';
      continue;
    }
    if (c === '{') braceStack.push('brace');
    if (c === '}' && braceStack.length) braceStack.pop();
    code += c;
    i++;
  }
  return { code, strings };
}

// Module specifiers: import ... from 'x', export ... from 'x', import 'x', import('x').
export function specifiers(src) {
  const { code, strings } = lex(src);
  const out = [];
  for (const s of strings) {
    const before = code.slice(Math.max(0, s.at - 200), s.at);
    if (/(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*)$/.test(before)) out.push(s.value);
    else if (/\bimport\s*\(\s*$/.test(before)) out.push(s.value);
  }
  // A dynamic import of anything that is not a plain string cannot be vetted.
  const dynamic = /\bimport\s*\(\s*[^'"`\s)]/.test(code);
  return { specs: out, dynamic, code };
}

export function checkIsolation(root) {
  const handsDir = path.join(root, 'hands');
  const srcDir = path.join(handsDir, 'src');
  const problems = [];
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(m?js|cjs)$/.test(e.name)) files.push(full);
    }
  };
  walk(srcDir);
  let imports = 0;
  let three = 0;
  for (const file of files) {
    const rel = path.relative(root, file);
    const { specs, dynamic, code } = specifiers(fs.readFileSync(file, 'utf8'));
    if (dynamic) problems.push(`${rel}: computed dynamic import`);
    for (const spec of specs) {
      imports++;
      if (spec === 'three') { three++; continue; }
      if (!spec.startsWith('./') && !spec.startsWith('../')) { problems.push(`${rel}: imports '${spec}'`); continue; }
      const target = path.resolve(path.dirname(file), spec);
      if (!target.startsWith(handsDir + path.sep)) problems.push(`${rel}: '${spec}' resolves outside hands/`);
      else if (!fs.existsSync(target)) problems.push(`${rel}: '${spec}' does not exist`);
    }
    for (const word of ['window', 'document']) {
      const re = new RegExp(`(^|[^.\\w$])${word}\\b|\\.${word}\\b`);
      if (re.test(code)) problems.push(`${rel}: touches ${word}`);
    }
    if (/\brequire\s*\(/.test(code)) problems.push(`${rel}: uses require()`);
  }
  return { files: files.length, imports, three, problems };
}
