#!/usr/bin/env bash
set -euo pipefail

# Verifies that @harness/agent and @harness/core are consumable as real npm
# packages outside the pnpm workspace. Creates a fresh temp directory with its
# own package.json, installs the packed tarballs via file: references, and runs
# a tiny consumer script that writes and reads a session.

cd "$(dirname "$0")/.."
ROOT=$(pwd)
TARBALL_DIR="$ROOT/dist-tarballs"

if ! ls "$TARBALL_DIR"/harness-core-*.tgz >/dev/null 2>&1; then
  echo "Tarballs not found in $TARBALL_DIR. Run scripts/pack-local.sh first." >&2
  exit 1
fi

if ! ls "$TARBALL_DIR"/harness-agent-*.tgz >/dev/null 2>&1; then
  echo "Tarballs not found in $TARBALL_DIR. Run scripts/pack-local.sh first." >&2
  exit 1
fi

CORE_TARBALL=$(ls "$TARBALL_DIR"/harness-core-*.tgz | head -1)
AGENT_TARBALL=$(ls "$TARBALL_DIR"/harness-agent-*.tgz | head -1)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Foreign consumer temp dir: $TMP"

# Walk up from TMP to / and abort if any pnpm-workspace.yaml is found.
current="$TMP"
while [[ "$current" != "/" ]]; do
  if [[ -f "$current/pnpm-workspace.yaml" ]]; then
    echo "ERROR: pnpm-workspace.yaml found at $current — this would make the consumer part of a workspace." >&2
    exit 1
  fi
  current=$(dirname "$current")
done
echo "OK: no pnpm-workspace.yaml found in parent path"

# Copy tarballs into the isolated consumer directory.
cp "$CORE_TARBALL" "$TMP/harness-core.tgz"
cp "$AGENT_TARBALL" "$TMP/harness-agent.tgz"

# Patch the agent tarball so its transitive dependency on @harness/core resolves
# to the local tarball instead of the npm registry.
(
  cd "$TMP"
  mkdir -p patch-agent
  tar -xzf harness-agent.tgz -C patch-agent
  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync("patch-agent/package/package.json", "utf-8"));
    pkg.dependencies["@harness/core"] = "file:./harness-core.tgz";
    fs.writeFileSync("patch-agent/package/package.json", JSON.stringify(pkg, null, 2));
  '
  tar -czf harness-agent-patched.tgz -C patch-agent/package .
  rm -rf patch-agent harness-agent.tgz
)

cat > "$TMP/package.json" <<'EOF'
{
  "name": "foreign-consumer-verify",
  "version": "1.0.0",
  "private": true,
  "type": "module"
}
EOF

# Allow node-pty to build (imported transitively by @harness/agent) and do not
# fail the install when other optional native builds are skipped.
cd "$TMP"
pnpm add --config.strict-dep-builds=false --allow-build=node-pty ./harness-core.tgz ./harness-agent-patched.tgz

cat > "$TMP/consumer.mjs" <<'EOF'
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { resolveHarnessPaths } from "@harness/core";
import { createSession, recordTurn, readSession, listSessions } from "@harness/agent";

const stateRoot = join(tmpdir(), `harness-foreign-consumer-verify-${Date.now()}`);
await mkdir(stateRoot, { recursive: true });

const paths = resolveHarnessPaths({
  home: join(stateRoot, "home"),
  state: join(stateRoot, "state"),
});

const session = await createSession(paths, {
  model: "minimax-m2.7",
  title: "Foreign Consumer Test",
});

await recordTurn(session, {
  id: crypto.randomUUID(),
  role: "assistant",
  content: "42",
  userContent: "What is 6 * 7?",
  tokens: { input: 10, output: 5, total: 15, cacheRead: 0, cacheWrite: 0 },
  timing: { startedAt: new Date().toISOString(), latencyMs: 100 },
  model: "minimax-m2.7",
  timestamp: new Date().toISOString(),
}, paths);

const loaded = await readSession(session.id, paths);
if (!loaded) throw new Error("session not found after write");
if (loaded.session.title !== "Foreign Consumer Test") throw new Error("unexpected title: " + loaded.session.title);
if (loaded.turns.length !== 1) throw new Error("expected 1 turn, got " + loaded.turns.length);

const all = await listSessions(paths);
if (all.length !== 1) throw new Error("expected 1 listed session, got " + all.length);

console.log("OK: wrote and read session", session.id, "in", stateRoot);
EOF

node "$TMP/consumer.mjs"
