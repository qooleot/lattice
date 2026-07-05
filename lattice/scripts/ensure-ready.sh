#!/usr/bin/env bash
# Bootstrap the lattice engine in a fresh checkout or linked git worktree.
# Idempotent. Installs node deps if missing and links the (gitignored) solver
# binaries from the main checkout when running inside a worktree, so each new
# session doesn't re-download ~350MB. Falls back to fetch-solvers.sh.
set -euo pipefail
cd "$(dirname "$0")/.."   # lattice/

[ -d node_modules ] || { echo ">> installing node deps"; npm ci --silent; }

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

npx tsx src/solvers/doctor.ts
