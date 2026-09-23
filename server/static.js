// Static file serving for the sandbox. Only whitelisted trees and files are
// reachable: the app at /, the hands module source at /hands/src/, and an
// explicit list of vendor files from node_modules at /vendor/. No directory
// listings, no dotfiles, no traversal, strict CSP on every response.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// URL prefix -> directory on disk, most specific first.
const MOUNTS = [
  ['/hands/src/', path.join(ROOT, 'hands', 'src')],
  ['/', path.join(ROOT, 'app')],
];

// /vendor/ serves exactly these files and nothing else. three.module.js
// imports one sibling, ./three.core.js, so both are listed; the vendor check
// in npm run hands:check walks the import graph to prove the list is whole.
export const VENDOR = {
  '/vendor/three.module.js': path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js'),
  '/vendor/three.core.js': path.join(ROOT, 'node_modules', 'three', 'build', 'three.core.js'),
  '/vendor/anime.esm.js': path.join(ROOT, 'node_modules', 'animejs', 'dist', 'bundles', 'anime.esm.min.js'),
};

// The hands module imports three by its package name so bundlers and Node
// resolve it normally. Browsers cannot resolve a bare name without an import
// map, and an import map is an inline script the CSP forbids, so files from
// /hands/src/ get that one specifier rewritten to the whitelisted vendor path.
const THREE_SPECIFIER = /(\bfrom\s*|\bimport\s*)(['"])three\2/g;
export function rewriteThreeSpecifier(source) {
  return source.replace(THREE_SPECIFIER, (m, lead, q) => `${lead}${q}/vendor/three.module.js${q}`);
}

export function securityHeaders() {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "media-src 'self'",
      "worker-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

// Resolve a request path to { file, rewrite } or null if it is not servable.
export function resolvePath(urlPath) {
  if (typeof urlPath !== 'string' || urlPath.length > 512) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (Object.hasOwn(VENDOR, decoded)) return { file: VENDOR[decoded], rewrite: false };
  const normal = path.posix.normalize(decoded);
  if (!normal.startsWith('/')) return null;
  // A normalised path that differs from the request hid a ./ or ../ segment.
  if (normal !== decoded && normal + '/' !== decoded) return null;
  if (normal === '/vendor' || normal.startsWith('/vendor/')) return null;
  if (normal.split('/').some((seg) => seg.startsWith('.'))) return null;
  for (const [prefix, dir] of MOUNTS) {
    if (!normal.startsWith(prefix) && normal + '/' !== prefix) continue;
    let rel = normal.startsWith(prefix) ? normal.slice(prefix.length) : '';
    if (rel === '') {
      if (prefix !== '/') return null; // only the app root has an index page
      rel = 'index.html';
    }
    if (rel.endsWith('/')) return null; // no directory listings or implicit indexes below the root
    const full = path.resolve(dir, rel);
    if (!full.startsWith(dir + path.sep)) return null;
    if (!MIME[path.extname(full).toLowerCase()]) return null;
    return { file: full, rewrite: prefix === '/hands/src/' && full.endsWith('.js') };
  }
  return null;
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export function createStaticHandler() {
  return function handle(req, res) {
    const headers = securityHeaders();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, headers, 'Method not allowed');
    }
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return send(res, 400, headers, 'Bad request');
    }
    if (pathname === '/healthz') return send(res, 200, headers, 'ok');
    const hit = resolvePath(pathname);
    if (!hit) return send(res, 404, headers, 'Not found');
    fs.stat(hit.file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, headers, 'Not found');
      const ext = path.extname(hit.file).toLowerCase();
      const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const common = { ...headers, 'Content-Type': MIME[ext], ETag: etag, 'Cache-Control': 'no-cache' };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, common);
        return res.end();
      }
      if (hit.rewrite) {
        fs.readFile(hit.file, 'utf8', (e2, src) => {
          if (e2) return send(res, 404, headers, 'Not found');
          const body = Buffer.from(rewriteThreeSpecifier(src), 'utf8');
          res.writeHead(200, { ...common, 'Content-Length': body.length });
          res.end(req.method === 'HEAD' ? undefined : body);
        });
        return undefined;
      }
      res.writeHead(200, { ...common, 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(hit.file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return undefined;
    });
    return undefined;
  };
}
