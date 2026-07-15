#!/usr/bin/env bash
# Kill solver JVMs STRANDED by hard-killed test runs.
#
# A run killed without a chance to clean up (SIGKILL'd agent, crashed session) can strand Apalache
# server JVMs and AlloyRunner processes. They eat CPU and slow later runs — notably the
# load-sensitive golden-trace-B latency assertion. This script kills only processes that are
# solver-shaped (command line matches apalache/AlloyRunner), orphaned (re-parented to PID 1, i.e.
# their launching process is dead), AND older than MIN_AGE_SECS. Live solvers belonging to a
# running test session — including other concurrent sessions/worktrees — have living parents and
# are never touched.
#
# Why the age filter: a solver JVM re-parents to PID 1 for a few seconds while it shuts down
# NORMALLY, because its `npx`/`quint` ancestors exit first. Measured: an Apalache server shows
# ppid=1 around t=12s after its parent is SIGTERMed and is gone by t=24s, with no help from this
# script. A ppid=1-only test therefore matches routine shutdown, kills JVMs that were already
# exiting, and reports them as "orphans" — which is how a shutdown race got mistaken for a leak
# (60s of sampling across 13 active worktrees found zero genuine strays). Only a process orphaned
# for longer than any normal shutdown is real, so the count here means something.
#
# Usage: cleanup-solvers.sh [--dry-run]
set -euo pipefail
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

MIN_AGE_SECS=${MIN_AGE_SECS:-60}

# ps reports elapsed time as [[dd-]hh:]mm:ss. Parse to seconds. Arithmetic runs in awk, not bash,
# so zero-padded fields ("08") can't be misread as octal.
etime_to_secs() {
  awk -v e="$1" 'BEGIN {
    d = 0
    if (index(e, "-")) { split(e, a, "-"); d = a[1] + 0; e = a[2] }
    n = split(e, t, ":")
    if (n == 3)      s = t[1] * 3600 + t[2] * 60 + t[3]
    else if (n == 2) s = t[1] * 60 + t[2]
    else             s = t[1] + 0
    print d * 86400 + s
  }'
}

# Sourced by the parser test; skip the sweep itself.
[ "${1:-}" = "--source-only" ] && return 0 2>/dev/null

KILLED=0
SHUTTING_DOWN=0
while IFS= read -r line; do
  pid=$(echo "$line" | awk '{print $1}')
  ppid=$(echo "$line" | awk '{print $2}')
  [ "$ppid" = "1" ] || continue
  age=$(etime_to_secs "$(echo "$line" | awk '{print $3}')")
  if [ "$age" -lt "$MIN_AGE_SECS" ]; then
    SHUTTING_DOWN=$((SHUTTING_DOWN + 1))   # normal shutdown in progress — not ours to kill
    continue
  fi
  cmd=$(echo "$line" | cut -c1-140)
  if [ "$DRY_RUN" = "1" ]; then
    echo ">> [dry-run] would kill stranded solver pid $pid (orphaned ${age}s): $cmd"
  else
    echo ">> killing stranded solver pid $pid (orphaned ${age}s): $cmd"
    kill "$pid" 2>/dev/null || true
  fi
  KILLED=$((KILLED + 1))
done < <(ps -axo pid=,ppid=,etime=,command= | grep -E 'apalache|AlloyRunner' | grep -v grep || true)

[ "$SHUTTING_DOWN" -gt 0 ] && echo ">> cleanup-solvers: ignored $SHUTTING_DOWN solver process(es) shutting down normally (< ${MIN_AGE_SECS}s)"
echo ">> cleanup-solvers: $KILLED stranded solver process(es) $([ "$DRY_RUN" = "1" ] && echo 'found' || echo 'killed')"
