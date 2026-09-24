#!/usr/bin/env bash
# The node's backup suite (services/node/src/ops) on top of a node image, so it drives that image's
# Node, pg_dump, pg_restore and GNU tar. scripts/test-integration.sh runs the same suite on the host.
#
#   packaging/docker/test/backup-suite-in-image.sh [<node image>]    (default: build this checkout)
#
# The runtime image carries no tests or dev dependencies, so the suite's workspace is installed in
# a layer above it. Postgres is test/compose.postgres.yml's, reached by its service name.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=packaging/versions.env
. "$ROOT/packaging/versions.env"

image="${1:-}"
if [ -z "$image" ]; then
  image=stuga-node-backup-suite-base
  docker build -f "$ROOT/packaging/docker/node.Dockerfile" -t "$image" "$ROOT"
fi

suite=stuga-node-backup-suite
docker build -t "$suite" --build-arg NODE_IMAGE="$image" --build-arg PNPM_VERSION="$PNPM_VERSION" -f - "$ROOT" <<'DOCKERFILE'
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ARG PNPM_VERSION
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
# The image runs as production; the suite needs the workspace's dev dependencies.
ENV NODE_ENV=test
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=stuga-pnpm-store,target=/pnpm/store \
    npm_config_store_dir=/pnpm/store pnpm install --frozen-lockfile
WORKDIR /src/services/node
DOCKERFILE

compose=(docker compose -f "$ROOT/packaging/docker/test/compose.postgres.yml")
trap '"${compose[@]}" down -v >/dev/null 2>&1 || true' EXIT
"${compose[@]}" up -d --wait

docker run --rm --network stuga-test_default \
  -e TEST_DATABASE_URL=postgres://stuga:stuga@postgres:5432/stuga_test \
  "$suite" pnpm exec vitest run src/ops
