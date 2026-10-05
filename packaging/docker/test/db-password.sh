#!/usr/bin/env bash
# The database password on Docker: install.sh and ./stuga upgrade give the role a random password
# and write it to .env. Eight cases, each on real images and a real volume:
#
#   1. a first install with install.sh
#   2. install.sh again over the volume case 1 left, whose password the new .env does not know
#   3. ./stuga upgrade from a stack that ran on the default password: the content survives, and
#      the default password no longer signs in
#   4. going back from there with ./stuga restore: the older release's node, postgres and remote run
#      on the current compose.yml, and a plain `docker compose up -d` keeps them there
#   5. an upgrade whose images cannot be fetched: .env and the role stay as they were; and one
#      refused for a POSTGRES_PASSWORD in the shell that .env does not name
#   6. an upgrade that fails after the role changed and before .env did: the old password comes
#      back and the node serves again; run again, the upgrade finishes
#   7. an upgrade stopped by a signal just before .env takes the password, and just after: the old
#      password comes back, or .env's stays; run again, the upgrade finishes
#   8. an upgrade whose node never starts, so it takes no backup: the rollback it offers brings the
#      stack back as it was, on the new password, and the next upgrade takes the rollback out
#
#   packaging/docker/test/db-password.sh [--no-build]
#
# The stacks are lib.sh's. Project stuga-dbpass on 127.0.0.1:8798; STUGA_TEST_VERSION,
# STUGA_TEST_PROJECT and STUGA_TEST_PORT override them.
set -euo pipefail

PROJECT="${STUGA_TEST_PROJECT:-stuga-dbpass}"
PORT="${STUGA_TEST_PORT:-8798}"
# shellcheck source=packaging/docker/test/lib.sh
. "$(dirname "$0")/lib.sh"

# Case 7's mv: a rename onto .env waits for the test's signal, before it happens or after
# (MV_WHEN), and leaves MV_MARK to say it is waiting.
mkdir -p "$WORK/mvbin"
cat > "$WORK/mvbin/mv" <<SHIM
#!/usr/bin/env bash
last=""
for arg in "\$@"; do last="\$arg"; done
case "\$last" in
  .env | */.env)
    if [ "\$MV_WHEN" = after ]; then $(command -v mv) "\$@" || exit; fi
    : > "\$MV_MARK"
    sleep 600
    exit 1 ;;
esac
exec $(command -v mv) "\$@"
SHIM
chmod +x "$WORK/mvbin/mv"

# ---- checks

role_verifier() {
  docker exec "$PROJECT-postgres-1" psql -U stuga -d postgres -tAc "SELECT rolpassword FROM pg_authid WHERE rolname = 'stuga'"
}

env_password() { sed -n 's/^POSTGRES_PASSWORD=//p' "$1/.env" | tail -1; }

file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

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
for service in postgres remote; do
  [ "$(image_of "$service")" = "$REGISTRY/stuga-$service:$OLD" ] || die "$service runs $(image_of "$service") after the restore"
done
pass "node, postgres and remote run $OLD"
grep -q "stuga-node:$NEXT" "$dir/compose.yml" || die "the restore changed compose.yml"
[ -f "$dir/compose.rollback.yml" ] || die "the restore wrote no compose.rollback.yml"
[ "$(env_compose_file "$dir")" = compose.yml:compose.rollback.yml ] || die ".env has COMPOSE_FILE=$(env_compose_file "$dir")"
ready || die "the node does not serve after the restore"
content_kept
grep -q "Start the stack with: docker compose up -d" "$WORK/restore-4.log" \
  || { cat "$WORK/restore-4.log" >&2; die "the restore did not print a plain docker compose up -d"; }
# Recreated, as a changed setting in .env would have it.
(cd "$dir" && docker compose up -d --force-recreate node >/dev/null 2>&1) || die "docker compose up -d failed"
wait_ready || die "the node does not serve after docker compose up -d"
[ "$(node_image)" = "$OLD_NODE" ] || die "docker compose up -d started $(node_image)"
signs_in "$(env_password "$dir")" || die "Postgres does not take the password in .env"
pass "a plain docker compose up -d keeps $OLD, on the current compose.yml and the password in .env"
down "$dir" -v
remove_dir "$dir"

# ---- 5. images that cannot be fetched
step "5. An upgrade whose images cannot be fetched"
new_dir pull
old_stack "$dir"
put_release "$dir" "$MISSING"
cp "$dir/.env" "$WORK/env.before"
verifier="$(role_verifier)"
for command in upgrade db-password; do
  set +e
  (cd "$dir" && POSTGRES_PASSWORD=from-the-shell ./stuga "$command") > "$WORK/shell-$command.log" 2>&1
  code=$?
  set -e
  [ "$code" = 2 ] || { cat "$WORK/shell-$command.log" >&2; die "./stuga $command with POSTGRES_PASSWORD in the shell exited $code, not 2"; }
  grep -q "set in this shell" "$WORK/shell-$command.log" || die "./stuga $command did not name the shell's POSTGRES_PASSWORD"
done
cmp -s "$dir/.env" "$WORK/env.before" || die ".env changed"
ready || die "the node stopped serving"
pass "a POSTGRES_PASSWORD only the shell has is refused, with nothing changed"
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
down "$dir" -v
remove_dir "$dir"

# ---- 7. a signal on either side of the rename onto .env
step "7. An upgrade stopped by a signal just before .env takes the password, and just after"
new_dir signal
old_stack "$dir"
add_content
put_release "$dir" "$NEXT"
cp "$dir/.env" "$WORK/env.before"
verifier="$(role_verifier)"

# interrupt <before|after>: the upgrade in a process group of its own, which gets SIGTERM, as a
# terminal's Ctrl-C reaches every process of the job, once the rename onto .env waits. Sets code.
interrupt() {
  local mark="$WORK/at-mv-$1" pid _
  rm -f "$mark"
  set -m
  (cd "$dir" && PATH="$WORK/mvbin:$PATH" MV_WHEN="$1" MV_MARK="$mark" exec ./stuga upgrade) > "$WORK/upgrade-7-$1.log" 2>&1 &
  pid=$!
  set +m
  for _ in $(seq 1 300); do
    if [ -f "$mark" ] || ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 1
  done
  [ -f "$mark" ] || { cat "$WORK/upgrade-7-$1.log" >&2; die "the upgrade never reached the rename onto .env"; }
  kill -TERM -- "-$pid"
  set +e
  wait "$pid"
  code=$?
  set -e
}

interrupt before
[ "$code" = 143 ] || { cat "$WORK/upgrade-7-before.log" >&2; die "the upgrade exited $code, not 143"; }
grep -q "the database password was put back" "$WORK/upgrade-7-before.log" \
  || { cat "$WORK/upgrade-7-before.log" >&2; die "the role's password was not put back"; }
cmp -s "$dir/.env" "$WORK/env.before" || die ".env changed"
[ "$(role_verifier)" = "$verifier" ] || die "the role's password is not the one it had"
wait_ready || die "the node does not serve again"
[ "$(node_image)" = "$OLD_NODE" ] || die "the node runs $(node_image)"
signs_in stuga || die "Postgres does not take the default password again"
content_kept
pass "stopped before the rename: exit 143, the old password is back, .env unchanged, the old node serves"

interrupt after
[ "$code" = 143 ] || { cat "$WORK/upgrade-7-after.log" >&2; die "the upgrade exited $code, not 143"; }
grep -q "the database has its own password now" "$WORK/upgrade-7-after.log" \
  || { cat "$WORK/upgrade-7-after.log" >&2; die "the upgrade did not keep the password .env took"; }
has_new_password "$dir"
[ "$(docker inspect -f '{{.State.Running}}' "$PROJECT-node-1")" = false ] || die "the old node, which has the old password, was started"
pass "stopped after the rename: exit 143, .env and the role keep the new password, the old node stays stopped"

(cd "$dir" && ./stuga upgrade) > "$WORK/upgrade-7b.log" 2>&1 || { cat "$WORK/upgrade-7b.log" >&2; die "the upgrade failed when run again"; }
[ "$(node_image)" = "$REGISTRY/stuga-node:$NEXT" ] || die "the node runs $(node_image) after the upgrade"
has_new_password "$dir"
content_kept
pass "run again, the upgrade finishes"
down "$dir" -v
remove_dir "$dir"

# ---- 8. an upgrade whose node never starts
step "8. An upgrade whose node never starts, and the way back it offers"
new_dir broken
old_stack "$dir"
add_content
put_release "$dir" "$BROKEN"
set +e
(cd "$dir" && STUGA_READY_MAX_SECONDS=120 ./stuga upgrade) > "$WORK/upgrade-8.log" 2>&1
code=$?
set -e
[ "$code" = 4 ] || { cat "$WORK/upgrade-8.log" >&2; die "the upgrade exited $code, not 4"; }
grep -q "took no backup" "$WORK/upgrade-8.log" || { cat "$WORK/upgrade-8.log" >&2; die "the upgrade did not say it took no backup"; }
grep -q "keep compose.yml and run: docker compose up -d" "$WORK/upgrade-8.log" \
  || { cat "$WORK/upgrade-8.log" >&2; die "the upgrade did not offer a plain docker compose up -d"; }
# The old stack had no remote service: its release's comes back with it.
for image in "$OLD_NODE" "$POSTGRES_IMAGE" "$REGISTRY/stuga-remote:$OLD"; do
  grep -q "image: \"$image\"" "$dir/compose.rollback.yml" || { cat "$dir/compose.rollback.yml" >&2; die "compose.rollback.yml does not name $image"; }
done
[ "$(env_compose_file "$dir")" = compose.yml:compose.rollback.yml ] || die ".env has COMPOSE_FILE=$(env_compose_file "$dir")"
pass "exit 4; compose.rollback.yml pins the stack as it was before the upgrade, and .env's COMPOSE_FILE adds it"
(cd "$dir" && docker compose up -d >/dev/null 2>&1) || die "docker compose up -d failed"
wait_ready || die "the node does not serve after docker compose up -d"
[ "$(node_image)" = "$OLD_NODE" ] || die "docker compose up -d started $(node_image)"
[ "$(image_of postgres)" = "$POSTGRES_IMAGE" ] || die "docker compose up -d started postgres on $(image_of postgres)"
has_new_password "$dir"
content_kept
pass "the offered command brings $OLD back, signing in with the password in .env"
(cd "$dir" && ./stuga status) > "$WORK/status-8.log" 2>&1 || true
grep -q "compose.rollback.yml keeps the stack on another release than compose.yml names" "$WORK/status-8.log" \
  || { cat "$WORK/status-8.log" >&2; die "status does not mention compose.rollback.yml"; }
put_release "$dir" "$NEXT"
(cd "$dir" && ./stuga upgrade) > "$WORK/upgrade-8b.log" 2>&1 || { cat "$WORK/upgrade-8b.log" >&2; die "the next upgrade failed"; }
[ "$(node_image)" = "$REGISTRY/stuga-node:$NEXT" ] || die "the node runs $(node_image) after the next upgrade"
[ ! -e "$dir/compose.rollback.yml" ] || die "the next upgrade left compose.rollback.yml"
grep -q '^COMPOSE_FILE=' "$dir/.env" && die "the next upgrade left COMPOSE_FILE in .env"
grep -q 'compose.rollback.yml' "$dir/.env" && die "the next upgrade left its note in .env"
(cd "$dir" && docker compose up -d >/dev/null 2>&1) || die "docker compose up -d failed after the next upgrade"
[ "$(node_image)" = "$REGISTRY/stuga-node:$NEXT" ] || die "docker compose up -d started $(node_image) after the next upgrade"
content_kept
pass "the next upgrade takes compose.rollback.yml out of the directory and .env"

step "All eight cases passed"
