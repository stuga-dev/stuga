#!/bin/bash
# launchd's remote access job (dev.stuga.remote), as _stugaremote: one connector (frpc) per relay
# whose settings the node wrote into $STUGA_ROOT/remote.
#
# The node runs as _stuga, so what it wrote is never trusted. Each <relay>.toml is read once into a
# directory only this job can read, and that copy must be, byte for byte, the config the node renders
# (renderFrpcToml in services/node/src/remote/frpc-config.ts), with every value of the shape the node
# checks it has (check-toml.sh, beside this script). The connector then starts from the copy, with
# --strict-config and never --allow-unsafe. So no settings open an admin interface, a visitor,
# another plugin or a template, or point the connector at files outside $STUGA_ROOT/remote.
#
# Exits 78 when a config is refused (the helper reports it and stops the job), 0 when there is
# nothing to run (retrying cannot fix it), and 1 when a connector exits, after stopping the others:
# launchd starts the job again. TERM and INT stop every connector first. The connectors' output goes
# through rotate-log.mjs into $STUGA_LOG_DIR/frpc-<Day>.log; the plist's log keeps this wrapper's lines.
set -euo pipefail
# shellcheck source=../../../shared/connector/check-toml.sh
. "$(dirname "$0")/check-toml.sh"

main() {
  say() { printf '%s [remote-wrapper] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
  refuse() { say "refusing to start: $*"; exit 78; }

  local name
  for name in STUGA_ROOT STUGA_LOG_DIR; do
    if [ -z "${!name:-}" ]; then
      say "$name is not set; the plist must set it. Not starting."
      exit 0
    fi
  done
  config_dir_ok "$STUGA_ROOT/remote" || refuse "STUGA_ROOT is not a path the node's configs can name"

  local dir="$STUGA_ROOT/remote"
  local frpc="$STUGA_ROOT/connector/current/frpc"
  local node="$STUGA_ROOT/current/node/bin/node"
  local rotate="$STUGA_ROOT/current/bin/rotate-log.mjs"

  local relays=() file relay
  for file in "$dir"/*.toml; do
    if [ ! -e "$file" ] && [ ! -L "$file" ]; then continue; fi
    relay="$(basename "$file" .toml)"
    [[ $relay =~ ^[a-z0-9-]{1,32}$ ]] || refuse "$file does not name a relay"
    if [ -L "$file" ] || [ ! -f "$file" ]; then refuse "$file is not a plain file"; fi
    relays+=("$relay")
  done
  if [ "${#relays[@]}" -eq 0 ]; then
    say "no relay settings in $dir; nothing to run"
    exit 0
  fi
  if [ ! -x "$frpc" ]; then
    say "no connector at $frpc. Not starting."
    exit 0
  fi
  for file in "$node" "$rotate"; do
    if [ ! -e "$file" ]; then
      say "missing $file; is $STUGA_ROOT/current a runtime? Not starting."
      exit 0
    fi
  done

  # Not local: the EXIT trap runs after main has returned.
  private="$(mktemp -d "${TMPDIR:-/tmp}/stuga-remote.XXXXXX")"
  chmod 0700 "$private"
  trap 'rm -rf "$private"' EXIT

  local i
  for i in "${!relays[@]}"; do
    relay="${relays[i]}"
    # Read once: the connector starts from this copy, whatever the node writes next.
    head -c 4096 "$dir/$relay.toml" > "$private/$relay.toml"
    check_config "$private/$relay.toml" "$relay" "$dir" || refuse "$dir/$relay.toml: $reason"
  done

  # A pipe, not a FIFO: Node on macOS never sees a FIFO's end.
  exec 3> >(exec "$node" "$rotate" "$STUGA_LOG_DIR" frpc)
  local rotate_pid=$!

  # Before any connector starts: a stop that comes while they start still reaches each one.
  pids=()
  stopping=no
  # shellcheck disable=SC2329 # invoked by the trap below
  stop() {
    stopping=yes
    local pid
    # bash 3.2 calls an empty array unbound under set -u.
    for pid in ${pids[@]+"${pids[@]}"}; do kill -TERM "$pid" 2> /dev/null || true; done
  }
  trap 'say "stop requested; stopping the connectors"; stop' TERM INT

  for relay in "${relays[@]}"; do
    [ "$stopping" = no ] || break
    "$frpc" -c "$private/$relay.toml" --strict-config >&3 2>&3 &
    pids+=("$!")
    say "started the connector for $relay (pid $!), logging to $STUGA_LOG_DIR/frpc-<Day>.log"
  done
  # A stop between starting a connector and noting its pid missed that one: tell them all again.
  if [ "$stopping" = yes ]; then stop; fi

  local pid exited="" status=0
  while [ "$stopping" = no ] && [ -z "$exited" ]; do
    for pid in ${pids[@]+"${pids[@]}"}; do
      if ! kill -0 "$pid" 2> /dev/null; then exited="$pid"; break; fi
    done
    # In the background, so a signal is handled at once.
    if [ -z "$exited" ]; then sleep 1 & wait "$!" || true; fi
  done
  if [ -n "$exited" ]; then
    wait "$exited" || status=$?
    say "the connector (pid $exited) exited with status $status; stopping the others"
    stop
  fi
  # wait returns whenever a trapped signal arrives: keep waiting until each connector is gone.
  for pid in ${pids[@]+"${pids[@]}"}; do
    while kill -0 "$pid" 2> /dev/null; do wait "$pid" || true; done
  done
  # rotate-log.mjs exits once its input ends, after writing the connectors' last lines. Not a child
  # bash can wait for, so polled; launchd's ExitTimeOut stops it after that.
  exec 3>&-
  for i in $(seq 1 30); do
    kill -0 "$rotate_pid" 2> /dev/null || break
    sleep 0.1
  done
  if [ -n "$exited" ]; then exit 1; fi
  say "stopped"
  exit 0
}

# The whole script is one function called on the last line, like the other wrappers: an upgrade
# replacing this file mid-run cannot change what runs.
# shellcheck disable=SC2317 # exit is reached only if main returns
{ main "$@"; exit; }
