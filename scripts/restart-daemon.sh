#!/usr/bin/env bash
#
# Graceful, race-free restart of the Harness daemon.
#
# WHY THIS EXISTS:
# Hard-killing the daemon (kill -9) interrupts the Baileys WhatsApp connection
# mid-flight. Doing this repeatedly invalidates the stored auth state server-side
# and forces a fresh QR-code scan. Always use this script or the equivalent
# SIGTERM + wait flow when restarting.
#
# This script guarantees that the old daemon is fully gone BEFORE the new one
# starts. Running two Harness daemons at the same time corrupts the Baileys
# auth state and is the #1 reason for unexpected re-pairing.
#
# Usage:
#   ./scripts/restart-daemon.sh
#   ./scripts/restart-daemon.sh --reset-whatsapp-auth
#
# Run it in the foreground. Do NOT background it with `&` — the script must keep
# control until the hand-over is complete.
#
# Use --reset-whatsapp-auth to wipe the Baileys auth state before starting. This
# is required when changing the WhatsApp phone number, because Baileys binds the
# persisted auth state to a single number.

set -euo pipefail

STATE_DIR="${HARNESS_STATE:-$HOME/.harness}"
PID_FILE="$STATE_DIR/daemon.pid"
LOCK_FILE="$STATE_DIR/restart.lock"
DAEMON_PATTERN="node packages/agent/dist/index.js daemon run"

# Prevent two restarts from racing each other.
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  echo "[restart-daemon] Another restart is already in progress. Aborting." >&2
  exit 1
fi

echo "[restart-daemon] Gracefully stopping daemon..."

# Helper: wait until no harness daemon process is visible anymore.
wait_until_stopped() {
  local deadline=$(( $(date +%s) + 30 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    local alive
    alive=$(pgrep -f "$DAEMON_PATTERN" || true)
    if [[ -z "$alive" ]]; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

stop_via_pid_file() {
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  if [[ -z "$pid" ]]; then
    return 1
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    return 1
  fi
  echo "[restart-daemon] Sending SIGTERM to PID $pid..."
  kill -TERM "$pid" || true
  if wait_until_stopped; then
    echo "[restart-daemon] Daemon stopped cleanly."
    rm -f "$PID_FILE"
    return 0
  fi
  echo "[restart-daemon] Daemon did not stop in time; using SIGKILL."
  kill -9 "$pid" 2>/dev/null || true
  sleep 1
  rm -f "$PID_FILE"
  return 0
}

stop_via_pgrep() {
  local pids
  pids=$(pgrep -f "$DAEMON_PATTERN" || true)
  if [[ -z "$pids" ]]; then
    return 0
  fi
  echo "[restart-daemon] Sending SIGTERM to processes: $pids"
  echo "$pids" | xargs -r kill -TERM 2>/dev/null || true
  if wait_until_stopped; then
    echo "[restart-daemon] Daemon stopped cleanly."
    return 0
  fi
  pids=$(pgrep -f "$DAEMON_PATTERN" || true)
  if [[ -n "$pids" ]]; then
    echo "[restart-daemon] Using SIGKILL on remaining processes: $pids"
    echo "$pids" | xargs -r kill -9 2>/dev/null || true
    sleep 1
  fi
}

if [[ -f "$PID_FILE" ]]; then
  stop_via_pid_file || stop_via_pgrep
else
  stop_via_pgrep
fi

# Final safety check: there must be absolutely no daemon process left.
remaining=$(pgrep -f "$DAEMON_PATTERN" || true)
if [[ -n "$remaining" ]]; then
  echo "[restart-daemon] FATAL: daemon processes still alive after stop: $remaining" >&2
  exit 1
fi

# Optional: reset WhatsApp auth state when changing the bound phone number.
if [[ "${1:-}" == "--reset-whatsapp-auth" ]]; then
  WA_AUTH_DIR="$STATE_DIR/whatsapp/auth"
  echo "[restart-daemon] Resetting WhatsApp auth state at $WA_AUTH_DIR..."
  rm -rf "$WA_AUTH_DIR"
  mkdir -p "$WA_AUTH_DIR"
fi

# Source environment (WHATSAPP_WHITELIST_NUMBER, ASSEMBLYAI_API_KEY, OPENROUTER_API_KEY, etc.)
# ~/.bashrc exits early in non-interactive shells, so we load the dedicated
# Harness env file directly.
# shellcheck source=/dev/null
if [[ -f "$HOME/.harness_env" ]]; then
  source "$HOME/.harness_env"
fi

echo "[restart-daemon] Starting daemon..."
# Replace this shell with the daemon. This ensures the daemon is the only
# long-running process and avoids accidental double-starts from the parent shell.
exec node packages/agent/dist/index.js daemon run
