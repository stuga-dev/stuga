#!/bin/bash
# launchd's Postgres job: the server in the foreground, launchd's stop made a fast shutdown.
#
# To Postgres SIGTERM is a smart shutdown, which waits for the node's connections to close
# until launchd's ExitTimeOut SIGKILLs it into crash recovery. SIGTERM and SIGINT therefore
# become SIGINT (fast shutdown) for the postmaster, which is why this cannot exec postgres.
#
# Exits with the server's status, so KeepAlive restarts a crash and not a stop. A missing
# runtime or cluster exits 0: retrying cannot fix either.
#
#   $STUGA_ROOT/current/postgres/bin/postgres   the server
#   $STUGA_ROOT/data/pgdata                     the cluster
#   $STUGA_ROOT/data/run                        the socket directory
set -euo pipefail

main() {
  say() { printf '%s [postgres-wrapper] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

  if [ -z "${STUGA_ROOT:-}" ]; then
    say "STUGA_ROOT is not set. Not starting."
    exit 0
  fi
  local postgres="$STUGA_ROOT/current/postgres/bin/postgres"
  local pgdata="$STUGA_ROOT/data/pgdata"
  local run_dir="$STUGA_ROOT/data/run"

  if [ ! -x "$postgres" ]; then
    say "no Postgres at $postgres; is $STUGA_ROOT/current a runtime? Not starting."
    exit 0
  fi
  if [ ! -f "$pgdata/PG_VERSION" ]; then
    say "no cluster at $pgdata; run init-cluster.sh first. Not starting."
    exit 0
  fi

  mkdir -p "$run_dir"
  chmod 0700 "$run_dir"

  child=""
  # shellcheck disable=SC2329 # invoked by the trap below
  fast_shutdown() {
    say "stop requested; asking Postgres for a fast shutdown"
    if [ -n "$child" ]; then kill -INT "$child" 2>/dev/null || true; fi
  }
  trap fast_shutdown TERM INT

  "$postgres" -D "$pgdata" &
  child=$!
  say "started Postgres (pid $child) on $pgdata"

  # wait returns whenever a trapped signal arrives: keep waiting until the postmaster is gone.
  while kill -0 "$child" 2>/dev/null; do
    wait "$child" || true
  done
  local status=0
  wait "$child" || status=$?
  say "Postgres exited with status $status"
  exit "$status"
}

# The whole script is one function called on the last line: bash reads a script as it runs
# it, so a wrapper replaced in place mid-run would continue from the same offset in the new
# bytes. A function is parsed whole before it is called, and `exit` stops bash reading on.
# shellcheck disable=SC2317 # exit is reached only if main returns
{ main "$@"; exit; }
