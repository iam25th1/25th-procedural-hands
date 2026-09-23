// Dev server for the sandbox: static files only, default port 3100. Prints
// the sandbox URL (local and LAN) on boot and exits with a clear message when
// the port is already taken.
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStaticHandler } from './static.js';
import { lanAddresses } from './lan.js';

export const DEFAULT_PORT = 3100;

export function parsePort(value) {
  const v = Number.parseInt(value ?? '', 10);
  return Number.isInteger(v) && v >= 1 && v <= 65535 ? v : DEFAULT_PORT;
}

export function portTakenMessage(port) {
  return `Port ${port} is already in use. Stop the other server or pick another port, for example: PORT=${port + 1} npm start`;
}

export function bootMessage(port, host, lan = lanAddresses()) {
  const lines = [`Sandbox: http://localhost:${port}/`];
  if (host === '0.0.0.0' || host === '::') for (const ip of lan) lines.push(`On your phone (same Wi-Fi): http://${ip}:${port}/`);
  return lines.join('\n');
}

export function startServer({ port = parsePort(process.env.PORT), host = process.env.HOST || '0.0.0.0', log = console.log, onTaken } = {}) {
  const server = http.createServer(createStaticHandler());
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      if (onTaken) onTaken(portTakenMessage(port));
      else {
        console.error(portTakenMessage(port));
        process.exit(1);
      }
      return;
    }
    throw err;
  });
  server.listen(port, host, () => log(bootMessage(port, host)));
  return server;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) startServer();
