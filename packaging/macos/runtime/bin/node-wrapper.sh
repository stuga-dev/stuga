#!/bin/bash
# launchd's node job: wait until Postgres accepts connections, then become `stuga-node serve`.
#
# launchd starts both jobs at once with no ordering, and the socket file exists before
# recovery finishes, so this polls pg_isready. The node is exec'd so launchd's SIGTERM
# reaches its graceful shutdown. Not ready within 300 s: exit 75 and launchd retries. A missing
# runtime or setting exits 0: retrying cannot fix it.
#
# The node's output goes through rotate-log.mjs into $STUGA_LOG_DIR/node-<Day>.log: launchd
# never rotates a plist's log file, and the node runs for months. The plist's own log keeps
# only this wrapper's lines. Everything the node reads comes from the plist's environment.
set -euo pipefail

main() {
  say() { printf '%s [node-wrapper] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

  local name
  for name in STUGA_ROOT STUGA_LOG_DIR DATABASE_URL; do
    if [ -z "${!name:-}" ]; then
      say "$name is not set; the plist must set it. Not starting."
      exit 0
    fi
  done
  local runtime="$STUGA_ROOT/current"
  local node="$runtime/node/bin/node"
  local app="$runtime/app/services/node"
  local pg_isready="$runtime/postgres/bin/pg_isready"
  local rotate="$runtime/bin/rotate-log.mjs"
  local wait_limit=300

  local need
  for need in "$node" "$pg_isready"; do
    if [ ! -x "$need" ]; then
      say "missing $need; is $runtime a runtime? Not starting."
      exit 0
    fi
  done
  for need in "$app/bin/stuga-node.js" "$rotate"; do
    if [ ! -f "$need" ]; then
      say "missing $need; is $runtime a runtime? Not starting."
      exit 0
    fi
  done

  local waited=0
  until "$pg_isready" -q -d "$DATABASE_URL"; do
    if [ "$waited" -ge "$wait_limit" ]; then
      say "Postgres has not accepted connections for ${wait_limit}s; exiting so launchd tries again"
      exit 75
    fi
    if [ $((waited % 15)) -eq 0 ]; then say "waiting for Postgres (${waited}s)"; fi
    sleep 1
    waited=$((waited + 1))
  done

  cd "$app"
  say "Postgres is up; starting the node, logging to $STUGA_LOG_DIR/node-<Day>.log"
  # The node stays exec'd with its output piped to rotate-log; the plist's AbandonProcessGroup
  # lets rotate-log copy the node's last lines and exit when the pipe closes.
  exec > >(exec "$node" "$rotate" "$STUGA_LOG_DIR" node) 2>&1
  exec "$node" bin/stuga-node.js serve
}

# One function, called on the last line, like postgres-wrapper.sh.
# shellcheck disable=SC2317 # exit is reached only if main returns
{ main "$@"; exit; }
