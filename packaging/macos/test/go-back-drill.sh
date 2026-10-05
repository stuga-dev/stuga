#!/usr/bin/env bash
# Going back, on a built Mac runtime run as launchd would run it (lib/jobs.sh) in a throwaway root:
# two copies of it, 9.0.0 and 9.0.1. 9.0.0 serves; 9.0.1 backs its data up, then upgrades it; 9.0.0
# started again refuses the data, changes nothing and keeps running until it is stopped; the hold mark
# keeps the node from starting; and 9.0.0's own stuga-node restores the backup taken before the
# upgrade. bin/stuga's root steps (the package, the installer, launchd) are restore.test.mjs's.
# Nothing is loaded into launchd.
#
#   packaging/macos/test/go-back-drill.sh <runtime-dir>
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/jobs.sh
. "$here/lib/jobs.sh"

[ $# -eq 1 ] || { echo "usage: $0 <runtime-dir>" >&2; exit 2; }
built="$(cd "$1" && pwd -P)"
for need in "$built/node/bin/node" "$built/postgres/bin/postgres" "$built/bin/init-cluster.sh" "$built/bin/hold.sh" "$built/app/services/node/bin/stuga-node.js"; do
  [ -e "$need" ] || { echo "error: $built is not a runtime (no $need)" >&2; exit 2; }
done
[ ! -L "$built/app" ] || { echo "error: $built links its app tree; the drill writes each copy's app/VERSION" >&2; exit 2; }

# Short on purpose: the socket path must fit a unix socket address.
work="$(mktemp -d)"
root="$work/r"
logs="$work/logs"
launchd="$work/launchd"
socket="$root/data/run"
node_pid="" postgres_pid=""

fail() {
  local log
  echo "FAIL $*" >&2
  for log in "$logs"/*.log "$root/data/pgdata/log"/*.log; do
    [ -f "$log" ] && { echo "---- $log" >&2; tail -40 "$log" >&2; }
  done
  exit 1
}
ok() { echo "ok  $*"; }

cleanup() {
  local pid
  for pid in "$node_pid" "$postgres_pid"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then
      kill -TERM "$pid" 2> /dev/null || true
      wait "$pid" 2> /dev/null || true
    fi
  done
  rm -rf "$work"
}
trap cleanup EXIT

# use <version>: `current` names that copy, as its package leaves it.
use() {
  ln -sfn "runtime/$1" "$root/current"
  runtime="$root/runtime/$1"
}

# start_job postgres|node: as launchd would, in the background.
start_job() {
  job_env "$launchd/dev.stuga.local.$1.plist"
  (cd "$root/data" && umask 077 && exec "${job[@]}") < /dev/null >> "$logs/$1-job.log" 2>&1 &
  if [ "$1" = node ]; then node_pid=$!; else postgres_pid=$!; fi
}

# stop_node: SIGTERM, as launchd stops it; its exit status.
stop_node() {
  local status=0
  kill -TERM "$node_pid"
  wait "$node_pid" || status=$?
  node_pid=""
  return "$status"
}

# ready: /ready's code; its body in $work/ready.json.
ready() { curl -s --max-time 5 -o "$work/ready.json" -w '%{http_code}' "$origin/ready" || true; }

wait_ready() {
  local i
  for i in $(seq 1 "$1"); do
    kill -0 "$node_pid" 2> /dev/null || fail "the node job exited before /ready answered 200"
    [ "$(ready)" != 200 ] || return 0
    [ "$i" -eq "$1" ] || sleep 1
  done
  fail "/ready did not answer 200 within $1 s"
}

# field <key>: a string field of the JSON on stdin.
field() {
  # shellcheck disable=SC2016 # JavaScript, not shell
  "$built/node/bin/node" -e 'let v; try { v = JSON.parse(require("node:fs").readFileSync(0, "utf8"))[process.argv[1]]; } catch {} process.stdout.write(typeof v === "string" ? v : "")' "$1"
}

api() { # api METHOD PATH [json body]: with the drill's token once it has one
  local args=(-sS -X "$1" "$origin$2" -H 'content-type: application/json')
  [ -z "${token:-}" ] || args+=(-H "authorization: Bearer $token")
  [ -z "${3:-}" ] || args+=(-d "$3")
  curl "${args[@]}"
}

psql_value() { "$built/postgres/bin/psql" -h "$socket" -U stuga -d stuga -tAc "$1"; }
backups() { find "$root/data/backups" -mindepth 1 -maxdepth 1 -type d ! -name '*.partial' 2> /dev/null | wc -l | tr -d ' '; }
# node_log: the node's own log, one file per UTC weekday (rotate-log.mjs), oldest first, in
# $work/node.log.
node_log() {
  local file
  : > "$work/node.log"
  # shellcheck disable=SC2012 # rotate-log's names, ordered by when each was written
  ls -tr "$logs"/node-[MTWFS][a-z][a-z].log 2> /dev/null | while IFS= read -r file; do cat "$file" >> "$work/node.log"; done
}

echo "==> two copies of $built: 9.0.0 and 9.0.1"
mkdir -p "$root/runtime" "$root/data" "$logs"
for version in 9.0.0 9.0.1; do
  ditto "$built" "$root/runtime/$version"
  printf '%s\n' "$version" > "$root/runtime/$version/app/VERSION"
  rm -f "$root/runtime/$version/app/RELEASED"
done
use 9.0.0
env -i PATH="$LAUNCHD_PATH" HOME="$work" "$root/current/bin/init-cluster.sh" --pgbin "$root/current/postgres/bin" \
  --data "$root/data/pgdata" --socket "$socket" > "$logs/init-cluster.log" 2>&1 || fail "init-cluster.sh"
port="$(free_port)"
origin="http://127.0.0.1:$port"
"$here/../build/render-launchd.sh" --mode agent --out "$launchd" --root "$root" --logs "$logs" \
  --public-origin "$origin" --port "$port" > /dev/null

echo "==> 9.0.0: a new node, set up, with document A"
start_job postgres
start_job node
wait_ready 240
token="$(api POST /auth/register "{\"username\":\"drill\",\"password\":\"correct horse battery\",\"name\":\"Drill\",\"setup_code\":\"$(tr -d '[:space:]' < "$root/data/node/setup-code")\"}" | field access_token)"
[ -n "$token" ] || fail "could not register the first account"
[ -n "$(api POST /api/workspaces '{"name":"Drill Workspace"}' | field workspace_id)" ] || fail "could not create a workspace"
doc_a="$(api POST /api/docs '{"title":"Document A","markdown":"# Document A"}' | field doc_id)"
[ -n "$doc_a" ] || fail "could not create document A"
stop_node || fail "9.0.0 exited with status $? after SIGTERM"
ok "9.0.0 served, and holds document A"

echo "==> 9.0.1: backs up 9.0.0's data, then upgrades it; document B"
use 9.0.1
start_job node
wait_ready 240
backup=""
for manifest in "$root/data/backups"/*/MANIFEST.json; do
  [ -f "$manifest" ] || continue
  # shellcheck disable=SC2016 # JavaScript, not shell
  if [ "$("$built/node/bin/node" -e 'const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log(`${m.stuga_version} ${m.runtime_version}`)' "$manifest")" = "9.0.0 9.0.1" ]; then
    backup="$(dirname "$manifest")"
  fi
done
[ -n "$backup" ] || fail "9.0.1 took no backup of 9.0.0's data before upgrading it"
doc_b="$(api POST /api/docs '{"title":"Document B","markdown":"# Document B"}' | field doc_id)"
[ -n "$doc_b" ] || fail "could not create document B"
stop_node || fail "9.0.1 exited with status $? after SIGTERM"
[ "$(psql_value "SELECT app_version FROM node_state")" = 9.0.1 ] || fail "9.0.1 did not record itself on the data"
kept="$(backups)"
ok "9.0.1 backed up $(basename "$backup") first, and holds document B"

echo "==> 9.0.0 again: refuses the data 9.0.1 served, changes nothing, and stays up"
use 9.0.0
start_job node
refused=no
for _ in $(seq 1 240); do
  kill -0 "$node_pid" 2> /dev/null || fail "the refusing node exited; it should stay up"
  if [ "$(ready)" = 503 ] && [ "$(field status < "$work/ready.json")" = refused ]; then refused=yes; break; fi
  sleep 1
done
[ "$refused" = yes ] || fail "/ready never answered 503 refused"
sleep 5
kill -0 "$node_pid" 2> /dev/null || fail "the refusing node exited"
node_log
grep -qF "[node] refusing this database: Stuga 9.0.1 served it last" "$work/node.log" ||
  fail "the node's log does not say why it refuses"
[ "$(backups)" = "$kept" ] || fail "the refusing node took a backup"
[ "$(psql_value "SELECT app_version FROM node_state")" = 9.0.1 ] || fail "the refusing node recorded itself on the data"
stop_node || fail "the refusing node exited with status $? after SIGTERM"
ok "/ready says refused, the log says why, nothing was backed up or recorded, and SIGTERM exits 0"

echo "==> the hold mark keeps the node from starting"
mkdir -p "$root/status"
# shellcheck source=../runtime/bin/hold.sh
. "$runtime/bin/hold.sh"
printf '%s\n%s\n' "$$" "$(process_started $$)" > "$root/status/restoring"
start_job node
for _ in $(seq 1 30); do
  kill -0 "$node_pid" 2> /dev/null || break
  sleep 1
done
kill -0 "$node_pid" 2> /dev/null && fail "the node job started under the hold mark"
status=0
wait "$node_pid" || status=$?
node_pid=""
[ "$status" -eq 0 ] || fail "the node job exited with status $status under the hold mark; launchd would start it again"
grep -q "a restore is under way; not starting" "$logs/node-job.log" || fail "the wrapper did not say why it did not start"
ok "the node job exits 0 at once while the mark holds"

echo "==> 9.0.0's stuga-node restores what 9.0.1 backed up first"
cli_env "$launchd/dev.stuga.local.node.plist"
(cd "$root/data" && "${cli[@]}" restore "$backup" --yes) >> "$logs/restore.log" 2>&1 || fail "stuga-node restore"
rm -f "$root/status/restoring"
start_job node
wait_ready 300
node_log
grep '^\[node\] stuga ' "$work/node.log" | tail -1 | grep -Eq '^\[node\] stuga 9\.0\.0, schema [0-9]+$' ||
  fail "the last boot line is not 9.0.0's own, with nothing changed"
[ "$(api GET "/api/docs/$doc_a" | field title)" = "Document A" ] || fail "document A is gone"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $token" "$origin/api/docs/$doc_b")" != 200 ] ||
  fail "document B, made after the backup, is still there"
(cd "$root/data" && "${cli[@]}" list) > "$logs/list.log" 2>&1 || fail "stuga-node list"
for half in "replaced data directory" "replaced database"; do
  grep -q "$half" "$logs/list.log" || fail "list does not name the $half"
done
[ "$(backups)" = "$kept" ] || fail "a backup was taken after going back"
[ "$(psql_value "SELECT app_version FROM node_state")" = 9.0.0 ] || fail "9.0.0 does not serve the restored data"
ok "9.0.0 serves document A without B, keeps what it replaced, and took no backup"

echo "go-back drill passed: $built"
