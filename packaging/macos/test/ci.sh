#!/usr/bin/env bash
# The macOS CI job: the integration suites against the Postgres tree the Mac runtime ships.
#
#   packaging/macos/test/ci.sh
#
# Assembles (or reuses, from $STUGA_MACOS_CACHE) the pinned Postgres tree and checks it,
# creates a throwaway socket-only cluster with init-cluster.sh, and runs
# scripts/test-integration.sh against it with that tree's pg_dump and pg_restore.
# Run after pnpm install. Without STUGA_MACOS_CACHE everything lives in a temporary directory.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
# shellcheck source=../../versions.env
. "$repo/packaging/versions.env"

[ "$(uname -m)" = arm64 ] || { echo "error: the Mac runtime is built for Apple silicon only" >&2; exit 1; }

work="$(mktemp -d)"
pgdata="$work/pgdata"
socket="$work/run"
export STUGA_MACOS_CACHE="${STUGA_MACOS_CACHE:-$work/cache}"
# shellcheck source=../build/lib/fetch.sh
. "$here/../build/lib/fetch.sh"

cleanup() {
  if [ -f "$pgdata/postmaster.pid" ]; then
    "$tree/bin/pg_ctl" -D "$pgdata" -m fast -w stop > /dev/null || true
  fi
  rm -rf "$work"
}
tree=""
trap cleanup EXIT

echo "==> Postgres tree"
tree="$(cached_postgres_tree)"
"$here/../build/check-tree.sh" "$tree"

echo "==> cluster"
"$here/../runtime/bin/init-cluster.sh" --pgbin "$tree/bin" --data "$pgdata" --socket "$socket"
# Socket-only, so the port only names the socket file. fsync is off for a cluster that is thrown
# away: with fsync_writethrough every checkpoint behind a test's DROP DATABASE takes seconds.
export PGHOST="$socket" PGPORT=55450 PGUSER=stuga
unset PGDATABASE PGPASSWORD
"$tree/bin/pg_ctl" -D "$pgdata" -l "$work/postgres.log" -o "-p $PGPORT -c fsync=off" -w -t 60 start
"$tree/bin/createdb" stuga_test

echo "==> integration suites"
export TEST_DATABASE_URL="postgres:///stuga_test" PG_BIN="$tree/bin"
cd "$repo"
bash scripts/test-integration.sh
