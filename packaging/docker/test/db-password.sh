#!/usr/bin/env bash
# The database password on Docker: install.sh and ./stuga upgrade give the role a random password
# and write it to .env. Six cases, each on real images and a real volume:
#
#   1. a first install with install.sh
#   2. install.sh again over the volume case 1 left, whose password the new .env does not know
#   3. ./stuga upgrade from a stack that ran on the default password: the content survives, and
#      the default password no longer signs in
#   4. going back from there with ./stuga restore: the older node runs on the current compose.yml
#   5. an upgrade whose images cannot be fetched: .env and the role stay as they were
#   6. an upgrade that fails after the role changed and before .env did: the old password comes
#      back and the node serves again; run again, the upgrade finishes
#
#   packaging/docker/test/db-password.sh [--no-build]
#
# The images are restore-drill.sh's, version 0.0.0-drill (--no-build uses the ones it left). The
# stacks run copies of them as releases 8.0.0 and 9.0.0 under a registry nobody answers at, so a
# pull fails at once and nothing is fetched from the network. Project stuga-dbpass on
# 127.0.0.1:8798 with volume stuga_dbpass_pgdata; STUGA_TEST_VERSION, STUGA_TEST_PROJECT and
# STUGA_TEST_PORT override them.
set -euo pipefail

VERSION="${STUGA_TEST_VERSION:-0.0.0-drill}"
PROJECT="${STUGA_TEST_PROJECT:-stuga-dbpass}"
PORT="${STUGA_TEST_PORT:-8798}"
VOLUME="${PROJECT//-/_}_pgdata"
NODE_IMAGE="ghcr.io/stuga-dev/stuga-node:$VERSION"
POSTGRES_IMAGE="ghcr.io/stuga-dev/stuga-postgres:$VERSION"
OLD=8.0.0
NEXT=9.0.0
MISSING=9.0.1
REGISTRY="127.0.0.1:9/$PROJECT"
OLD_NODE="$REGISTRY/stuga-node:$OLD"

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
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

cleanup() {
  local dir
  for dir in ${DIRS[@]+"${DIRS[@]}"}; do
    if [ -d "$dir" ]; then chmod u+w "$dir" 2>/dev/null || true; down "$dir" -v; remove_dir "$dir"; fi
  done
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  docker image rm "$OLD_NODE" "$REGISTRY/stuga-node:$NEXT" "$REGISTRY/stuga-postgres:$NEXT" >/dev/null 2>&1 || true
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

# ---- releases 8.0.0 and 9.0.0: the same build, reporting those versions, under a registry that never answers
for v in "$OLD" "$NEXT"; do
  docker build -q -t "$REGISTRY/stuga-node:$v" - >/dev/null <<DOCKERFILE
FROM $NODE_IMAGE
RUN printf '%s\n' "$v" > /app/VERSION
DOCKERFILE
done
docker tag "$POSTGRES_IMAGE" "$REGISTRY/stuga-postgres:$NEXT"

# release <version>: that release's compose.yml, env.example and stuga, as GitHub would serve them.
release() {
  local out="$WORK/releases/v$1"
  bash "$ROOT/packaging/docker/package.sh" "$1" "$out" >/dev/null
  sed -i.bak "s|^\(    image: \)ghcr.io/stuga-dev/|\1$REGISTRY/|" "$out/compose.yml"
  rm -f "$out/compose.yml.bak"
  printf '%s' "$out"
}
release "$NEXT" >/dev/null
release "$MISSING" >/dev/null

# install.sh downloads with curl; this one answers for the release's files from $WORK/releases.
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

# ---- checks

net_of_postgres() {
  docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$PROJECT-postgres-1" | awk '{print $1}'
}

# signs_in <password>: true when Postgres takes it over the network, as the node signs in.
signs_in() {
  docker run --rm --network "$(net_of_postgres)" -e PGPASSWORD="$1" --entrypoint psql "$POSTGRES_IMAGE" \
    -h postgres -U stuga -d stuga -tAc 'SELECT 1' >/dev/null 2>&1
}

role_verifier() {
  docker exec "$PROJECT-postgres-1" psql -U stuga -d postgres -tAc "SELECT rolpassword FROM pg_authid WHERE rolname = 'stuga'"
}

env_password() { sed -n 's/^POSTGRES_PASSWORD=//p' "$1/.env" | tail -1; }

file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

ready() { curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/ready" 2>/dev/null; }

wait_ready() {
  local _
  for _ in $(seq 1 180); do
    if ready; then return 0; fi
    sleep 1
  done
  return 1
}

node_image() { docker inspect -f '{{.Config.Image}}' "$PROJECT-node-1"; }

has_new_password() {
  local dir="$1" pw
  pw="$(env_password "$dir")"
  printf '%s' "$pw" | grep -Eq '^[A-Za-z0-9_-]{43}$' || die ".env has no random POSTGRES_PASSWORD (got \"$pw\")"
  [ "$(file_mode "$dir/.env")" = 600 ] || die ".env is mode $(file_mode "$dir/.env"), not 600"
  signs_in "$pw" || die "Postgres does not take the password in .env"
  signs_in stuga && die "Postgres still takes the default password"
  pass ".env has a random password (mode 600), Postgres takes it and not the default one"
}

isolated() {
  local members
  [ "$(docker network inspect -f '{{.Internal}}' "${PROJECT}_db")" = true ] || die "${PROJECT}_db is not internal"
  members="$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "${PROJECT}_db" | tr ' ' '\n' | sed '/^$/d' | sort | tr '\n' ' ')"
  [ "$members" = "$PROJECT-node-1 $PROJECT-postgres-1 " ] || die "${PROJECT}_db holds: $members"
  [ -z "$(docker port "$PROJECT-postgres-1")" ] || die "postgres publishes a port"
  # The same probe reaches the node, so a failure below is the network's, not the probe's.
  docker exec "$PROJECT-postgres-1" bash -c 'timeout 5 bash -c "</dev/tcp/node/8787"' \
    || die "the probe from the postgres container does not reach the node"
  docker exec "$PROJECT-postgres-1" bash -c 'timeout 5 bash -c "</dev/tcp/1.1.1.1/443"' 2>/dev/null \
    && die "the postgres container reaches the internet"
  pass "${PROJECT}_db is internal, holds only postgres and the node, and postgres has no way out"
}

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

# put_release <dir> <version>: that release's three files over the old ones, as for an upgrade without a connection.
put_release() {
  cp "$WORK/releases/v$2/compose.yml" "$WORK/releases/v$2/env.example" "$WORK/releases/v$2/stuga" "$1/"
}

api() { # api METHOD PATH [json body] [bearer token]
  local args=(-sS -X "$1" "http://127.0.0.1:$PORT$2" -H 'content-type: application/json')
  if [ -n "${4:-}" ]; then args+=(-H "authorization: Bearer $4"); fi
  if [ -n "${3:-}" ]; then args+=(-d "$3"); fi
  curl "${args[@]}"
}
jsonfield() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }

MARKER="db-password-$(date -u +%s)"
TOKEN="" DOC=""
add_content() {
  local code _
  code="$(docker exec "$PROJECT-node-1" cat /data/setup-code | tr -d '[:space:]')"
  TOKEN="$(api POST /auth/register "{\"username\":\"liv\",\"password\":\"correct horse battery\",\"name\":\"Liv\",\"setup_code\":\"$code\"}" | jsonfield access_token)"
  [ -n "$TOKEN" ] || die "could not register the first account"
  api POST /api/workspaces '{"name":"Password Workspace"}' "$TOKEN" | jsonfield workspace_id | grep -q . || die "could not create a workspace"
  DOC="$(api POST /api/docs "{\"title\":\"Password Document\",\"markdown\":\"# Password Document\\n\\n$MARKER\"}" "$TOKEN" | jsonfield doc_id)"
  [ -n "$DOC" ] || die "could not create a document"
  # The actor flushes the body after the POST returns.
  for _ in $(seq 1 60); do
    if [ "$(doc_rows)" = 1 ] && api GET "/api/docs/$DOC/markdown" "" "$TOKEN" | grep -q "$MARKER"; then return 0; fi
    sleep 1
  done
  die "the document never reached the database"
}
doc_rows() { docker exec "$PROJECT-postgres-1" psql -U stuga -d stuga -tAc "SELECT count(*) FROM docs WHERE doc_id = '$DOC'"; }
content_kept() {
  [ "$(doc_rows)" = 1 ] || die "the document's row is gone"
  api GET "/api/docs/$DOC/markdown" "" "$TOKEN" | grep -q "$MARKER" || die "the document's body is gone"
  pass "the document and its row are still there"
}

# ---- 1. a first install
step "1. A first install with install.sh"
new_dir first
PATH="$WORK/bin:$PATH" bash "$ROOT/packaging/docker/install.sh" --dir "$dir" --version "$NEXT" --port "$PORT" --local-only \
  > "$WORK/install-1.log" 2>&1 || { cat "$WORK/install-1.log" >&2; die "install.sh failed"; }
ready || die "the node does not serve after install.sh"
pass "install.sh finished and the node serves"
has_new_password "$dir"
isolated
FIRST_PASSWORD="$(env_password "$dir")"
# The volume stays for case 2, as an uninstall that keeps the data leaves it.
down "$dir"
remove_dir "$dir"

# ---- 2. install.sh over that volume
step "2. install.sh again, over the volume an earlier install left"
docker volume inspect "$VOLUME" >/dev/null 2>&1 || die "the first install's volume is gone"
new_dir again
PATH="$WORK/bin:$PATH" bash "$ROOT/packaging/docker/install.sh" --dir "$dir" --version "$NEXT" --port "$PORT" --local-only \
  > "$WORK/install-2.log" 2>&1 || { cat "$WORK/install-2.log" >&2; die "install.sh failed over the existing volume"; }
pass "install.sh finished and the node serves"
has_new_password "$dir"
[ "$(env_password "$dir")" != "$FIRST_PASSWORD" ] || die "the second install kept the first one's password"
signs_in "$FIRST_PASSWORD" && die "Postgres still takes the first install's password"
pass "the first install's password no longer signs in"
down "$dir" -v
remove_dir "$dir"

# ---- 3. an upgrade from a stack on the default password
step "3. ./stuga upgrade from a stack that ran on the default password"
new_dir upgrade
old_stack "$dir"
add_content
pass "old stack serves, with a document"
put_release "$dir" "$NEXT"
(cd "$dir" && ./stuga upgrade) > "$WORK/upgrade-3.log" 2>&1 || { cat "$WORK/upgrade-3.log" >&2; die "the upgrade failed"; }
[ "$(node_image)" = "$REGISTRY/stuga-node:$NEXT" ] || die "the node runs $(node_image) after the upgrade"
pass "upgraded to $NEXT"
has_new_password "$dir"
content_kept
isolated

# ---- 4. going back
step "4. Going back to $OLD with ./stuga restore"
backup="$(sed -n "s|^If something is wrong: \./stuga restore ||p" "$WORK/upgrade-3.log")"
[ -n "$backup" ] || { cat "$WORK/upgrade-3.log" >&2; die "the upgrade named no backup to go back to"; }
(cd "$dir" && ./stuga restore --yes "$backup") > "$WORK/restore-4.log" 2>&1 || { cat "$WORK/restore-4.log" >&2; die "the restore failed"; }
[ "$(node_image)" = "$OLD_NODE" ] || die "the node runs $(node_image) after the restore"
grep -q "stuga-node:$NEXT" "$dir/compose.yml" || die "the restore changed compose.yml"
[ -f "$dir/compose.rollback.yml" ] || die "the restore wrote no compose.rollback.yml"
ready || die "the node does not serve after the restore"
content_kept
(cd "$dir" && docker compose -f compose.yml -f compose.rollback.yml up -d >/dev/null 2>&1) || die "the rollback command failed"
wait_ready || die "the node does not serve after the rollback command"
[ "$(node_image)" = "$OLD_NODE" ] || die "the rollback command started $(node_image)"
signs_in "$(env_password "$dir")" || die "Postgres does not take the password in .env"
pass "$OLD serves again on the current compose.yml and compose.rollback.yml, with the password in .env"
down "$dir" -v
remove_dir "$dir"

# ---- 5. images that cannot be fetched
step "5. An upgrade whose images cannot be fetched"
new_dir pull
old_stack "$dir"
put_release "$dir" "$MISSING"
cp "$dir/.env" "$WORK/env.before"
verifier="$(role_verifier)"
set +e
(cd "$dir" && ./stuga upgrade) > "$WORK/upgrade-4.log" 2>&1
code=$?
set -e
[ "$code" = 3 ] || { cat "$WORK/upgrade-4.log" >&2; die "the upgrade exited $code, not 3"; }
cmp -s "$dir/.env" "$WORK/env.before" || die ".env changed"
[ "$(role_verifier)" = "$verifier" ] || die "the role's password changed"
signs_in stuga || die "Postgres no longer takes the default password"
ready || die "the node stopped serving"
[ "$(node_image)" = "$OLD_NODE" ] || die "the node runs $(node_image)"
pass "exit 3; .env and the role unchanged, and the old node still serves"
down "$dir" -v
remove_dir "$dir"

# ---- 6. a failure between the role and .env
step "6. An upgrade that fails after the role changed, before .env did"
new_dir interrupted
old_stack "$dir"
add_content
put_release "$dir" "$NEXT"
cp "$dir/.env" "$WORK/env.before"
verifier="$(role_verifier)"
# The new .env is made beside the old one, so a directory it cannot write to fails that step.
chmod a-w "$dir"
set +e
(cd "$dir" && ./stuga upgrade) > "$WORK/upgrade-5.log" 2>&1
code=$?
set -e
chmod u+w "$dir"
[ "$code" != 0 ] || { cat "$WORK/upgrade-5.log" >&2; die "the upgrade succeeded in a directory it cannot write to"; }
grep -q "the database password was put back" "$WORK/upgrade-5.log" \
  || { cat "$WORK/upgrade-5.log" >&2; die "the role's password was not changed and put back"; }
cmp -s "$dir/.env" "$WORK/env.before" || die ".env changed"
[ "$(role_verifier)" = "$verifier" ] || die "the role's password is not the one it had"
wait_ready || die "the node does not serve again"
[ "$(node_image)" = "$OLD_NODE" ] || die "the node runs $(node_image)"
signs_in stuga || die "Postgres does not take the default password again"
content_kept
pass "exit $code; the old password is back, .env unchanged, and the old node serves"
(cd "$dir" && ./stuga upgrade) > "$WORK/upgrade-5b.log" 2>&1 || { cat "$WORK/upgrade-5b.log" >&2; die "the upgrade failed when run again"; }
[ "$(node_image)" = "$REGISTRY/stuga-node:$NEXT" ] || die "the node runs $(node_image) after the upgrade"
has_new_password "$dir"
content_kept
pass "run again, the upgrade finishes"

step "All six cases passed"
