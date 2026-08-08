#!/usr/bin/env bash
#
# Deploy watchdog: verifies the daemon came back healthy after a self-deploy
# (safe-deploy.sh), and rolls back the repo if not.
#
# Registered as a one-shot systemd timer by safe-deploy.sh:
#   systemd-run --user --on-active=90 --unit harness-deploy-watchdog \
#     <repo>/scripts/deploy-watchdog.sh
# It fires once ~90s after the deploy. If the daemon is healthy by then, it
# exits silently. If not, it resets main to last-known-good, rebuilds, and
# restarts the daemon (systemd user unit harness-daemon.service).
#
# Idempotent: a second run while the first is still rolling back is a no-op
# (flock). A healthy daemon after a rollback skips re-rolling-back (the
# health check happens again before the rollback path).
#
# Notes:
# - The daemon is restarted via systemctl --user, NEVER via kill — hard-killing
#   the Baileys WhatsApp connection corrupts the auth state (see
#   scripts/restart-daemon.sh).
# - The reset targets the sha + branch recorded by safe-deploy.sh in
#   $HARNESS_STATE/last-known-good. The repo checkout is HARNESS_REPO below.
#   The daemon runs from ~/dev/harness on assistomat (HARNESS_REPO_DIR in
#   selfModify.ts resolves to the same path when run from that checkout), and
#   a deploy can only be triggered while the daemon runs from it. The watchdog
#   therefore always operates on the production checkout — never on a worktree.
# - The watchdog is transient (one-shot timer). It never touches
#   $HARNESS_STATE except for last-known-good / rollback log / its lock.

set -euo pipefail

STATE_DIR="${HARNESS_STATE:-$HOME/.harness}"
# The production repo the daemon runs from (assistomat). Do not point this at
# a worktree — worktrees must not be modified by the watchdog.
HARNESS_REPO="${HARNESS_REPO:-/home/p-pfeiffer/dev/harness}"
LAST_KNOWN_GOOD_FILE="$STATE_DIR/last-known-good"
ROLLBACK_LOG="$STATE_DIR/deploy-rollback.log"
LOCK_FILE="$STATE_DIR/deploy-watchdog.lock"
UNIT="harness-daemon"

# --- Single-flight lock ----------------------------------------------------
# Analogous to scripts/restart-daemon.sh: no parallel rollbacks. The lock is
# kept for the whole watchdog run; the fd is closed on exit.
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  echo "[deploy-watchdog] Another watchdog run is in progress. Aborting." >&2
  exit 0
fi
# Ensure the lock fd is released when the script exits (also covers exec
# failure paths). Explicitly keep the fd open for the remainder.
trap 'exit 0' EXIT
trap 'exit 1' INT TERM

# --- Health check ----------------------------------------------------------

check_daemon() {
  local path="${1:-}"
  if [[ -z "$path" || ! -S "$path" ]]; then
    return 1
  fi
  if ! timeout 10 node "$HARNESS_REPO/packages/agent/dist/index.js" daemon status \
      >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

SOCKET="$STATE_DIR/daemon.sock"

# First check immediately (the deploy's systemd restart may have happened
# already), then up to 2 more attempts at 15s intervals.
say() { printf '%s\n' "$*"; }

is_healthy=false
attempt=1
while true; do
  if check_daemon "$SOCKET"; then
    is_healthy=true
    break
  fi
  if (( attempt >= 3 )); then
    break
  fi
  say "[deploy-watchdog] daemon not healthy (attempt $attempt/3) — retrying in 15s"
  attempt=$((attempt + 1))
  sleep 15
done

if $is_healthy; then
  # Healthy — nothing to do. Exit silently (the timer unit logs nothing).
  exit 0
fi

# --- Rollback --------------------------------------------------------------

# The daemon may have failed to come back at all (worst case) or came back
# unhealthy (best effort: treat as failed). Either way, restore last-known-good.
if [[ ! -f "$LAST_KNOWN_GOOD_FILE" ]]; then
  echo "[deploy-watchdog] FATAL: no last-known-good marker at $LAST_KNOWN_GOOD_FILE — cannot roll back. Manual intervention required." >&2
  exit 1
fi

read -r GOOD_SHA GOOD_BRANCH < "$LAST_KNOWN_GOOD_FILE"
GOOD_SHA="${GOOD_SHA:-}"
GOOD_BRANCH="${GOOD_BRANCH:-main}"
# Validate both fields. Branch names are limited to [a-zA-Z0-9_-./]
# by git, but the marker is trusted state written by safe-deploy.sh.
if [[ ! "$GOOD_SHA" =~ ^[0-9a-f]{40}$ ]] || [[ ! "$GOOD_BRANCH" =~ ^[a-zA-Z0-9_./-]+$ ]]; then
  echo "[deploy-watchdog] FATAL: last-known-good marker is invalid: $(cat "$LAST_KNOWN_GOOD_FILE")" >&2
  exit 1
fi

TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"
{
  echo "[$TIMESTAMP] Deploy rollback triggered (daemon unhealthy after deploy)."
  echo "[$TIMESTAMP]   last-known-good: $GOOD_SHA ($GOOD_BRANCH)"
  echo "[$TIMESTAMP]   current HEAD:   $(git -C "$HARNESS_REPO" rev-parse HEAD 2>/dev/null || echo 'unreadable')"
} >> "$ROLLBACK_LOG"

echo "[deploy-watchdog] Rolling back $HARNESS_REPO to $GOOD_SHA ($GOOD_BRANCH)"

# Hard-reset the repo to the recorded good commit. `git checkout -B` re-points
# the branch at GOOD and updates the worktree + index — the repo ends in a
# normal "main at GOOD" state even if it was on another branch or detached.
# If the worktree is dirty, the checkout refuses (safety) — but the deploy
# only merged cleanly, so a dirty tree is unexpected. When the repo is
# already on GOOD it is a no-op (idempotent).
if ! git -C "$HARNESS_REPO" checkout -q -B "$GOOD_BRANCH" "$GOOD_SHA" 2>/dev/null; then
  echo "[deploy-watchdog] FATAL: git checkout -B $GOOD_BRANCH $GOOD_SHA failed in $HARNESS_REPO. Manual intervention required." >&2
  exit 1
fi

# The rollback is complete — the daemon needs the NEW code, so rebuild before
# restarting. (pnpm install is skipped: node_modules already exists from the
# deploy attempt; the source is back to the same tree.)
if ! (cd "$HARNESS_REPO" && timeout "${BUILD_TIMEOUT_MIN:-10}m" pnpm build); then
  echo "[deploy-watchdog] FATAL: build after rollback failed in $HARNESS_REPO. Manual intervention required." >&2
  exit 1
fi

echo "[deploy-watchdog] Restarting $UNIT via systemctl (graceful SIGTERM, systemd restarts on exit 1)."
# Note: systemctl restart on a Restart=on-failure unit sends SIGTERM and starts
# the unit again; the daemon itself does not use the restart lock file.
systemctl --user restart "$UNIT"
echo "[deploy-watchdog] Rollback complete."

# Re-run the health check after the restart — if it's still not healthy, the
# rollback failed and we leave the system in the known-bad state for manual
# intervention.
sleep 15
if check_daemon "$SOCKET"; then
  echo "[deploy-watchdog] Daemon healthy after rollback."
  exit 0
else
  echo "[deploy-watchdog] WARNING: daemon still unhealthy after rollback — manual intervention required." >&2
  exit 1
fi
