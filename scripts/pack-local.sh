#!/usr/bin/env bash
set -euo pipefail

# Builds @harness/core and @harness/agent, then packs them into tarballs in
# dist-tarballs/. The tarballs can be consumed from outside the pnpm workspace
# using file: references, which proves the session store works as a real library.

cd "$(dirname "$0")/.."
ROOT=$(pwd)
OUT="$ROOT/dist-tarballs"

pnpm build

mkdir -p "$OUT"
rm -f "$OUT"/*.tgz

(
  cd packages/core
  pnpm pack --pack-destination "$OUT" >/dev/null
)

(
  cd packages/agent
  pnpm pack --pack-destination "$OUT" >/dev/null
)

echo "Tarballs written to $OUT"
ls -1 "$OUT"/*.tgz

# Proof that workspace:* has been replaced with a real version.
echo ""
echo "@harness/agent dependency on @harness/core in packed tarball:"
tar -xzf "$OUT"/harness-agent-*.tgz -O package/package.json | grep '"@harness/core"'
