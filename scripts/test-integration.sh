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

if [ -n "${TEST_DATABASE_URL:-}" ]; then
  run_suites
  exit 0
fi

compose=(docker compose -f packaging/docker/test/compose.postgres.yml)
trap '"${compose[@]}" down -v >/dev/null 2>&1 || true' EXIT
"${compose[@]}" up -d --wait
export TEST_DATABASE_URL=postgres://stuga:stuga@127.0.0.1:55432/stuga_test
run_suites
