#!/usr/bin/env bash
# Boot a built runtime the way launchd would, against a throwaway cluster, and check it.
#
#   packaging/macos/test/smoke.sh <runtime-dir>
#
# Makes a temporary root whose `current` links to <runtime-dir>, runs init-cluster.sh with
# launchd's PATH, renders agent plists, and starts each job as launchd would (lib/jobs.sh).
# Then: /ready answers 200, / serves the SPA, the boot line names the expected version
# (app/VERSION, or 0.0.0-dev for a linked checkout), the node stops cleanly on SIGTERM,
# stuga-node backup and verify succeed with the runtime's pg_dump, and Postgres stops cleanly
# on SIGTERM. Nothing is loaded into launchd.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/jobs.sh
. "$here/lib/jobs.sh"
[ $# -eq 1 ] || { echo "usage: $0 <runtime-dir>" >&2; exit 2; }
runtime="$(cd "$1" && pwd -P)"
node="$runtime/node/bin/node"
for need in "$node" "$runtime/postgres/bin/postgres" "$runtime/bin/init-cluster.sh" "$runtime/app/services/node/bin/stuga-node.js"; do
  [ -e "$need" ] || { echo "error: $runtime is not a runtime (no $need)" >&2; exit 2; }
done
if [ -L "$runtime/app" ]; then
  expected_version=0.0.0-dev
else
  expected_version="$(cat "$runtime/app/VERSION")"
  [ "$expected_version" = "$(basename "$runtime")" ] \
    || { echo "FAIL app/VERSION says $expected_version in runtime $(basename "$runtime")" >&2; exit 1; }
fi

# Short on purpose: the socket path must fit a unix socket address.
work="$(mktemp -d)"
root="$work/r"
logs="$work/logs"
mkdir -p "$root/data" "$logs"
ln -s "$runtime" "$root/current"
node_pid="" postgres_pid=""

fail() {
  echo "FAIL $*" >&2
  for log in "$logs"/*.log "$root/data/pgdata/log"/*.log; do
    [ -f "$log" ] && { echo "---- $log" >&2; tail -40 "$log" >&2; }
  done
  exit 1
}

cleanup() {
  if [ -n "$node_pid" ] && kill -0 "$node_pid" 2>/dev/null; then kill -TERM "$node_pid" 2>/dev/null || true; wait "$node_pid" 2>/dev/null || true; fi
  if [ -n "$postgres_pid" ] && kill -0 "$postgres_pid" 2>/dev/null; then kill -TERM "$postgres_pid" 2>/dev/null || true; wait "$postgres_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

echo "==> cluster"
env -i PATH="$LAUNCHD_PATH" HOME="$work" "$root/current/bin/init-cluster.sh" --pgbin "$root/current/postgres/bin" --data "$root/data/pgdata" --socket "$root/data/run" > "$logs/init-cluster.log" 2>&1 \
  || fail "init-cluster.sh"

port="$(free_port)"
origin="http://127.0.0.1:$port"
"$here/../build/render-launchd.sh" --mode agent --out "$work/launchd" --root "$root" --logs "$logs" \
  --public-origin "$origin" --port "$port" > /dev/null

echo "==> start postgres and node"
job_env "$work/launchd/dev.stuga.local.postgres.plist"
(cd "$root/data" && umask 077 && exec "${job[@]}") >> "$logs/postgres.log" 2>&1 &
postgres_pid=$!
job_env "$work/launchd/dev.stuga.local.node.plist"
(cd "$root/data" && umask 077 && exec "${job[@]}") >> "$logs/node-wrapper.log" 2>&1 &
node_pid=$!

ready=no
for _ in $(seq 1 240); do
  kill -0 "$node_pid" 2>/dev/null || fail "the node job exited before /ready answered"
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$origin/ready" || true)" = 200 ]; then ready=yes; break; fi
  sleep 1
done
[ "$ready" = yes ] || fail "/ready did not answer 200 within 240 s"
echo "ok  /ready 200"

curl -fsS "$origin/" | grep -q 'id="root"' || fail "/ does not serve the SPA"
echo "ok  / serves the SPA"

grep -hqF "[node] stuga $expected_version," "$logs"/node-*.log || fail "no boot line naming stuga $expected_version in $logs/node-<Day>.log"
echo "ok  boot line names stuga $expected_version"

echo "==> stop the node"
kill -TERM "$node_pid"
status=0
wait "$node_pid" || status=$?
node_pid=""
[ "$status" -eq 0 ] || fail "the node exited with status $status after SIGTERM"
echo "ok  node stopped with status 0"

echo "==> backup and verify"
cli_env "$work/launchd/dev.stuga.local.node.plist"
backup="$(cd "$root/data" && "${cli[@]}" backup --json 2>> "$logs/backup.log")" || fail "stuga-node backup"
name="$(printf '%s' "$backup" | "$node" -e 'const r = JSON.parse(require("node:fs").readFileSync(0, "utf8")); console.log(r.ok ? r.path : "")')"
[ -n "$name" ] || fail "stuga-node backup --json named no backup: $backup"
(cd "$root/data" && "${cli[@]}" verify "$name" --json >> "$logs/backup.log" 2>&1) || fail "stuga-node verify $name"
echo "ok  backup and verify"

echo "==> stop postgres"
kill -TERM "$postgres_pid"
status=0
wait "$postgres_pid" || status=$?
postgres_pid=""
[ "$status" -eq 0 ] || fail "Postgres exited with status $status after SIGTERM"
[ ! -f "$root/data/pgdata/postmaster.pid" ] || fail "Postgres left postmaster.pid behind"
grep -q "fast shutdown request" "$root/data/pgdata/log"/*.log || fail "Postgres did not receive a fast shutdown"
echo "ok  Postgres stopped with a fast shutdown"

echo "smoke passed: $runtime"
