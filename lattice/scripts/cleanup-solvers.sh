#!/usr/bin/env bash
# Kill ORPHANED solver JVMs left behind by interrupted test runs.
#
# Interrupted vitest runs (Ctrl-C, killed agents, crashed sessions) can strand Apalache server
# JVMs and AlloyRunner processes. They accumulate, eat CPU, and slow later runs — notably the
# load-sensitive golden-trace-B latency assertion. This script kills only processes that are
# BOTH solver-shaped (command line matches apalache/AlloyRunner) AND orphaned (re-parented to
# PID 1, i.e. their launching process is dead). Live solvers belonging to a running test session
# — including other concurrent sessions/worktrees — have living parents and are never touched.
#
# Usage: cleanup-solvers.sh [--dry-run]
set -euo pipefail
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

KILLED=0
while IFS= read -r line; do
  pid=$(echo "$line" | awk '{print $1}')
  ppid=$(echo "$line" | awk '{print $2}')
  [ "$ppid" = "1" ] || continue
  cmd=$(echo "$line" | cut -c1-140)
  if [ "$DRY_RUN" = "1" ]; then
    echo ">> [dry-run] would kill orphaned solver pid $pid: $cmd"
  else
    echo ">> killing orphaned solver pid $pid: $cmd"
    kill "$pid" 2>/dev/null || true
  fi
  KILLED=$((KILLED + 1))
done < <(ps -axo pid=,ppid=,command= | grep -E 'apalache|AlloyRunner' | grep -v grep || true)

echo ">> cleanup-solvers: $KILLED orphaned solver process(es) $([ "$DRY_RUN" = "1" ] && echo 'found' || echo 'killed')"
