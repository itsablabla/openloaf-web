#!/bin/bash
# OpenLoaf first-boot: install Chromium (cached on the volume) then
# hand off to the entrypoint supervisor. node_modules is baked in the
# image so this only downloads Chromium (~150 MB) on the very first
# container boot.
#
# CRITICAL: do NOT use `set -e` here — a failed Chromium install must
# NOT crash the container into a Coolify restart loop.
set -uo pipefail

STATE_DIR="/root/.openloaf"
BROWSER_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$STATE_DIR/browsers}"
BROWSER_MARKER="$BROWSER_PATH/.installed"

mkdir -p "$STATE_DIR"
echo "[first-boot] ==== $(date -u +%H:%M:%S) ===="

if [ "${OPENLOAF_INSTALL_CHROMIUM_ON_BOOT:-0}" = "1" ] && [ ! -f "$BROWSER_MARKER" ]; then
  echo "[first-boot] downloading Chromium (once per volume; ~2 min)…"
  mkdir -p "$BROWSER_PATH"
  if [ -f /app/node_modules/playwright-core/cli.js ]; then
    (cd /app && node ./node_modules/playwright-core/cli.js install chromium 2>&1 | tail -20) \
      || echo "[first-boot] chromium install failed; browser tab will be unavailable"
    touch "$BROWSER_MARKER" 2>/dev/null || true
  else
    echo "[first-boot] playwright-core not installed; skipping Chromium (browser tab unavailable)"
  fi
else
  echo "[first-boot] Chromium already installed"
fi

if [ ! -f /app/services/entrypoint/entrypoint.mjs ]; then
  echo "[first-boot] FATAL: entrypoint.mjs missing"
  ls -la /app/services/entrypoint 2>&1
  exec sleep infinity
fi

echo "[first-boot] handing off to supervisor…"
exec node /app/services/entrypoint/entrypoint.mjs
