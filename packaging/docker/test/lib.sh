# shellcheck shell=bash
# Shared by db-password.sh and going-back.sh: stacks on real images and a real volume, run as releases
# under a registry nobody answers at, so a pull fails at once and nothing is fetched from the network.
# Source it with the script's arguments after setting PROJECT and PORT:
#
#   PROJECT="${STUGA_TEST_PROJECT:-stuga-x}" PORT="${STUGA_TEST_PORT:-8790}"
#   . "$(dirname "$0")/lib.sh"
#
# The images are restore-drill.sh's, version 0.0.0-drill (--no-build uses the ones it left; the remote
# image always comes from there). They run as releases 8.0.0, 9.0.0 and 9.1.0, as 9.0.2 whose node
# exits at once, and as 9.0.1, which has files and no images. Each node image reports its release;
# postgres and remote are the same image under each tag. The volume is the project's name with _pgdata.

# shellcheck disable=SC2034 # used by the scripts that source this
{
  VERSION="${STUGA_TEST_VERSION:-0.0.0-drill}"
  VOLUME="${PROJECT//-/_}_pgdata"
  NODE_IMAGE="ghcr.io/stuga-dev/stuga-node:$VERSION"
  POSTGRES_IMAGE="ghcr.io/stuga-dev/stuga-postgres:$VERSION"
  REMOTE_IMAGE="ghcr.io/stuga-dev/stuga-remote:$VERSION"
  OLD=8.0.0
  NEXT=9.0.0
  NEWER=9.1.0
  MISSING=9.0.1
  BROKEN=9.0.2
  REGISTRY="127.0.0.1:9/$PROJECT"
  OLD_NODE="$REGISTRY/stuga-node:$OLD"
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export COMPOSE_PROJECT_NAME="$PROJECT" STUGA_VOLUME_NAME="$VOLUME"
unset POSTGRES_PASSWORD COMPOSE_FILE

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

if [ "${1:-}" != --no-build ]; then
  docker build -f "$ROOT/packaging/docker/postgres.Dockerfile" -t "$POSTGRES_IMAGE" "$ROOT"
  docker build -f "$ROOT/packaging/docker/node.Dockerfile" --build-arg STUGA_VERSION="$VERSION" -t "$NODE_IMAGE" "$ROOT"
fi

# Physical path: Docker Desktop shares /private/var/folders, and a bind mount through the /var symlink can land in its VM instead.
WORK="$(cd "$(mktemp -d)" && pwd -P)"
DIRS=()
dir=""

# The node writes its data directory as root; only a container can empty it on Linux.
remove_dir() {
  docker run --rm -v "$1:/w" --entrypoint sh "$NODE_IMAGE" -c 'rm -rf /w/..?* /w/.[!.]* /w/*' >/dev/null 2>&1 || true
  rm -rf "$1" || true
}

# down <dir> [-v]
down() { (cd "$1" && docker compose down --remove-orphans ${2:+"$2"} >/dev/null 2>&1) || true; }

RELEASE_IMAGES=()
cleanup() {
  local dir
  for dir in ${DIRS[@]+"${DIRS[@]}"}; do
    if [ -d "$dir" ]; then chmod u+w "$dir" 2>/dev/null || true; down "$dir" -v; remove_dir "$dir"; fi
  done
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  if [ "${#RELEASE_IMAGES[@]}" -gt 0 ]; then docker image rm "${RELEASE_IMAGES[@]}" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# new_dir <name>: sets dir.
new_dir() {
  dir="$WORK/$1"
  mkdir -p "$dir"
  DIRS+=("$dir")
}

# ---- the releases: the same build under each version, reporting it
for v in "$OLD" "$NEXT" "$NEWER" "$BROKEN"; do
  if [ "$v" = "$BROKEN" ]; then entrypoint='ENTRYPOINT ["sh", "-c", "exit 1"]'; else entrypoint=""; fi
  docker build -q -t "$REGISTRY/stuga-node:$v" - >/dev/null <<DOCKERFILE
FROM $NODE_IMAGE
RUN printf '%s\n' "$v" > /app/VERSION
$entrypoint
DOCKERFILE
  docker tag "$POSTGRES_IMAGE" "$REGISTRY/stuga-postgres:$v"
  docker tag "$REMOTE_IMAGE" "$REGISTRY/stuga-remote:$v"
  RELEASE_IMAGES+=("$REGISTRY/stuga-node:$v" "$REGISTRY/stuga-postgres:$v" "$REGISTRY/stuga-remote:$v")
done

# release <version>: that release's compose.yml, env.example and stuga, as GitHub would serve them.
release() {
  local out="$WORK/releases/v$1"
  bash "$ROOT/packaging/docker/package.sh" "$1" "$out" >/dev/null
  sed -i.bak "s|^\(    image: \)ghcr.io/stuga-dev/|\1$REGISTRY/|" "$out/compose.yml"
  rm -f "$out/compose.yml.bak"
  printf '%s' "$out"
}
for v in "$OLD" "$NEXT" "$NEWER" "$MISSING" "$BROKEN"; do release "$v" >/dev/null; done

# install.sh and ./stuga upgrade download with curl; this one answers for the releases' files from $WORK/releases.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<SHIM
#!/usr/bin/env bash
out="" url="" prev=""
for arg in "\$@"; do
  if [ "\$prev" = -o ]; then out="\$arg"; fi
  case "\$arg" in https://github.com/stuga-dev/stuga/releases/download/*) url="\$arg" ;; esac
  prev="\$arg"
done
if [ -n "\$url" ]; then
  rel="\${url#https://github.com/stuga-dev/stuga/releases/download/}"
  exec cp "$WORK/releases/\$rel" "\${out:-\$(basename "\$rel")}"
fi
exec $(command -v curl) "\$@"
SHIM
chmod +x "$WORK/bin/curl"

# put_release <dir> <version>: that release's three files over the old ones, as for an upgrade without a connection.
put_release() {
  cp "$WORK/releases/v$2/compose.yml" "$WORK/releases/v$2/env.example" "$WORK/releases/v$2/stuga" "$1/"
}

# run_install <dir> <version> [<install.sh option>…]: install.sh, its output in $WORK/install-<dir name>.log.
run_install() {
  local dir="$1" version="$2"
  shift 2
  PATH="$WORK/bin:$PATH" bash "$ROOT/packaging/docker/install.sh" --dir "$dir" --version "$version" --port "$PORT" --local-only "$@" \
    > "$WORK/install-$(basename "$dir").log" 2>&1
}

# ---- checks

net_of_postgres() {
  docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$PROJECT-postgres-1" | awk '{print $1}'
}

# signs_in <password>: true when Postgres takes it over the network, as the node signs in.
signs_in() {
  docker run --rm --network "$(net_of_postgres)" -e PGPASSWORD="$1" --entrypoint psql "$POSTGRES_IMAGE" \
    -h postgres -U stuga -d stuga -tAc 'SELECT 1' >/dev/null 2>&1
}

# sql <query>: one value from the stack's database, as the superuser over the container's socket.
sql() { docker exec "$PROJECT-postgres-1" psql -U stuga -d stuga -tAc "$1"; }

env_compose_file() { sed -n 's/^COMPOSE_FILE=//p' "$1/.env" | tail -1; }

ready() { curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/ready" 2>/dev/null; }

wait_ready() {
  local _
  for _ in $(seq 1 180); do
    if ready; then return 0; fi
    sleep 1
  done
  return 1
}

# image_of <service>: the image its container runs.
image_of() { docker inspect -f '{{.Config.Image}}' "$PROJECT-$1-1"; }
node_image() { image_of node; }

# old_stack <dir>: a stack as 0.1.6's install.sh left it, on release 8.0.0: its compose.yml,
# which names the password itself, and a .env with none.
old_stack() {
  local dir="$1"
  cat > "$dir/compose.yml" <<YAML
name: stuga
services:
  postgres:
    image: $POSTGRES_IMAGE
    restart: unless-stopped
    environment:
      POSTGRES_USER: stuga
      POSTGRES_PASSWORD: stuga
      POSTGRES_DB: stuga
    volumes:
      - pgdata:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U stuga -d stuga"]
      interval: 3s
      timeout: 5s
      retries: 20
  node:
    image: $OLD_NODE
    restart: unless-stopped
    stop_grace_period: 30s
    depends_on:
      postgres:
        condition: service_healthy
    env_file:
      - path: .env
        required: false
    environment:
      DATABASE_URL: postgres://stuga:stuga@postgres:5432/stuga
      DATA_DIR: /data
      BACKUP_DIR: /backups
      BIND: 0.0.0.0
      PORT: "8787"
      PUBLIC_ORIGIN: \${PUBLIC_ORIGIN:-http://localhost:8787}
    volumes:
      - ./data/node:/data
      - \${BACKUP_DIR:-./backups}:/backups
    ports:
      - "\${HOST_BIND:-0.0.0.0}:\${HOST_PORT:-8787}:8787"
volumes:
  pgdata:
    name: \${STUGA_VOLUME_NAME:-stuga_pgdata}
YAML
  cp "$ROOT/packaging/docker/env.example" "$dir/env.example"
  cp "$ROOT/packaging/docker/env.example" "$dir/.env"
  printf '\nPUBLIC_ORIGIN=http://127.0.0.1:%s\nHOST_PORT=%s\nHOST_BIND=127.0.0.1\n' "$PORT" "$PORT" >> "$dir/.env"
  mkdir -p "$dir/data/node" "$dir/backups"
  (cd "$dir" && docker compose up -d >/dev/null 2>&1) || die "the old stack did not start"
  wait_ready || die "the old stack's node did not become ready"
  signs_in stuga || die "the old stack's Postgres does not take the default password"
}

api() { # api METHOD PATH [json body] [bearer token]
  local args=(-sS -X "$1" "http://127.0.0.1:$PORT$2" -H 'content-type: application/json')
  if [ -n "${4:-}" ]; then args+=(-H "authorization: Bearer $4"); fi
  if [ -n "${3:-}" ]; then args+=(-d "$3"); fi
  curl "${args[@]}"
}
jsonfield() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }

MARKER="$PROJECT-$(date -u +%s)"
TOKEN="" DOC=""
# add_content: the first account, a workspace and a document, on a new node.
add_content() {
  local code _
  code="$(docker exec "$PROJECT-node-1" cat /data/setup-code | tr -d '[:space:]')"
  TOKEN="$(api POST /auth/register "{\"username\":\"liv\",\"password\":\"correct horse battery\",\"name\":\"Liv\",\"setup_code\":\"$code\"}" | jsonfield access_token)"
  [ -n "$TOKEN" ] || die "could not register the first account"
  api POST /api/workspaces '{"name":"Test Workspace"}' "$TOKEN" | jsonfield workspace_id | grep -q . || die "could not create a workspace"
  DOC="$(api POST /api/docs "{\"title\":\"Test Document\",\"markdown\":\"# Test Document\\n\\n$MARKER\"}" "$TOKEN" | jsonfield doc_id)"
  [ -n "$DOC" ] || die "could not create a document"
  # The actor flushes the body after the POST returns.
  for _ in $(seq 1 60); do
    if [ "$(doc_rows)" = 1 ] && api GET "/api/docs/$DOC/markdown" "" "$TOKEN" | grep -q "$MARKER"; then return 0; fi
    sleep 1
  done
  die "the document never reached the database"
}
doc_rows() { sql "SELECT count(*) FROM docs WHERE doc_id = '$DOC'"; }
content_kept() {
  [ "$(doc_rows)" = 1 ] || die "the document's row is gone"
  api GET "/api/docs/$DOC/markdown" "" "$TOKEN" | grep -q "$MARKER" || die "the document's body is gone"
  pass "the document and its row are still there"
}
