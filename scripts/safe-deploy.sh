#!/usr/bin/env bash
#
# Safe self-deploy: merges a local feature branch into main, builds and tests,
# and on success registers a one-shot deploy watchdog. Called by the daemon
# from /deploy <branch> (packages/agent/src/daemon/deploy.ts) when this script
# exists. Working directory is the repo root; output is streamed into the
# daemon log.
#
# Exit-code contract with the daemon (see SAFE_DEPLOY_EXIT in deploy.ts):
#   0  — branch merged into main, build+typecheck+tests green, restart ok.
#   1  — branch rejected / merge conflict / validation error. main untouched.
#   2  — merge ok, but build/typecheck/test failed. main restored to the
#        previous HEAD (last-known-good).
#
# The script does the git + build work only. The daemon owns the restart
# marker, the /deploy lock, the "Deploy prepared, restarting…" response and
# the actual restart. This script must NEVER touch the running daemon process
# or $HARNESS_STATE.
#
# HOWEVER: last-known-good and the watchdog registration intentionally live in
# $HARNESS_STATE (not the repo): the repo's main may be force-reset by the
# watchdog, so the previous HEAD must survive outside the repo.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${HARNESS_STATE:-$HOME/.harness}"
LAST_KNOWN_GOOD_FILE="$STATE_DIR/last-known-good"

# Timeout for the whole build+test step (10 minutes, mirrors
# DEPLOY_TIMEOUT_MS in deploy.ts).
BUILD_TIMEOUT_MIN=10
# Timeout for pnpm install alone — it can legitimately take longer than the
# build step on a cold store.
INSTALL_TIMEOUT_MIN=15

# Prints an unquoted echo-able text arg to stdout. Wrapper so all output of
# this script goes through the same channel (the daemon streams stdout).
say() { printf '%s\n' "$*"; }

die() {
  printf 'safe-deploy: %s\n' "$*" >&2
  exit "${2:-1}"
}

# Reads the previous main HEAD from the last-known-good file.
read_last_known_good() {
  if [[ ! -f "$LAST_KNOWN_GOOD_FILE" ]]; then
    return 1
  fi
  cut -d' ' -f1 "$LAST_KNOWN_GOOD_FILE"
}

# --- Argument validation -------------------------------------------------

[[ $# -eq 1 ]] || die "usage: $0 <branch>" 1
BRANCH="$1"

case "$BRANCH" in
  main|origin/main|HEAD)
    die "deploy rejected: '$BRANCH' cannot be merged into main" 1
    ;;
esac

# The branch must exist locally (no fetch — the repo has no remote).
if ! git -C "$REPO_DIR" rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
  die "branch '$BRANCH' does not exist locally" 1
fi

cd "$REPO_DIR"

# --- Snapshot main state before anything can change it --------------------

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$CURRENT_BRANCH" == "main" ]] || die "refusing to deploy: expected to run on main, but HEAD is on '$CURRENT_BRANCH'" 1

# Working tree must be clean — merging onto uncommitted changes is a recipe
# for a partially applied deploy.
if [[ -n "$(git status --porcelain)" ]]; then
  die "refusing to deploy: working tree is dirty" 1
fi

PREV_HEAD="$(git rev-parse HEAD)"
mkdir -p "$STATE_DIR"
# Format: "<full sha> <branch>" — the watchdog resets the repo hard onto the
# sha and needs the branch to recreate it with -B after a detached reset.
printf '%s %s\n' "$PREV_HEAD" "main" > "$LAST_KNOWN_GOOD_FILE"
say "safe-deploy: main at $PREV_HEAD (last-known-good recorded)"

# --- Merge the branch into main -------------------------------------------

# The merge commit needs a git identity. The repo has no user.* configured
# (the daemon's own commits are authored as "Harness Agent"), so default to
# the same identity if none is set — otherwise the merge fails on the
# "Author identity unknown" error. Explicit env overrides user config.
if [[ -z "$(git config user.name || true)" && -z "${GIT_AUTHOR_NAME:-}" ]]; then
  export GIT_AUTHOR_NAME="Harness Agent"
  export GIT_AUTHOR_EMAIL="agent@harness.dev"
  export GIT_COMMITTER_NAME="Harness Agent"
  export GIT_COMMITTER_EMAIL="agent@harness.dev"
fi

if ! git merge --no-edit "$BRANCH"; then
  git merge --abort
  die "merge of '$BRANCH' into main failed (conflict?) — aborted, main unchanged" 1
fi

# --- Build + test gate -----------------------------------------------------

run_step() {
  local label="$1"; shift
  say "safe-deploy: $label"
  if ! timeout "${BUILD_TIMEOUT_MIN}m" "$@"; then
    return 1
  fi
}

rollback() {
  say "safe-deploy: build/test failed — restoring main to $PREV_HEAD"
  if ! git reset --hard "$PREV_HEAD" >/dev/null; then
    die "rollback failed (git reset --hard $PREV_HEAD) — manual intervention required" 2
  fi
  git clean -fdq
}

# Each step on its own line of output, so a failure is attributable.
if ! run_step "pnpm install" env timeout "${INSTALL_TIMEOUT_MIN}m" pnpm install; then
  rollback
  die "pnpm install failed" 2
fi
if ! run_step "pnpm build" pnpm build; then
  rollback
  die "pnpm build failed" 2
fi
if ! run_step "pnpm typecheck" pnpm typecheck; then
  rollback
  die "pnpm typecheck failed" 2
fi
if ! run_step "pnpm --filter @harness/agent test" pnpm --filter @harness/agent test; then
  rollback
  die "tests failed" 2
fi

# --- Success: register the one-shot deploy watchdog ------------------------

NEW_HEAD="$(git rev-parse HEAD)"
# systemd-run creates a transient timer that fires once after 90s and then
# stops itself. The watchdog checks daemon health and rolls back on failure.
if ! systemd-run --user --on-active=90 --unit harness-deploy-watchdog \
    "$REPO_DIR/scripts/deploy-watchdog.sh" >/dev/null 2>&1; then
  say "safe-deploy: WARNING — deploy watchdog could not be registered (systemd-run failed). No rollback protection."
else
  say "safe-deploy: deploy watchdog registered (fires in 90s)"
fi

say "safe-deploy: ok — main at $NEW_HEAD, build+typecheck+tests green"
exit 0
