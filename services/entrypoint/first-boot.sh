#!/bin/bash
# OpenLoaf first-boot script.
#
# Rather than baking Chromium into the image (adds ~450 MB and a
# gigantic layer that fails on flaky networks), we install it on first
# container boot. It's cached on the persistent volume so subsequent
# restarts skip this step entirely.
set -euo pipefail

BROWSER_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
MARKER="$BROWSER_PATH/.installed"

if [ "${OPENLOAF_INSTALL_CHROMIUM_ON_BOOT:-0}" = "1" ] && [ ! -f "$MARKER" ]; then
  echo "[first-boot] downloading Chromium (once per volume; ~3 min)…"
  mkdir -p "$BROWSER_PATH"
  # `playwright install` reads PLAYWRIGHT_BROWSERS_PATH from env
  cd /app && node ./node_modules/playwright-core/cli.js install chromium 2>&1 | tail -20 \
    || echo "[first-boot] chromium install failed; embedded browser tab will be unavailable"
  touch "$MARKER" 2>/dev/null || true
else
  echo "[first-boot] Chromium already installed (marker=$MARKER)"
fi

# Hand off to the main entrypoint supervisor
exec node /app/services/entrypoint/entrypoint.mjs
