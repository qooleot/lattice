#!/usr/bin/env bash
# Bootstrap the lattice engine in a fresh checkout or linked git worktree.
# Idempotent. Installs node deps if missing and links the (gitignored) solver
# binaries from the main checkout when running inside a worktree, so each new
# session doesn't re-download ~350MB. Falls back to fetch-solvers.sh.
set -euo pipefail
cd "$(dirname "$0")/.."   # lattice/

# Install node deps when missing OR stale (lockfile changed since the last install here).
LOCK_STAMP=node_modules/.ensure-ready.lock-hash
LOCK_HASH=$(git hash-object package-lock.json)
if [ ! -d node_modules ] || [ "$(cat "$LOCK_STAMP" 2>/dev/null)" != "$LOCK_HASH" ]; then
  echo ">> installing node deps"
  npm ci --silent
  echo "$LOCK_HASH" > "$LOCK_STAMP"
fi

# Locate the main checkout's lattice/vendor via the shared git dir.
COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
MAIN_LATTICE="$(dirname "$COMMON")/lattice"
mkdir -p vendor

link_if_missing() {
  local name="$1"
  [ -e "vendor/$name" ] && return 0
  if [ -e "$MAIN_LATTICE/vendor/$name" ] && [ "$MAIN_LATTICE" != "$(pwd)" ]; then
    ln -s "$MAIN_LATTICE/vendor/$name" "vendor/$name"
    echo ">> linked vendor/$name from main checkout"
  fi
}
link_if_missing alloy.jar
link_if_missing AlloyRunner.class
link_if_missing jdk

if [ ! -e vendor/alloy.jar ] || [ ! -e vendor/jdk ]; then
  echo ">> solver binaries not found locally or in main checkout — fetching"
  bash scripts/fetch-solvers.sh
fi

# Regenerate the langium parser when missing OR stale (grammar/config newer than output).
if [ ! -f src/parse/generated/module.ts ] \
   || [ src/parse/lat.langium -nt src/parse/generated/module.ts ] \
   || [ langium-config.json -nt src/parse/generated/module.ts ]; then
  echo ">> generating langium parser"; npx langium generate
fi

bash scripts/cleanup-solvers.sh

npx tsx src/solvers/doctor.ts
