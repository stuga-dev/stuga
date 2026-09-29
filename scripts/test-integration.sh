#!/usr/bin/env bash
# The integration suites: every *.integration.test.ts file in @stuga/db (migrations, schema snapshot,
# queries, job queue), then in the node, one package after the other because they share one database.
# The unit files beside them run in `pnpm test`, not here.
#
#   TEST_DATABASE_URL=postgres:///stuga_test scripts/test-integration.sh    a Postgres you run
#   scripts/test-integration.sh                                             packaging/docker/test/compose.postgres.yml
#
# The database needs pgvector and a preloaded pg_search. The backup suite runs pg_dump and pg_restore
# of the server's major from PG_BIN, or from PATH. The published samples' suite builds each sample
# from SAMPLES_DIR, a checkout of stuga-dev/samples, ../samples when there is one, and skips without.
#
# The remote-access suite gets certificates from Pebble, a test CA, with challtestsrv as the zone's
# DNS: packaging/docker/test/compose.pebble.yml, started here unless PEBBLE_DIRECTORY names one
# already running (with PEBBLE_MANAGEMENT, PEBBLE_CA, CHALLTESTSRV_URL and CHALLTESTSRV_DNS) or
# SKIP_PEBBLE=1, which skips that suite.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${SAMPLES_DIR:-}" ] && [ -f ../samples/scripts/build.mjs ]; then
  SAMPLES_DIR="$(cd ../samples && pwd)"
  export SAMPLES_DIR
fi

run_suites() {
  pnpm --filter @stuga/db exec vitest run .integration.test.ts
  pnpm --filter @stuga/node exec vitest run .integration.test.ts
}

postgres=(docker compose -f packaging/docker/test/compose.postgres.yml)
pebble=(docker compose -f packaging/docker/test/compose.pebble.yml)
started_postgres=0
started_pebble=0
teardown() {
  if [ "$started_postgres" = 1 ]; then "${postgres[@]}" down -v >/dev/null 2>&1 || true; fi
  if [ "$started_pebble" = 1 ]; then "${pebble[@]}" down -v >/dev/null 2>&1 || true; fi
}
trap teardown EXIT

if [ -z "${PEBBLE_DIRECTORY:-}" ] && [ "${SKIP_PEBBLE:-}" != 1 ]; then
  started_pebble=1
  "${pebble[@]}" up -d --wait
  export PEBBLE_DIRECTORY=https://127.0.0.1:14000/dir
  export PEBBLE_MANAGEMENT=https://127.0.0.1:15000
  PEBBLE_CA="$PWD/packaging/docker/test/pebble/pebble.minica.pem"
  export PEBBLE_CA
  export CHALLTESTSRV_URL=http://127.0.0.1:8055
  export CHALLTESTSRV_DNS=127.0.0.1:8053
fi

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  started_postgres=1
  "${postgres[@]}" up -d --wait
  export TEST_DATABASE_URL=postgres://stuga:stuga@127.0.0.1:55432/stuga_test
fi

run_suites
