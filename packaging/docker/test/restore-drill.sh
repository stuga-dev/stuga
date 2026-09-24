#!/usr/bin/env bash
# The restore drill on Docker. Builds both images from this checkout as version 0.0.0-drill,
# installs them the way an operator does (package.sh's compose.yml, env.example as .env, ./stuga)
# in a throwaway directory, and runs packaging/test/drill-content.sh with ./stuga's own commands.
#
#   packaging/docker/test/restore-drill.sh [--no-build]
#
# Project stuga-drill on 127.0.0.1:8799 with volume stuga_drill_pgdata, so no other stack is touched.
# The images stay afterwards for backup-suite-in-image.sh.
set -euo pipefail

VERSION=0.0.0-drill
PROJECT=stuga-drill
VOLUME=stuga_drill_pgdata
PORT=8799
NODE_IMAGE="ghcr.io/stuga-dev/stuga-node:$VERSION"
POSTGRES_IMAGE="ghcr.io/stuga-dev/stuga-postgres:$VERSION"

# The hooks drill-content.sh runs, with the throwaway directory as DRILL_DIR.
if [ "${1:-}" = --hook ]; then
  cd "$DRILL_DIR"
  case "$2" in
    verify)
      ./stuga verify "$(basename "$DRILL_BACKUP")"
      docker run --rm -v "$DRILL_BACKUP:/b:ro" --entrypoint cat "$NODE_IMAGE" /b/MANIFEST.json \
        | grep -q "\"runtime_version\": \"$VERSION\"" \
        || { echo "the backup's manifest does not name the build that took it ($VERSION)" >&2; exit 1; }
      ;;
    wipe)
      docker compose rm -sf postgres
      docker volume rm "$VOLUME"
      docker compose up -d --wait postgres
      # The node wrote its data directory as root; only a container can empty it on Linux.
      docker run --rm -v "$DRILL_DIR/data/node:/d" --entrypoint sh "$NODE_IMAGE" -c 'rm -rf /d/..?* /d/.[!.]* /d/*'
      [ -z "$(ls -A "$DRILL_DIR/data/node")" ] || { echo "the data directory is not empty" >&2; exit 1; }
      [ "$(docker compose exec -T postgres psql -U stuga -d stuga -tAc "SELECT to_regclass('public.docs') IS NULL")" = t ] \
        || { echo "the new cluster is not empty" >&2; exit 1; }
      ;;
    *) echo "unknown hook $2" >&2; exit 2 ;;
  esac
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SELF="$ROOT/packaging/docker/test/restore-drill.sh"

if [ "${1:-}" != --no-build ]; then
  docker build -f "$ROOT/packaging/docker/postgres.Dockerfile" -t "$POSTGRES_IMAGE" "$ROOT"
  docker build -f "$ROOT/packaging/docker/node.Dockerfile" --build-arg STUGA_VERSION="$VERSION" -t "$NODE_IMAGE" "$ROOT"
fi

# Physical path: Docker Desktop shares /private/var/folders, and a bind mount through the /var symlink can land in its VM instead.
DRILL_DIR="$(cd "$(mktemp -d)" && pwd -P)"
export DRILL_DIR

cleanup() {
  (cd "$DRILL_DIR" && docker compose down -v --remove-orphans >/dev/null 2>&1) || true
  docker run --rm -v "$DRILL_DIR:/w" --entrypoint sh "$NODE_IMAGE" -c 'rm -rf /w/..?* /w/.[!.]* /w/*' >/dev/null 2>&1 || true
  rm -rf "$DRILL_DIR" || true
}
trap cleanup EXIT

bash "$ROOT/packaging/docker/package.sh" "$VERSION" "$DRILL_DIR"
cp "$DRILL_DIR/env.example" "$DRILL_DIR/.env"
cat >> "$DRILL_DIR/.env" <<ENV
COMPOSE_PROJECT_NAME=$PROJECT
STUGA_VOLUME_NAME=$VOLUME
HOST_PORT=$PORT
PUBLIC_ORIGIN=http://127.0.0.1:$PORT
ENV
# The data directory is made by this user first, so the bind mount does not create it as root.
mkdir -p "$DRILL_DIR/data/node"

cd "$DRILL_DIR"
docker compose down -v >/dev/null 2>&1 || true
docker compose up -d

bash "$ROOT/packaging/test/drill-content.sh" --url "http://127.0.0.1:$PORT" \
  --setup-code "docker compose exec -T node cat /data/setup-code" \
  --backup "./stuga backup" \
  --verify "bash '$SELF' --hook verify" \
  --stop "docker compose stop node" \
  --wipe "bash '$SELF' --hook wipe" \
  --restore "./stuga restore --yes \"\$DRILL_BACKUP\"" \
  --start true \
  --list "./stuga list"
