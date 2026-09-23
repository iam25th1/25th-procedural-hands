import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { resolvePath, createStaticHandler, securityHeaders, rewriteThreeSpecifier, VENDOR, ROOT } from '../server/static.js';
import { lanAddresses } from '../server/lan.js';
import { startServer, portTakenMessage, bootMessage, parsePort, DEFAULT_PORT } from '../server/index.js';

const nm = (...p) => path.join(ROOT, 'node_modules', ...p);
const APP = path.join(ROOT, 'app') + path.sep;
const HANDS = path.join(ROOT, 'hands', 'src') + path.sep;

test('vendor whitelist serves exactly the listed files', () => {
  assert.deepEqual(Object.keys(VENDOR).sort(), ['/vendor/anime.esm.js', '/vendor/three.core.js', '/vendor/three.module.js']);
  assert.equal(resolvePath('/vendor/three.module.js').file, nm('three', 'build', 'three.module.js'));
  assert.equal(resolvePath('/vendor/three.core.js').file, nm('three', 'build', 'three.core.js'));
  assert.equal(resolvePath('/vendor/anime.esm.js').file, nm('animejs', 'dist', 'bundles', 'anime.esm.min.js'));
});

test('vendor route never serves a directory or an unlisted file', () => {
  for (const p of [
    '/vendor/', '/vendor', '/vendor/index.html', '/vendor/three.webgpu.js', '/vendor/three.tsl.js', '/vendor/three.cjs',
    '/vendor/anime.umd.js', '/vendor/anime.esm.min.js', '/vendor/three/build/three.module.js', '/vendor/THREE.MODULE.JS',
    '/vendor/three.module.js/', '/vendor/hasOwnProperty', '/vendor/__proto__', '/vendor/constructor',
  ]) assert.equal(resolvePath(p), null, p);
});

test('traversal, dotfiles and directory listings are refused', () => {
  for (const p of [
    '/vendor/../package.json', '/vendor/%2e%2e/package.json', '/vendor/..%2fpackage.json', '/vendor/./three.module.js',
    '/../server/index.js', '/%2e%2e/%2e%2e/etc/passwd', '/hands/src/../../package.json', '/hands/src/..%2f..%2fpackage.json',
    '/hands/src/%2e%2e/test/isolation.test.js', '/\\vendor\\three.module.js', '/vendor/three.module.js\0', '/.git/config',
    '/hands/src/.hidden.js', '/node_modules/three/package.json', '/scenes/', '/fonts/', '/hands/src/', '/hands/', '/hands/README.md',
    '/package.json', '/server/index.js', '/app/index.html', '/a/./b.js', '/a//b/../c.js',
  ]) {
    const r = resolvePath(p);
    assert.ok(r === null || r.file.startsWith(APP) || r.file.startsWith(HANDS), `${p} resolved to ${r && r.file}`);
    assert.notEqual(r && r.file, path.join(ROOT, 'package.json'), p);
  }
  for (const p of ['/vendor/../package.json', '/.git/config', '/hands/src/.hidden.js', '/vendor/three.module.js\0', '/scenes/', '/hands/src/', '/a/./b.js']) {
    assert.equal(resolvePath(p), null, p);
  }
});

test('the root serves the sandbox and the module source is mounted read only with three rewritten', () => {
  assert.equal(resolvePath('/').file, path.join(ROOT, 'app', 'index.html'));
  assert.equal(resolvePath('/hands/src/index.js').file, path.join(ROOT, 'hands', 'src', 'index.js'));
  assert.equal(resolvePath('/hands/src/index.js').rewrite, true);
  assert.equal(resolvePath('/main.js').rewrite, false);
  assert.equal(rewriteThreeSpecifier("import * as THREE from 'three';\nimport { a } from './three.js';"), "import * as THREE from '/vendor/three.module.js';\nimport { a } from './three.js';");
  assert.equal(rewriteThreeSpecifier('export { X } from "three";'), 'export { X } from "/vendor/three.module.js";');
  assert.equal(rewriteThreeSpecifier("const s = 'three';"), "const s = 'three';");
});

test('CSP stays strict: no inline, no eval, no remote origins, framing denied, nosniff', () => {
  const h = securityHeaders();
  const csp = h['Content-Security-Policy'];
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
});

function get(server, urlPath) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('http: vendor files stream with CSP, everything else outside the whitelist is 404', async () => {
  const server = http.createServer(createStaticHandler());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const three = await get(server, '/vendor/three.module.js');
    assert.equal(three.status, 200);
    assert.equal(three.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.match(three.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(three.headers['x-content-type-options'], 'nosniff');
    assert.match(three.body.toString('utf8'), /from '\.\/three\.core\.js'/);
    assert.equal((await get(server, '/vendor/three.core.js')).status, 200);
    assert.equal((await get(server, '/vendor/anime.esm.js')).status, 200);
    for (const p of ['/vendor/', '/vendor/three.webgpu.js', '/vendor/..%2fpackage.json', '/vendor/../package.json', '/package.json', '/fonts/', '/hands/src/', '/.git/HEAD']) {
      assert.equal((await get(server, p)).status, 404, p);
    }
    const root = await get(server, '/');
    assert.equal(root.status, 200);
    assert.match(root.headers['content-type'], /text\/html/);
  } finally {
    server.close();
  }
});

test('boot prints the local and LAN sandbox URLs', () => {
  const msg = bootMessage(3100, '0.0.0.0', ['192.168.1.20']);
  assert.match(msg, /http:\/\/localhost:3100\//);
  assert.match(msg, /http:\/\/192\.168\.1\.20:3100\//);
  assert.equal(parsePort(undefined), DEFAULT_PORT);
  assert.equal(parsePort('70000'), DEFAULT_PORT);
  assert.equal(parsePort('3200'), 3200);
});

test('a taken port exits with a clear message instead of a stack trace', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const { port } = blocker.address();
  try {
    const message = await new Promise((resolve) => {
      startServer({ port, host: '127.0.0.1', log: () => {}, onTaken: resolve });
    });
    assert.equal(message, portTakenMessage(port));
    assert.match(message, new RegExp(`Port ${port} is already in use`));
    assert.match(message, /PORT=\d+ npm start/);
  } finally {
    blocker.close();
  }
});

test('lanAddresses keeps only routable IPv4 addresses', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
    en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    en1: [{ address: '169.254.10.5', family: 'IPv4', internal: false }],
    utun0: [{ address: '10.8.0.2', family: 4, internal: false }],
  };
  assert.deepEqual(lanAddresses(ifaces), ['192.168.1.20', '10.8.0.2']);
});
