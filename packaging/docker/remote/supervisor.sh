#!/bin/bash
# The stuga-remote container: the remote access connector (frpc), one per relay, as the node asks.
#
#   $STUGA_REMOTE_DIR/control/request      written by the node: one line, `on <config sha-256>` or `off`
#   $STUGA_REMOTE_DIR/status/status.json   written here: {"state","message","at","connector_sha","config_sha"}
#
# The Mac helper's protocol: the request is what the node wants now, and stays. Every few seconds
# this compares it with what runs and brings the two together, so a start that failed is made good
# by a later one. `on` reads each <relay>.toml once into a private copy, which must pass the Mac's
# own check (check-toml.sh, beside this script), and starts frpc from the copy with --strict-config,
# never --allow-unsafe. The connectors restart only when the config sha changes, never for a new
# credential. `off` stops them. A connector that exits stops the others, and they start again after
# a pause. A request that is not a plain file of one such line is refused.
#
#   supervisor.sh          run (the image's command)
#   supervisor.sh health   exit 0 while the loop's heartbeat in $TMPDIR is fresh (the health check)
#
# Runs as 65532, which can write only status/ in the volume, and its own /tmp.
set -euo pipefail

# shellcheck source=../../shared/connector/check-toml.sh
. "$(dirname "$0")/check-toml.sh"

dir="${STUGA_REMOTE_DIR:-/run/stuga-remote}"
frpc="${STUGA_FRPC:-/usr/local/bin/frpc}"
tmp="${TMPDIR:-/tmp}"
heartbeat="$tmp/stuga-remote.alive"
# Seconds: between looks at the request; a start that stays up this long is running; after a
# connector exits, before they start again.
poll="${STUGA_REMOTE_POLL:-2}"
settle="${STUGA_REMOTE_SETTLE:-5}"
pause="${STUGA_REMOTE_PAUSE:-10}"

say() { printf '%s [supervisor] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
now() { date +%s; }

# mtime <file>: its modification time in seconds, GNU stat or BSD.
mtime() { stat -c %Y "$1" 2> /dev/null || stat -f %m "$1" 2> /dev/null; }

health() {
  local at
  at="$(mtime "$heartbeat")" || exit 1
  [ $(($(now) - at)) -lt 30 ]
}

# ---- the request and the status

request="$dir/control/request"
status_dir="$dir/status"

# read_request: `on <sha>`, `off`, `invalid`, `unreadable` when this user may not read it, or
# `none` when the node has asked nothing.
read_request() {
  local line
  if [ ! -e "$request" ] && [ ! -L "$request" ]; then echo none; return; fi
  if [ -L "$request" ] || [ ! -f "$request" ]; then echo invalid; return; fi
  if ! line="$(head -c 80 "$request" 2> /dev/null)"; then echo unreadable; return; fi
  line="$(printf '%s\n' "$line" | head -1)"
  if printf '%s' "$line" | grep -Eq '^(on [0-9a-f]{64}|off)$'; then echo "$line"; else echo invalid; fi
}

# request_seen: its inode, time and size. The node renames each write into place, so a request
# written again, even the same line, is seen as new.
request_seen() {
  stat -c '%i %Y %s' "$request" 2> /dev/null || stat -f '%i %m %z' "$request" 2> /dev/null || true
}

# json_text <text>: safe between JSON quotes.
json_text() {
  printf '%s' "$1" | tr -d '\\"' | tr '\n\t' '  ' | tr -d '[:cntrl:]'
}

status_failing=""
# write_status <state> <message> [config sha]: a new file renamed into place. Where status/ is not
# ready yet, said once, and the next change writes it.
write_status() {
  local connector="null" config="null" tmpfile
  if [ -n "${3:-}" ]; then
    config="\"$3\""
    if [ -n "$connector_sha" ]; then connector="\"$connector_sha\""; fi
  fi
  if tmpfile="$(mktemp "$status_dir/.status.json.XXXXXX" 2> /dev/null)" &&
    printf '{"state":"%s","message":"%s","at":"%s","connector_sha":%s,"config_sha":%s}\n' \
      "$1" "$(json_text "$2")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$connector" "$config" > "$tmpfile" &&
    chmod 0640 "$tmpfile" && mv -f "$tmpfile" "$status_dir/status.json"; then
    status_failing=""
    written="$1 ${3:-}"
    say "$1: $2"
    return 0
  fi
  if [ -n "${tmpfile:-}" ]; then rm -f "$tmpfile"; fi
  if [ "$status_failing" != "$1" ]; then say "could not write $status_dir/status.json ($1: $2)"; fi
  status_failing="$1"
  written=""
}

# ---- the connectors

pids=()
private=""
# The config sha the connectors run, when they are started; since when; whether reported running.
running_sha="" started_at=0 confirmed=no

# stop_connectors: each sent TERM, and KILL after 5 s; the private copies go.
stop_connectors() {
  local pid
  for pid in ${pids[@]+"${pids[@]}"}; do kill -TERM "$pid" 2> /dev/null || true; done
  for _ in $(seq 1 50); do
    any_running || break
    sleep 0.1
  done
  for pid in ${pids[@]+"${pids[@]}"}; do
    kill -KILL "$pid" 2> /dev/null || true
    wait "$pid" 2> /dev/null || true
  done
  pids=()
  if [ -n "$private" ]; then rm -rf "$private"; fi
  private="" running_sha="" confirmed=no
}

any_running() {
  local pid
  for pid in ${pids[@]+"${pids[@]}"}; do
    if kill -0 "$pid" 2> /dev/null; then return 0; fi
  done
  return 1
}

# connector_exited: whether one has, its status reaped into `code`. Not in a subshell: only this
# shell can wait for its children.
connector_exited() {
  local pid
  code=0
  for pid in ${pids[@]+"${pids[@]}"}; do
    if ! kill -0 "$pid" 2> /dev/null; then
      wait "$pid" 2> /dev/null || code=$?
      return 0
    fi
  done
  return 1
}

# start_connectors <config sha>: one frpc per relay from checked copies, or a status saying why not.
start_connectors() {
  local sha="$1" file relay relays=()
  if [ ! -x "$frpc" ]; then
    write_status unavailable "this image carries no connector" "$sha"
    return
  fi
  for file in "$dir"/*.toml; do
    if [ ! -e "$file" ] && [ ! -L "$file" ]; then continue; fi
    relay="$(basename "$file" .toml)"
    if ! [[ $relay =~ ^[a-z0-9-]{1,32}$ ]]; then
      write_status refused "$(basename "$file") does not name a relay" "$sha"
      return
    fi
    if [ -L "$file" ] || [ ! -f "$file" ]; then
      write_status refused "$relay.toml is not a plain file" "$sha"
      return
    fi
    relays+=("$relay")
  done
  if [ "${#relays[@]}" -eq 0 ]; then
    write_status failed "there are no relay settings to run" "$sha"
    return
  fi

  private="$(mktemp -d "$tmp/connector.XXXXXX")"
  chmod 0700 "$private"
  for relay in "${relays[@]}"; do
    # Read once: the connector starts from this copy, whatever the node writes next.
    head -c 4096 "$dir/$relay.toml" > "$private/$relay.toml"
    if ! check_config "$private/$relay.toml" "$relay" "$dir"; then
      rm -rf "$private"
      private=""
      write_status refused "$relay.toml is not the config the node writes: $reason" "$sha"
      return
    fi
  done
  for relay in "${relays[@]}"; do
    "$frpc" -c "$private/$relay.toml" --strict-config &
    pids+=("$!")
    say "started the connector for $relay (pid $!)"
  done
  running_sha="$sha" started_at="$(now)" confirmed=no
}

# ---- the loop

# The request last looked at; the status last written; the request a start failed for, which waits
# for a new one; when a connector last exited.
seen="" written="" waiting_for="" exited_at=0

reconcile() {
  local wanted current changed=no
  wanted="$(read_request)"
  current="$(request_seen)"
  if [ "$current" != "$seen" ]; then changed=yes; fi
  seen="$current"

  if connector_exited; then
    local sha="$running_sha"
    say "a connector exited with status $code; stopping the others"
    stop_connectors
    write_status failed "the connector exited with status $code" "$sha"
    exited_at="$(now)"
  fi

  case "$wanted" in
    none)
      # Nothing asked, or the volume is not laid out yet.
      if [ "${#pids[@]}" -gt 0 ]; then stop_connectors; fi
      ;;
    off | invalid | unreadable)
      if [ "${#pids[@]}" -gt 0 ]; then stop_connectors; fi
      case "$wanted" in
        off) if [ "$changed" = yes ] || [ "$written" != "stopped " ]; then write_status stopped "remote access is off"; fi ;;
        invalid) if [ "$changed" = yes ] || [ "$written" != "refused " ]; then write_status refused "the request is neither on nor off"; fi ;;
        # The volume's group is wrong: the node lays it out again when it starts.
        *) if [ "$changed" = yes ] || [ "$written" != "failed " ]; then write_status failed "the request is not readable by the connector's group"; fi ;;
      esac
      ;;
    on\ *)
      local sha="${wanted#on }"
      if [ "$running_sha" = "$sha" ]; then
        if [ "$confirmed" = no ] && [ $(($(now) - started_at)) -ge "$settle" ]; then
          confirmed=yes
          write_status running "the connector is running" "$sha"
        elif [ "$confirmed" = yes ] && { [ "$changed" = yes ] || [ "$written" != "running $sha" ]; }; then
          write_status running "the connector is running" "$sha"
        fi
        return
      fi
      # A start that failed waits for the node to ask again; one that exited, for a pause.
      if [ "$changed" = no ] && [ "$waiting_for" = "$seen" ]; then return; fi
      if [ "$changed" = no ] && [ $(($(now) - exited_at)) -lt "$pause" ]; then return; fi
      if [ "${#pids[@]}" -gt 0 ]; then
        say "the connector's settings changed; restarting it"
        stop_connectors
      fi
      start_connectors "$sha"
      if [ -z "$running_sha" ]; then waiting_for="$seen"; else waiting_for=""; fi
      ;;
  esac
}

main() {
  if [ "${1:-}" = health ]; then health; exit; fi
  if ! config_dir_ok "$dir"; then
    say "STUGA_REMOTE_DIR is not a path the node's configs can name: $dir. Not starting."
    exit 78
  fi
  connector_sha=""
  if [ -x "$frpc" ]; then
    connector_sha="$({ sha256sum "$frpc" 2> /dev/null || shasum -a 256 "$frpc"; } | cut -d' ' -f1)"
  fi
  stopping=no
  trap 'stopping=yes' TERM INT
  say "watching $request"
  while [ "$stopping" = no ]; do
    touch "$heartbeat"
    reconcile
    # In the background, so a signal is handled at once.
    if [ "$stopping" = no ]; then sleep "$poll" & wait "$!" || true; fi
  done
  say "stop requested"
  stop_connectors
  exit 0
}

main "$@"
