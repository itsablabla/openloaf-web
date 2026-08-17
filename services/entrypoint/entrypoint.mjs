#!/usr/bin/env node
/**
 * OpenLoaf web-mode entrypoint.
 *
 * Spawns and supervises three child processes, then runs a single reverse
 * proxy on PORT (default 8080) that Coolify/Traefik terminates TLS to.
 *
 *   /ws/browser/*   → Playwright browser-streaming service (port 23334)
 *   /api/*, /trpc/* → Hono server                          (port 23333)
 *   /ws/*           → Hono server WebSocket routes         (port 23333)
 *   *               → Next.js static export from apps/web/out
 *
 * If any child dies, we restart it with backoff. If it dies 5 times in
 * 60 seconds we exit and let Coolify restart the whole container.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import httpProxy from 'http-proxy';
import serveHandler from 'serve-handler';
import path from 'node:path';
import fs from 'node:fs';

// http-proxy is a CJS module — its ESM interop exposes createProxyServer
// as a property of the default export.
const createProxyServer = httpProxy.createProxyServer.bind(httpProxy);

const ROOT = path.resolve(process.cwd());
const WEB_OUT = path.join(ROOT, 'apps/web/out');
const HAS_STATIC = fs.existsSync(WEB_OUT);

const SERVER_PORT = Number(process.env.OPENLOAF_SERVER_PORT ?? 23333);
const STREAM_PORT = Number(process.env.OPENLOAF_STREAM_PORT ?? 23334);
const PROXY_PORT  = Number(process.env.PORT ?? 8080);

const children = new Map();
const failureLog = new Map();

/** Restart-with-backoff supervisor. */
function supervise(name, cmd, args, env = {}) {
  const start = () => {
    console.log(`[${name}] starting: ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.set(name, proc);

    proc.stdout.on('data', d => process.stdout.write(`[${name}] ${d}`));
    proc.stderr.on('data', d => process.stderr.write(`[${name}] ${d}`));

    proc.on('exit', (code, sig) => {
      console.error(`[${name}] exited code=${code} sig=${sig}`);
      children.delete(name);
      const now = Date.now();
      const log = (failureLog.get(name) ?? []).filter(t => now - t < 60000);
      log.push(now);
      failureLog.set(name, log);
      if (log.length > 5) {
        console.error(`[${name}] > 5 crashes in 60s; giving up`);
        process.exit(1);
      }
      setTimeout(start, Math.min(1000 * log.length, 10000));
    });
  };
  start();
}

// ────────────────────────────────────────────────────────────────
// 1) Hono server (apps/server)
supervise(
  'server',
  'node',
  fs.existsSync(path.join(ROOT, 'apps/server/dist/index.js'))
    ? ['apps/server/dist/index.js']
    : ['-r', 'tsx/cjs', 'apps/server/src/index.ts'],
  { PORT: String(SERVER_PORT), HOST: '0.0.0.0' },
);

// 2) Playwright streaming service
supervise(
  'stream',
  'node',
  ['services/browser-stream/index.mjs'],
  { PORT: String(STREAM_PORT) },
);

// ────────────────────────────────────────────────────────────────
// 3) Reverse proxy in front of everything
const proxy = createProxyServer({ xfwd: true, ws: true });
proxy.on('error', (err, _req, res) => {
  console.error('[proxy] error:', err.code || err.message);
  if (res && !res.headersSent) {
    try { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('upstream unavailable'); } catch {}
  }
});

const server = createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/ws/browser') || url.startsWith('/browser-stream')) {
    proxy.web(req, res, { target: `http://127.0.0.1:${STREAM_PORT}` });
  } else if (
    url.startsWith('/api') ||
    url.startsWith('/trpc') ||
    url.startsWith('/ws') ||
    url.startsWith('/collab') ||
    url.startsWith('/ipc') ||
    url.startsWith('/mcp')
  ) {
    proxy.web(req, res, { target: `http://127.0.0.1:${SERVER_PORT}` });
  } else if (HAS_STATIC) {
    // Serve the Next.js static export. serveHandler handles index.html, MIME
    // types, and 404 → 200 for SPA-style fallbacks via `cleanUrls`.
    serveHandler(req, res, {
      public: WEB_OUT,
      cleanUrls: true,
      rewrites: [{ source: '**', destination: '/index.html' }],
    });
  } else {
    // Dev-fallback: proxy /_next and / to next dev on 3001
    proxy.web(req, res, { target: 'http://127.0.0.1:3001' });
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';
  const target =
    url.startsWith('/ws/browser') || url.startsWith('/browser-stream')
      ? `http://127.0.0.1:${STREAM_PORT}`
      : `http://127.0.0.1:${SERVER_PORT}`;
  proxy.ws(req, socket, head, { target });
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`[proxy] listening on 0.0.0.0:${PROXY_PORT}`);
  console.log(`         → server @ ${SERVER_PORT}, stream @ ${STREAM_PORT}, static: ${HAS_STATIC ? WEB_OUT : 'next-dev'}`);
});

// Graceful shutdown
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[entrypoint] ${sig} → killing children`);
    for (const p of children.values()) p.kill();
    setTimeout(() => process.exit(0), 2000);
  });
}
