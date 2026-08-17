#!/usr/bin/env node
/**
 * OpenLoaf embedded-browser streaming service.
 *
 * The Electron build uses WebContentsView to embed arbitrary URLs as tabs
 * inside the app (Gmail, Notion, docs, etc). Browsers refuse this via
 * X-Frame-Options / frame-ancestors, so in web mode we run a real Chromium
 * on the server, capture it as JPEG frames, and pipe pixels + inputs over
 * WebSocket to a <canvas> in the renderer.
 *
 * Design choices:
 *   - One Chromium context per (userId, projectId) — cookies, storage,
 *     autofill isolated to that project, same session-persistence promise
 *     as the desktop app.
 *   - Frames are JPEG via CDP's Page.startScreencast (adaptive quality,
 *     up to 15 fps, only sends deltas on repaint).
 *   - Input events (mouse, keyboard, wheel, touch) come in as JSON and are
 *     forwarded to Playwright's page.
 *   - Idle sessions time out after 20 min without a connected client.
 *
 * Protocol (all JSON on the WebSocket):
 *   → server:  {type:"open", url:"..."}
 *              {type:"input", ...}    (mouse/kbd/wheel — CDP-shaped)
 *              {type:"navigate", url:"..."} | {type:"back"} | {type:"forward"} | {type:"reload"}
 *              {type:"resize", w, h, dpr?}
 *   ← client:  {type:"frame", data:"<base64 jpeg>", w, h}
 *              {type:"title", title, url, favicon}
 *              {type:"navigation", url, canGoBack, canGoForward}
 *              {type:"error", message}
 */

import { WebSocketServer } from 'ws';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

const PORT = Number(process.env.PORT ?? 23334);
const DATA_DIR = process.env.OPENLOAF_BROWSER_STATE ?? '/root/.openloaf/browser-state';
const IDLE_TIMEOUT_MS = 20 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

/** Map<sessionKey, { context, page, connected: Set<ws>, lastActivity }> */
const sessions = new Map();

/** Resolve the Chromium executable Playwright downloaded during the build. */
async function launch(sessionKey) {
  const stateDir = path.join(DATA_DIR, encodeURIComponent(sessionKey));
  fs.mkdirSync(stateDir, { recursive: true });

  const context = await chromium.launchPersistentContext(stateDir, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

/** Attach a screencast: pipe JPEG frames to every connected socket. */
async function startScreencast(session) {
  const cdp = await session.page.context().newCDPSession(session.page);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 });
  cdp.on('Page.screencastFrame', async (params) => {
    const msg = JSON.stringify({
      type: 'frame',
      data: params.data,
      w: params.metadata?.deviceWidth,
      h: params.metadata?.deviceHeight,
    });
    for (const ws of session.connected) {
      if (ws.readyState === 1) ws.send(msg);
    }
    // ack the frame so CDP will send the next one
    try { await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }); } catch {}
  });
  session.cdp = cdp;
}

/** Forward navigation + title updates to clients. */
function wireEvents(session) {
  const { page } = session;
  const emit = async () => {
    const msg = JSON.stringify({
      type: 'navigation',
      url: page.url(),
      title: await page.title().catch(() => ''),
    });
    for (const ws of session.connected) {
      if (ws.readyState === 1) ws.send(msg);
    }
  };
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) emit(); });
  page.on('load', emit);
}

async function getOrCreate(sessionKey) {
  let s = sessions.get(sessionKey);
  if (s) { s.lastActivity = Date.now(); return s; }
  const { context, page } = await launch(sessionKey);
  s = { context, page, connected: new Set(), lastActivity: Date.now() };
  sessions.set(sessionKey, s);
  await startScreencast(s);
  wireEvents(s);
  return s;
}

async function closeSession(sessionKey) {
  const s = sessions.get(sessionKey);
  if (!s) return;
  sessions.delete(sessionKey);
  try { await s.context.close(); } catch {}
}

/** Idle janitor: every minute, close contexts with no clients for >20 min. */
setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions.entries()) {
    if (s.connected.size === 0 && now - s.lastActivity > IDLE_TIMEOUT_MS) {
      console.log(`[stream] closing idle session ${key}`);
      closeSession(key);
    }
  }
}, 60000).unref();

// Input translation: JSON messages → Playwright + CDP actions
async function handleInput(session, msg) {
  const { page } = session;
  const ev = msg.event;
  try {
    if (ev === 'mousedown' || ev === 'mouseup' || ev === 'mousemove') {
      const btn = msg.button === 2 ? 'right' : msg.button === 1 ? 'middle' : 'left';
      if (ev === 'mousemove') await page.mouse.move(msg.x, msg.y);
      else if (ev === 'mousedown') await page.mouse.down({ button: btn });
      else await page.mouse.up({ button: btn });
    } else if (ev === 'wheel') {
      await page.mouse.wheel(msg.deltaX ?? 0, msg.deltaY ?? 0);
    } else if (ev === 'keydown' || ev === 'keyup') {
      // If it's a printable key, use insertText/type on keydown for reliability
      if (ev === 'keydown' && msg.text && msg.text.length === 1 && !msg.ctrlKey && !msg.metaKey && !msg.altKey) {
        await page.keyboard.type(msg.text);
      } else {
        await page.keyboard[ev === 'keydown' ? 'down' : 'up'](msg.key);
      }
    }
  } catch (err) {
    console.warn(`[stream] input error: ${err.message}`);
  }
}

// HTTP + WebSocket surface
const http = createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server: http, path: '/ws/browser' });

wss.on('connection', (ws, req) => {
  // Session key = query param `?session=<id>`. In production this comes from
  // the trpc token and is scoped to (userId, projectId).
  const url = new URL(req.url ?? '/', 'http://localhost');
  const sessionKey = url.searchParams.get('session') || 'default';
  console.log(`[stream] client connected to session=${sessionKey}`);

  (async () => {
    let session;
    try { session = await getOrCreate(sessionKey); }
    catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: `launch failed: ${err.message}` }));
      ws.close(); return;
    }
    session.connected.add(ws);
    session.lastActivity = Date.now();

    ws.on('message', async (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      session.lastActivity = Date.now();
      try {
        if (msg.type === 'open' || msg.type === 'navigate') {
          await session.page.goto(msg.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        } else if (msg.type === 'back') await session.page.goBack().catch(() => {});
        else if (msg.type === 'forward') await session.page.goForward().catch(() => {});
        else if (msg.type === 'reload') await session.page.reload().catch(() => {});
        else if (msg.type === 'input') await handleInput(session, msg);
        else if (msg.type === 'resize') {
          await session.page.setViewportSize({ width: msg.w, height: msg.h });
        }
      } catch (err) {
        console.warn(`[stream] msg handler error: ${err.message}`);
      }
    });

    ws.on('close', () => {
      session.connected.delete(ws);
      session.lastActivity = Date.now();
      console.log(`[stream] client disconnected from ${sessionKey}, remaining=${session.connected.size}`);
    });
  })();
});

http.listen(PORT, '0.0.0.0', () => {
  console.log(`[stream] browser-stream service listening on 0.0.0.0:${PORT}`);
});
