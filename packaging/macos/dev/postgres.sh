#!/usr/bin/env bash
# A development Postgres from the pinned Mac tree, for `pnpm dev`.
#
#   packaging/macos/dev/postgres.sh start|stop|reset [--dir <dir>]
#
# The cluster lives in <dir> (default data/dev-postgres in this checkout) and listens only on
# its socket directory, as port 55433. start prints the DATABASE_URL for
# services/node/.env.dev; reset deletes the cluster and starts a new one. The tree is
# assembled into $STUGA_MACOS_CACHE on first use.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
# shellcheck source=../../versions.env
. "$repo/packaging/versions.env"
# shellcheck source=../build/lib/fetch.sh
. "$here/../build/lib/fetch.sh"
# shellcheck source=../build/lib/uri.sh
. "$here/../build/lib/uri.sh"

usage() { echo "usage: $0 start|stop|reset [--dir <dir>]" >&2; exit 2; }

command="${1:-}"
[ $# -gt 0 ] && shift
dir="$repo/data/dev-postgres"
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="${2:-}"; [ -n "$dir" ] || usage; shift 2 ;;
    *) usage ;;
  esac
done
port=55433
mkdir -p "$dir"
dir="$(cd "$dir" && pwd)"
pgdata="$dir/pgdata"
socket="$dir/run"

running() { [ -f "$pgdata/postmaster.pid" ] && "$1/pg_ctl" -D "$pgdata" status > /dev/null 2>&1; }

start() {
  local tree
  tree="$(cached_postgres_tree)"
  "$here/../runtime/bin/init-cluster.sh" --pgbin "$tree/bin" --data "$pgdata" --socket "$socket"
  if ! running "$tree/bin"; then
    "$tree/bin/pg_ctl" -D "$pgdata" -l "$dir/postgres.log" -o "-p $port" -w -t 60 start
  fi
  echo "Postgres is running on $socket (port $port). In services/node/.env.dev:"
  echo "DATABASE_URL=postgres:///stuga?host=$(uri_path "$socket")&port=$port&user=stuga"
}

stop() {
  local tree
  tree="$(cached_postgres_tree)"
  if running "$tree/bin"; then
    "$tree/bin/pg_ctl" -D "$pgdata" -m fast -w stop
  else
    echo "Postgres is not running in $dir"
  fi
}

case "$command" in
  start) start ;;
  stop) stop ;;
  reset)
    stop
    rm -rf "$pgdata" "$socket" "$dir/postgres.log"
    start
    ;;
  *) usage ;;
esac
