#!/usr/bin/env bash
# The integration suites: @stuga/db (migrations, schema snapshot, queries, job queue) and the node's
# backup, media, jobs and agent-instructions route suites, one after the other because they share one database.
#
#   TEST_DATABASE_URL=postgres:///stuga_test scripts/test-integration.sh    a Postgres you run
#   scripts/test-integration.sh                                             packaging/docker/test/compose.postgres.yml
#
# The database needs pgvector and a preloaded pg_search. The backup suite runs pg_dump and pg_restore
# of the server's major from PG_BIN, or from PATH.
set -euo pipefail

cd "$(dirname "$0")/.."

run_suites() {
  pnpm --filter @stuga/db test
  pnpm --filter @stuga/node exec vitest run src/ops src/media src/jobs src/api/agent-instructions.integration.test.ts
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
