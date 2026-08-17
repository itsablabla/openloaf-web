# OpenLoaf Web-Mode Port

The upstream OpenLoaf ships as an Electron desktop app. This fork adds a
**web-mode** path so the same monorepo runs behind a URL and users open it in
a normal browser (Chrome, Safari, Edge, Firefox).

## What runs where

| Piece | Web-mode home | Notes |
|---|---|---|
| `apps/web` | Next.js **static export** served by the entrypoint proxy | `output: "export"` was already set upstream — zero refactor |
| `apps/server` | Hono + tRPC + Yjs collab + terminal + AI (unchanged) | Listens on `:23333` inside the container |
| `services/browser-stream` | New: Playwright + Chromium + JPEG screencast over WebSocket | Replaces the `WebContentsView` embedded-browser tab |
| `services/entrypoint` | Supervisor + reverse proxy on `:8080` | One published port; Traefik terminates TLS to it |

## Feature coverage vs desktop

| Feature | Desktop | Web-mode |
|---|---|---|
| Chat, docs, kanban, canvas | Electron IPC → server | tRPC → server (unchanged) |
| Terminal (PTY) | Server via IPC | Same server route over WebSocket |
| Files (read/write/tree) | Server | Same server; shared `/root/.openloaf` volume |
| Yjs realtime collab | Hocuspocus over IPC | Hocuspocus over WebSocket (Traefik upgrades) |
| Embedded browser tab | `WebContentsView` | **Server-side Chromium**, JPEG stream to a `<canvas>` |
| External links | `shell.openExternal` | `window.open('_blank')` |
| File dialogs / save | Electron `dialog` | `<input type=file>` + download stream (see `web-mode-shim.ts`) |
| Speech recognition | macOS SFSpeech helper | Web Speech API (works in Chrome/Edge) |
| Calendar (Apple EventKit) | macOS Swift helper | Falls back to tRPC calendar integrations (Google/CalDAV) |
| Trash / show-in-folder | Electron `shell` | No-op with a friendly reason |
| Auto-updater | electron-updater | N/A — re-deploy the container |

## The embedded-browser tab

The upstream Electron app embeds arbitrary URLs (Gmail, Notion, GitHub, YouTube)
via `WebContentsView`. Browsers reject this with `X-Frame-Options` and
`frame-ancestors`, so no `<iframe>` trick works.

**Solution:** `services/browser-stream` runs a real Chromium via
`playwright-core`. On WebSocket connect it either resumes an existing
`launchPersistentContext(<sessionKey>)` (so cookies/logins survive) or spawns
a new one. Chromium's CDP `Page.startScreencast` streams JPEG frames at ~15 fps
to a `<canvas>` in the renderer. Mouse, wheel and keyboard events flow back
over the same socket. Each project gets its own isolated context.

Client component: `apps/web/src/components/browser/StreamedBrowserWindow.tsx`
Server:           `services/browser-stream/index.mjs`
Wire protocol:    See the top of `index.mjs`. Plain JSON.

## Building and running

Docker (production):

```bash
docker build -f Dockerfile.web -t openloaf-web .
docker run --rm -p 8080:8080 -v openloaf-data:/root/.openloaf openloaf-web
# open http://localhost:8080
```

The image build is heavy (~5-8 GB pnpm store, Playwright's Chromium, native
modules) and takes 15-25 minutes on a first pull. All cached in subsequent
builds unless `pnpm-lock.yaml` changes.

## Environment

- `PORT` — proxy port (default 8080)
- `OPENLOAF_SERVER_PORT` — internal server port (default 23333)
- `OPENLOAF_STREAM_PORT` — internal browser-stream port (default 23334)
- `OPENLOAF_BROWSER_STATE` — where Chromium profiles per session live (default `/root/.openloaf/browser-state`)
- All upstream OpenLoaf server env vars still apply.

## Persistence

Everything under `/root/.openloaf` is a volume: SQLite DB, uploads, browser
profiles. Redeploying the container never touches user data.
