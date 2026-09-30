#!/usr/bin/env bash
# The shared remote-access directory with real owners (services/node/src/remote/*.root.test.ts):
# the node as root, the connector as 65532, as compose runs them. Only root can give files away, so
# these run here, in a container with no network, and are skipped by `pnpm test`.
#
#   packaging/docker/test/remote-dir-in-image.sh
#
# The suite's workspace is installed on the node image's base, in a throwaway image that is removed
# afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=packaging/versions.env
. "$ROOT/packaging/versions.env"

suite=stuga-remote-dir-suite
trap 'docker image rm "$suite" >/dev/null 2>&1 || true' EXIT
# Unquoted: the pins are filled in here.
docker build -t "$suite" -f - "$ROOT" <<DOCKERFILE
FROM node:${NODE_VERSION}-${DEBIAN_SUITE}-slim
RUN npm install -g "pnpm@${PNPM_VERSION}"
ENV NODE_ENV=test npm_config_update_notifier=false
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=stuga-pnpm-store,target=/pnpm/store \\
    npm_config_store_dir=/pnpm/store pnpm install --frozen-lockfile
WORKDIR /src/services/node
DOCKERFILE

docker run --rm --network none --user 0:0 "$suite" pnpm exec vitest run .root.test.ts
