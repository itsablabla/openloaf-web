#!/bin/bash
# OpenLoaf first-boot script.
#
# The runtime image ships with source + built artifacts + package.json
# only. On first boot we install runtime deps and Chromium, both
# cached on the persistent volume so subsequent restarts are instant.
set -euo pipefail

STATE_DIR="/root/.openloaf"
NODE_MODULES_CACHE="$STATE_DIR/node_modules"
NODE_MODULES_MARKER="$STATE_DIR/.node_modules-installed"
BROWSER_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$STATE_DIR/browsers}"
BROWSER_MARKER="$BROWSER_PATH/.installed"

mkdir -p "$STATE_DIR"

# ─── pnpm install --prod on first boot ────────────────────────────────
# We install into a volume-cached location and symlink into /app so
# subsequent boots skip this entirely.
if [ "${OPENLOAF_INSTALL_ON_BOOT:-0}" = "1" ] && [ ! -f "$NODE_MODULES_MARKER" ]; then
  echo "[first-boot] running pnpm install --prod (once per volume; ~3-5 min)…"
  cd /app
  # Install straight into /app/node_modules (small monorepos symlink
  # per-workspace). Let pnpm handle it, then persist to volume cache.
  pnpm install --prod --no-frozen-lockfile --ignore-scripts --reporter=append-only 2>&1 | tail -20 || {
    echo "[first-boot] retry with concurrency=2"
    sleep 30
    npm_config_network_concurrency=2 pnpm install --prod --no-frozen-lockfile --ignore-scripts --reporter=append-only 2>&1 | tail -20 || {
      echo "[first-boot] retry with concurrency=1"
      sleep 60
      npm_config_network_concurrency=1 pnpm install --prod --no-frozen-lockfile --ignore-scripts --reporter=append-only 2>&1 | tail -20
    }
  }
  echo "[first-boot] rebuilding native modules…"
  for pkg in sharp better-sqlite3 node-pty; do
    (cd /app/node_modules/$pkg 2>/dev/null && npm rebuild 2>&1 | tail -2) || echo "  skip $pkg"
  done
  touch "$NODE_MODULES_MARKER" 2>/dev/null || true
  echo "[first-boot] node_modules ready"
else
  echo "[first-boot] node_modules already installed"
fi

# ─── Chromium (Playwright) install ────────────────────────────────────
if [ "${OPENLOAF_INSTALL_CHROMIUM_ON_BOOT:-0}" = "1" ] && [ ! -f "$BROWSER_MARKER" ]; then
  echo "[first-boot] downloading Chromium (once per volume; ~2 min)…"
  mkdir -p "$BROWSER_PATH"
  cd /app && node ./node_modules/playwright-core/cli.js install chromium 2>&1 | tail -20 \
    || echo "[first-boot] chromium install failed; embedded browser tab will be unavailable"
  touch "$BROWSER_MARKER" 2>/dev/null || true
else
  echo "[first-boot] Chromium already installed"
fi

# Hand off to the main entrypoint supervisor
echo "[first-boot] starting supervisor"
exec node /app/services/entrypoint/entrypoint.mjs
