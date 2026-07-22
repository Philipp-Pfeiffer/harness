#!/usr/bin/env bash
#
# Graceful restart of the Harness daemon.
#
# WHY THIS EXISTS:
# Hard-killing the daemon (kill -9) interrupts the Baileys WhatsApp connection
# mid-flight. Doing this repeatedly invalidates the stored auth state server-side
# and forces a fresh QR-code scan. Always use this script or the equivalent
# SIGTERM + wait flow when restarting.
#
# Usage:
#   ./scripts/restart-daemon.sh
#
# The script reads required environment variables from ~/.bashrc exports.

set -euo pipefail

STATE_DIR="${HARNESS_STATE:-$HOME/.harness}"
PID_FILE="$STATE_DIR/daemon.pid"

echo "[restart-daemon] Gracefully stopping daemon..."

if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    # SIGTERM lets the daemon close the WhatsApp socket cleanly.
    kill -TERM "$PID"
    # Wait up to 15s for clean exit.
    for i in {1..30}; do
      if ! kill -0 "$PID" 2>/dev/null; then
        echo "[restart-daemon] Daemon stopped cleanly."
        break
      fi
      sleep 0.5
    done
    if kill -0 "$PID" 2>/dev/null; then
      echo "[restart-daemon] Daemon did not stop in time; using SIGKILL."
      kill -9 "$PID" || true
      sleep 1
    fi
  fi
  rm -f "$PID_FILE"
else
  # Fallback: try to find the process and terminate gracefully.
  PID=$(pgrep -f "node packages/agent/dist/index.js daemon run" || true)
  if [[ -n "$PID" ]]; then
    kill -TERM "$PID" || true
    sleep 5
    if kill -0 "$PID" 2>/dev/null; then
      kill -9 "$PID" || true
      sleep 1
    fi
  fi
fi

# Source environment (WHATSAPP_WHITELIST_NUMBER, ASSEMBLYAI_API_KEY, OPENROUTER_API_KEY, etc.)
# shellcheck source=/dev/null
if [[ -f "$HOME/.bashrc" ]]; then
  source "$HOME/.bashrc"
fi

echo "[restart-daemon] Starting daemon..."
node packages/agent/dist/index.js daemon run
