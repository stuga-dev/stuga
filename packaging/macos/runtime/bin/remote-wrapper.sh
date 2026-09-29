#!/bin/bash
# launchd's remote access job (dev.stuga.remote), as _stugaremote: one connector (frpc) per relay
# whose settings the node wrote into $STUGA_ROOT/remote.
#
# The node runs as _stuga, so what it wrote is never trusted. Each <relay>.toml is read once into a
# directory only this job can read, and that copy must be, byte for byte, the config the node renders
# (renderFrpcToml in services/node/src/remote/frpc-config.ts), with every value of the shape the node
# checks it has. The connector then starts from the copy, with --strict-config and never
# --allow-unsafe. So no settings open an admin interface, a visitor, another plugin or a template,
# or point the connector at files outside $STUGA_ROOT/remote.
#
# Exits 78 when a config is refused (the helper reports it and stops the job), 0 when there is
# nothing to run (retrying cannot fix it), and 1 when a connector exits, after stopping the others:
# launchd starts the job again. TERM and INT stop every connector first. The connectors' output goes
# through rotate-log.mjs into $STUGA_LOG_DIR/frpc-<Day>.log; the plist's log keeps this wrapper's lines.
set -euo pipefail

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
  # The paths in a config are compared as the node writes them: absolute, normalized, and with
  # nothing its TOML strings would escape.
  case "$STUGA_ROOT" in
    /*) ;;
    *) refuse "STUGA_ROOT is not an absolute path" ;;
  esac
  case "$STUGA_ROOT" in
    */ | *//* | */./* | */../* | */. | */.. | *[\"\\{}]* | *[[:cntrl:]]*)
      refuse "STUGA_ROOT is not a path the node's configs can name" ;;
  esac

  local dir="$STUGA_ROOT/remote"
  local frpc="$STUGA_ROOT/connector/current/frpc"
  local node="$STUGA_ROOT/current/node/bin/node"
  local rotate="$STUGA_ROOT/current/bin/rotate-log.mjs"

  local relays=() file relay
  for file in "$dir"/*.toml; do
    if [ ! -e "$file" ] && [ ! -L "$file" ]; then continue; fi
    relay="$(basename "$file" .toml)"
    printf '%s' "$relay" | grep -Eq '^[a-z0-9-]{1,32}$' || refuse "$file does not name a relay"
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

  pids=()
  for relay in "${relays[@]}"; do
    "$frpc" -c "$private/$relay.toml" --strict-config >&3 2>&3 &
    pids+=("$!")
    say "started the connector for $relay (pid $!), logging to $STUGA_LOG_DIR/frpc-<Day>.log"
  done

  stopping=no
  # shellcheck disable=SC2329 # invoked by the trap below
  stop() {
    stopping=yes
    local pid
    for pid in "${pids[@]}"; do kill -TERM "$pid" 2> /dev/null || true; done
  }
  trap 'say "stop requested; stopping the connectors"; stop' TERM INT

  local pid exited="" status=0
  while [ "$stopping" = no ] && [ -z "$exited" ]; do
    for pid in "${pids[@]}"; do
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
  for pid in "${pids[@]}"; do
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

# check_config <copy> <relay> <dir>: the copy is exactly what renderFrpcToml writes for that relay
# in that directory, with each value of the shape the node checks. Sets `reason` when it is not.
check_config() {
  local copy="$1" relay="$2" dir="$3"
  local label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
  local node_id='[0-9bcdfghjkmnpqrstvwxz]{6,12}'
  local dns_re="^$label(\\.$label)*\$" id_re="^$node_id\$" host_re="^$node_id(\\.$label)+\$"
  local port_re='^[1-9][0-9]{0,4}$' level_re='^(info|warn)$'
  local addr port server id host level
  # value <sed pattern>: the first match's \1, or nothing. Every line is compared below.
  value() { sed -n "/^$1\$/{s//\\1/p;q;}" "$copy"; }
  addr="$(value 'serverAddr = "\(.*\)"')"
  port="$(value 'serverPort = \(.*\)')"
  server="$(value 'transport\.tls\.serverName = "\(.*\)"')"
  level="$(value 'log\.level = "\(.*\)"')"
  id="$(value 'name = "\(.*\)"')"
  host="$(value 'customDomains = \["\(.*\)"\]')"

  reason="serverAddr is not a host name"
  [[ $addr =~ $dns_re ]] || return 1
  reason="serverPort is not a port"
  [[ $port =~ $port_re ]] && [ "$port" -le 65535 ] || return 1
  reason="transport.tls.serverName is not a host name"
  [[ $server =~ $dns_re ]] || return 1
  reason="log.level is neither info nor warn"
  [[ $level =~ $level_re ]] || return 1
  reason="the proxy's name is not a node id"
  [[ $id =~ $id_re ]] || return 1
  reason="customDomains is not the node's own host name"
  [[ $host =~ $host_re ]] && [ "${host%%.*}" = "$id" ] || return 1

  cat > "$copy.expected" << EOF
# Written by Stuga. Changes are overwritten.
serverAddr = "$addr"
serverPort = $port
loginFailExit = false
auth.method = "oidc"
auth.additionalScopes = ["HeartBeats"]
auth.oidc.tokenSource.type = "file"
auth.oidc.tokenSource.file.path = "$dir/$relay.jwt"
transport.tls.enable = true
transport.tls.trustedCaFile = "$dir/$relay.ca.pem"
transport.tls.serverName = "$server"
transport.heartbeatInterval = 30
transport.heartbeatTimeout = 90
transport.poolCount = 2
log.to = "console"
log.level = "$level"

[[proxies]]
name = "$id"
type = "https"
customDomains = ["$host"]
transport.proxyProtocolVersion = "v2"
[proxies.plugin]
type = "unix_domain_socket"
unixPath = "$dir/https.sock"
EOF
  local differ
  if ! differ="$(cmp "$copy.expected" "$copy" 2>&1)"; then
    # Where, never what: the line may hold anything.
    case "$differ" in
      *", line "*) reason="it is not the config the node writes (${differ##*, })" ;;
      *) reason="it is not the config the node writes (a line is missing or extra)" ;;
    esac
    return 1
  fi
  rm -f "$copy.expected"
}

# The whole script is one function called on the last line, like the other wrappers: an upgrade
# replacing this file mid-run cannot change what runs.
# shellcheck disable=SC2317 # exit is reached only if main returns
{ main "$@"; exit; }
