#!/usr/bin/env bash
# The restore drill on a built Mac runtime: packaging/test/drill-content.sh against the runtime's
# Postgres and node jobs, run as launchd would run them (lib/jobs.sh) in a throwaway root, with
# stuga-node's own backup, verify, restore and list. Nothing is loaded into launchd.
#
#   packaging/macos/test/restore-drill.sh <runtime-dir>
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
# shellcheck source=lib/jobs.sh
. "$here/lib/jobs.sh"

usage() { echo "usage: $0 <runtime-dir>" >&2; exit 2; }

# layout: the throwaway root under $work, shared by the drill and the hooks it runs.
layout() {
  root="$work/r"
  logs="$work/logs"
  launchd="$work/launchd"
  socket="$root/data/run"
}

# start_job postgres|node: detached, so a hook can start a job that outlives it.
start_job() {
  job_env "$launchd/dev.stuga.local.$1.plist"
  (cd "$root/data" && umask 077 && exec "${job[@]}") < /dev/null >> "$logs/$1-job.log" 2>&1 &
  echo $! > "$work/$1.pid"
}

# stop_job postgres|node: SIGTERM, as launchd stops a job, then wait for it to exit.
stop_job() {
  local pid
  [ -f "$work/$1.pid" ] || return 0
  pid="$(cat "$work/$1.pid")"
  rm -f "$work/$1.pid"
  kill -TERM "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 120); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  echo "the $1 job did not exit within 60 s of SIGTERM" >&2
  return 1
}

stuga_node() {
  cli_env "$launchd/dev.stuga.local.node.plist"
  (cd "$root/data" && "${cli[@]}" "$@")
}

init_cluster() {
  env -i PATH="$LAUNCHD_PATH" HOME="$work" "$root/current/bin/init-cluster.sh" \
    --pgbin "$root/current/postgres/bin" --data "$root/data/pgdata" --socket "$socket"
}

if [ "${1:-}" = --hook ]; then
  runtime="$DRILL_RUNTIME"
  work="$DRILL_WORK"
  layout
  case "${2:-}" in
    # The writer lock keeps a backup from running beside the node.
    backup) stop_job node; stuga_node backup; start_job node ;;
    verify) stuga_node verify "$DRILL_BACKUP" ;;
    stop) stop_job node ;;
    wipe)
      stop_job postgres
      rm -rf "$root/data/pgdata"
      init_cluster
      start_job postgres
      for _ in $(seq 1 60); do
        "$runtime/postgres/bin/pg_isready" -q -h "$socket" && break
        sleep 0.5
      done
      find "$root/data/node" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
      [ -z "$(ls -A "$root/data/node")" ] || { echo "the data directory is not empty" >&2; exit 1; }
      [ "$("$runtime/postgres/bin/psql" -h "$socket" -U stuga -d stuga -tAc "SELECT to_regclass('public.docs') IS NULL")" = t ] \
        || { echo "the new cluster is not empty" >&2; exit 1; }
      ;;
    restore) stuga_node restore "$DRILL_BACKUP" --yes ;;
    start) start_job node ;;
    list) stuga_node list ;;
    *) echo "unknown hook ${2:-}" >&2; exit 2 ;;
  esac
  exit 0
fi

[ $# -eq 1 ] || usage
runtime="$(cd "$1" && pwd -P)"
for need in "$runtime/node/bin/node" "$runtime/postgres/bin/postgres" "$runtime/bin/init-cluster.sh" "$runtime/app/services/node/bin/stuga-node.js"; do
  [ -e "$need" ] || { echo "error: $runtime is not a runtime (no $need)" >&2; exit 2; }
done

# Short on purpose: the socket path must fit a unix socket address.
work="$(mktemp -d)"
layout
export DRILL_RUNTIME="$runtime" DRILL_WORK="$work"

cleanup() {
  local code=$? log
  stop_job node || true
  stop_job postgres || true
  if [ "$code" -ne 0 ]; then
    for log in "$logs"/*.log "$root/data/pgdata/log"/*.log; do
      [ -f "$log" ] && { echo "---- $log" >&2; tail -40 "$log" >&2; }
    done
  fi
  rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$root/data" "$logs"
ln -s "$runtime" "$root/current"
init_cluster > "$logs/init-cluster.log" 2>&1

port="$(free_port)"
origin="http://127.0.0.1:$port"
"$here/../build/render-launchd.sh" --mode agent --out "$launchd" --root "$root" --logs "$logs" \
  --public-origin "$origin" --port "$port" > /dev/null

start_job postgres
start_job node

hook() { printf 'bash %q --hook %s' "$here/restore-drill.sh" "$1"; }
bash "$repo/packaging/test/drill-content.sh" --url "$origin" \
  --setup-code "cat $(printf %q "$root/data/node/setup-code")" \
  --backup "$(hook backup)" \
  --verify "$(hook verify)" \
  --stop "$(hook stop)" \
  --wipe "$(hook wipe)" \
  --restore "$(hook restore)" \
  --start "$(hook start)" \
  --list "$(hook list)"
