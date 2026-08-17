#!/bin/bash
# OpenLoaf first-boot script.
#
# The runtime image ships with source + built artifacts + package.json
# only. On first boot we install runtime deps and Chromium, both
# cached on the persistent volume so subsequent restarts are instant.
#
# CRITICAL: do NOT use `set -e` — a failed dep install must not crash
# the container into a Coolify restart loop. Log the failure, keep
# going, and let the supervisor decide what to run.
set -uo pipefail  # -e removed deliberately

STATE_DIR="/root/.openloaf"
NODE_MODULES_MARKER="$STATE_DIR/.node_modules-installed"
BROWSER_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$STATE_DIR/browsers}"
BROWSER_MARKER="$BROWSER_PATH/.installed"

mkdir -p "$STATE_DIR"

echo "[first-boot] ==== $(date -u +%H:%M:%S) ===="
echo "[first-boot] state dir: $STATE_DIR"
echo "[first-boot] browser path: $BROWSER_PATH"
ls -la /app 2>&1 | head -15

# ─── pnpm install --prod on first boot ────────────────────────────────
if [ "${OPENLOAF_INSTALL_ON_BOOT:-0}" = "1" ] && [ ! -f "$NODE_MODULES_MARKER" ]; then
  echo "[first-boot] pnpm install --prod (once per volume; ~3-5 min)…"
  cd /app
  # --ignore-workspace-cycles and skip desktop workspace which has
  # electron postinstall we don't need for web mode.
  pnpm install --prod --no-frozen-lockfile --ignore-scripts \
    --filter '!@openloaf/desktop' --reporter=append-only 2>&1 | tail -30
  IEC=${PIPESTATUS[0]}
  if [ "$IEC" != "0" ]; then
    echo "[first-boot] pnpm --prod (filtered) exited $IEC, retrying without filter (all workspaces)…"
    sleep 10
    pnpm install --prod --no-frozen-lockfile --ignore-scripts --reporter=append-only 2>&1 | tail -30
    IEC=${PIPESTATUS[0]}
    echo "[first-boot] second attempt exit: $IEC"
  fi
  echo "[first-boot] rebuilding native modules…"
  for pkg in sharp better-sqlite3 node-pty; do
    (cd /app/node_modules/$pkg 2>/dev/null && npm rebuild 2>&1 | tail -2) || echo "  skip $pkg"
  done
  # Mark done even on partial failure — supervisor will surface real error
  touch "$NODE_MODULES_MARKER" 2>/dev/null || true
  echo "[first-boot] node_modules install done (marker set)"
else
  echo "[first-boot] node_modules already installed (marker present)"
fi

# ─── Chromium (Playwright) install ────────────────────────────────────
if [ "${OPENLOAF_INSTALL_CHROMIUM_ON_BOOT:-0}" = "1" ] && [ ! -f "$BROWSER_MARKER" ]; then
  echo "[first-boot] downloading Chromium (once per volume; ~2 min)…"
  mkdir -p "$BROWSER_PATH"
  if [ -f /app/node_modules/playwright-core/cli.js ]; then
    (cd /app && node ./node_modules/playwright-core/cli.js install chromium 2>&1 | tail -20) \
      || echo "[first-boot] chromium install failed; browser tab will be unavailable"
    touch "$BROWSER_MARKER" 2>/dev/null || true
  else
    echo "[first-boot] playwright-core not installed; skipping Chromium"
  fi
else
  echo "[first-boot] Chromium already installed"
fi

# Verify supervisor entry exists before exec'ing
if [ ! -f /app/services/entrypoint/entrypoint.mjs ]; then
  echo "[first-boot] FATAL: /app/services/entrypoint/entrypoint.mjs missing"
  ls -la /app/services/entrypoint 2>&1
  # Keep container alive so the operator can inspect
  echo "[first-boot] entering keep-alive so logs are inspectable"
  exec sleep infinity
fi

echo "[first-boot] handing off to supervisor…"
exec node /app/services/entrypoint/entrypoint.mjs
