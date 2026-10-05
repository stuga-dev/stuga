#!/usr/bin/env bash
# Going back to an earlier release on Docker, and the node refusing data a newer release served.
# One stack, installed as 8.0.0 and upgraded to 9.0.0 (which backs up 8.0.0's data first), then:
#
#   1. 8.0.0 started by hand on data 9.0.0 served: it stays up, refuses, and changes nothing;
#      ./stuga status says why, and ./stuga upgrade 9.0.0 brings 9.0.0 back
#   2. ./stuga upgrade 8.0.0 is refused with nothing changed, with the node running and stopped
#   3. 8.0.0's files put there by hand, then ./stuga upgrade: refused, and 9.0.0 still serves
#   4. ./stuga restore of 8.0.0's backup pins the whole stack to 8.0.0; restoring 9.0.0's backup
#      takes the pin out
#   5. ./stuga restore with the node's container removed: the backup's release serves
#   6. ./stuga backup on 8.0.0, then an upgrade whose node never starts: it offers the rollback,
#      not that backup; then 9.0.0 upgrades the data under the rollback, which puts back an 8.0.0
#      that refuses it, and ./stuga upgrade 9.0.0 takes the rollback out
#   7. a backup 9.1.0 served, restored onto a stack whose compose.yml names 9.0.0, then
#      ./stuga upgrade: refused
#   8. install.sh --version 8.0.0 over a volume a newer release served: it fails at once and says why
#
#   packaging/docker/test/going-back.sh [--no-build]
#
# The stacks are lib.sh's. Project stuga-goback on 127.0.0.1:8797; STUGA_TEST_VERSION,
# STUGA_TEST_PROJECT and STUGA_TEST_PORT override them.
set -euo pipefail

PROJECT="${STUGA_TEST_PROJECT:-stuga-goback}"
PORT="${STUGA_TEST_PORT:-8797}"
# shellcheck source=packaging/docker/test/lib.sh
. "$(dirname "$0")/lib.sh"

# run <log name> <stuga arguments…>: ./stuga in the stack's directory, with the curl that answers for
# the releases, its output in $WORK/<log name>.log. Sets code.
code=0
run() {
  local log="$WORK/$1.log"
  shift
  set +e
  (cd "$dir" && PATH="$WORK/bin:$PATH" ./stuga "$@") > "$log" 2>&1
  code=$?
  set -e
}
# expect <exit code> <log name> <stuga arguments…>
expect() {
  local want="$1" log="$2"
  shift
  run "$@"
  [ "$code" = "$want" ] || { cat "$WORK/$log.log" >&2; die "./stuga ${*:2} exited $code, not $want"; }
}
logged() { grep -qF -- "$2" "$WORK/$1.log" || { cat "$WORK/$1.log" >&2; die "$3"; }; }

refused() { [[ "$(curl -sS --max-time 5 "http://127.0.0.1:$PORT/ready" 2>/dev/null || true)" == *'"status":"refused"'* ]]; }
served() { sql "SELECT app_version FROM node_state"; }
schema() { sql "SELECT max(id) FROM schema_migrations"; }
backups() { find "$dir/backups" -mindepth 1 -maxdepth 1 -type d ! -name '*.partial' | wc -l | tr -d ' '; }
running() { docker inspect -f '{{.State.Running}}' "$PROJECT-node-1"; }

# stack_on <version>: node, postgres and remote all run that release.
stack_on() {
  local service
  for service in node postgres remote; do
    [ "$(image_of "$service")" = "$REGISTRY/stuga-$service:$1" ] || die "$service runs $(image_of "$service"), not $1"
  done
}

# ---- an 8.0.0 stack with content, upgraded to 9.0.0
step "An 8.0.0 stack with a document, upgraded to $NEXT"
new_dir main
run_install "$dir" "$OLD" || { cat "$WORK/install-main.log" >&2; die "install.sh failed"; }
add_content
expect 0 upgrade-next upgrade "$NEXT"
stack_on "$NEXT"
OLD_BACKUP="$(sed -n 's|^If something is wrong: .*stuga restore ||p' "$WORK/upgrade-next.log")"
[ -n "$OLD_BACKUP" ] || { cat "$WORK/upgrade-next.log" >&2; die "the upgrade named no backup of $OLD's data"; }
expect 0 backup-next backup
NEXT_BACKUP="$(sed -n 's/^Backup complete: //p' "$WORK/backup-next.log")"
[ -n "$NEXT_BACKUP" ] || { cat "$WORK/backup-next.log" >&2; die "./stuga backup named no backup"; }
content_kept
pass "$NEXT serves; $OLD_BACKUP holds $OLD's data, $NEXT_BACKUP $NEXT's"

# ---- 1. the older release started by hand
step "1. $OLD started by hand on data $NEXT served"
backups_before="$(backups)"
schema_before="$(schema)"
put_release "$dir" "$OLD"
(cd "$dir" && docker compose up -d >/dev/null 2>&1) || die "docker compose up -d failed"
restarts="$(docker inspect -f '{{.RestartCount}}' "$PROJECT-node-1")"
for _ in $(seq 1 60); do
  if refused; then break; fi
  sleep 1
done
refused || die "/ready does not say refused"
sleep 20
[ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$PROJECT-node-1")" = "true $restarts" ] \
  || die "the node did not stay up: $(docker inspect -f '{{.State.Status}}, restarted {{.RestartCount}} times' "$PROJECT-node-1")"
refused || die "/ready no longer says refused"
(cd "$dir" && docker compose logs --no-log-prefix node) > "$WORK/node-1.log" 2>&1 || die "no log from the node"
logged node-1 "refusing this database: Stuga $NEXT served it last" "the node's log does not say why it refuses"
[ "$(backups)" = "$backups_before" ] || die "the refusing node took a backup"
[ "$(served)" = "$NEXT" ] || die "node_state.app_version is $(served), not $NEXT"
[ "$(schema)" = "$schema_before" ] || die "schema_migrations changed"
pass "it stays up after 20 s, /ready says refused, its log says why, and nothing changed"
run status-1 status
logged status-1 "data         last served by stuga $NEXT" "status does not name the version that served the data"
logged status-1 "ready        NO — refused: Stuga $NEXT served it last" "status does not say the node refuses"
logged status-1 "the node refuses this data: stuga $NEXT served it last and the node is $OLD" "status does not warn"
pass "./stuga status says the node refuses, and why"
expect 0 upgrade-1 upgrade "$NEXT"
logged upgrade-1 "compose.yml names stuga $NEXT again; it serves." "./stuga upgrade $NEXT did not say $NEXT serves again"
stack_on "$NEXT"
ready || die "$NEXT does not serve"
content_kept
pass "./stuga upgrade $NEXT puts $NEXT's files back, and it serves"

# ---- 2. upgrading to an older release
step "2. ./stuga upgrade $OLD on data $NEXT served"
cp "$dir/compose.yml" "$WORK/compose.next"
expect 2 upgrade-2 upgrade "$OLD"
logged upgrade-2 "stuga $OLD is older than stuga $NEXT, which last served this data" "the refusal does not say why"
cmp -s "$dir/compose.yml" "$WORK/compose.next" || die "compose.yml changed"
ready || die "the node stopped serving"
(cd "$dir" && docker compose stop node >/dev/null 2>&1) || die "could not stop the node"
expect 2 upgrade-2b upgrade "$OLD"
cmp -s "$dir/compose.yml" "$WORK/compose.next" || die "compose.yml changed with the node stopped"
[ "$(running)" = false ] || die "the refused upgrade started the node"
(cd "$dir" && docker compose start node >/dev/null 2>&1) || die "could not start the node"
wait_ready || die "the node does not serve again"
[ "$(node_image)" = "$REGISTRY/stuga-node:$NEXT" ] || die "the node runs $(node_image)"
pass "exit 2 with nothing changed, the node running and stopped"

# ---- 3. an older compose.yml put there by hand
step "3. $OLD's files put there by hand, then ./stuga upgrade"
put_release "$dir" "$OLD"
expect 2 upgrade-3 upgrade
logged upgrade-3 "compose.yml names stuga $OLD, older than stuga $NEXT, which last served this data" "the refusal does not say why"
[ "$(node_image)" = "$REGISTRY/stuga-node:$NEXT" ] || die "the node runs $(node_image)"
ready || die "$NEXT stopped serving"
pass "exit 2, and $NEXT still serves"
put_release "$dir" "$NEXT"

# ---- 4. going back by restore, and forward again
step "4. Going back to $OLD with ./stuga restore, and forward to $NEXT again"
expect 0 restore-4 restore --yes "$OLD_BACKUP"
stack_on "$OLD"
for service in node postgres remote; do
  grep -qF "image: \"$REGISTRY/stuga-$service:$OLD\"" "$dir/compose.rollback.yml" || die "compose.rollback.yml does not pin $service to $OLD"
done
[ "$(env_compose_file "$dir")" = compose.yml:compose.rollback.yml ] || die ".env has COMPOSE_FILE=$(env_compose_file "$dir")"
grep -q "stuga-node:$NEXT" "$dir/compose.yml" || die "the restore changed compose.yml"
ready || die "$OLD does not serve"
[ "$(served)" = "$OLD" ] || die "node_state.app_version is $(served), not $OLD"
content_kept
pass "node, postgres and remote run $OLD, pinned in compose.rollback.yml"
expect 0 restore-4b restore --yes "$NEXT_BACKUP"
stack_on "$NEXT"
[ ! -e "$dir/compose.rollback.yml" ] || die "compose.rollback.yml is still there"
grep -q '^COMPOSE_FILE=' "$dir/.env" && die ".env still names COMPOSE_FILE"
ready || die "$NEXT does not serve"
content_kept
pass "restoring $NEXT's backup runs $NEXT, and takes the pin out of the directory and .env"

# ---- 5. no node container
step "5. ./stuga restore with the node's container removed"
(cd "$dir" && docker compose rm -sf node >/dev/null 2>&1) || die "could not remove the node's container"
expect 0 restore-5 restore --yes "$OLD_BACKUP"
stack_on "$OLD"
ready || die "$OLD does not serve"
if grep -l 'image: ""' "$dir"/*.yml; then die "a compose file names an empty image"; fi
content_kept
pass "the backup's release serves, and no file names an empty image"

# ---- 6. a manual backup, then a broken upgrade
step "6. ./stuga backup on $OLD, then an upgrade whose node never starts"
expect 0 backup-6 backup
OWN_BACKUP="$(sed -n 's/^Backup complete: //p' "$WORK/backup-6.log")"
[ -n "$OWN_BACKUP" ] || { cat "$WORK/backup-6.log" >&2; die "./stuga backup named no backup"; }
put_release "$dir" "$BROKEN"
STUGA_READY_MAX_SECONDS=120 expect 4 upgrade-6 upgrade
logged upgrade-6 "took no backup, so it changed nothing" "the upgrade did not offer the rollback"
if grep -qF "$(basename "$OWN_BACKUP")" "$WORK/upgrade-6.log"; then cat "$WORK/upgrade-6.log" >&2; die "the upgrade offered $OWN_BACKUP, which $OLD took of its own data"; fi
(cd "$dir" && docker compose up -d >/dev/null 2>&1) || die "docker compose up -d failed"
wait_ready || die "the rollback does not serve"
stack_on "$OLD"
content_kept
pass "it offers the rollback, not $OLD's own backup, and the rollback serves"

step "6b. $NEXT upgrades the data under the rollback, then ./stuga upgrade $NEXT"
put_release "$dir" "$NEXT"
# compose.yml alone, past the rollback: as a new node left restarting would once it could back up.
(cd "$dir" && docker compose -f compose.yml up -d >/dev/null 2>&1) || die "docker compose -f compose.yml up -d failed"
wait_ready || die "$NEXT does not serve"
[ "$(served)" = "$NEXT" ] || die "node_state.app_version is $(served), not $NEXT"
(cd "$dir" && docker compose up -d >/dev/null 2>&1) || die "docker compose up -d failed"
for _ in $(seq 1 60); do
  if refused; then break; fi
  sleep 1
done
refused || die "$OLD, which the rollback puts back, does not refuse $NEXT's data"
expect 0 upgrade-6b upgrade "$NEXT"
logged upgrade-6b "compose.yml names stuga $NEXT again; it serves." "./stuga upgrade $NEXT did not put $NEXT back"
stack_on "$NEXT"
[ ! -e "$dir/compose.rollback.yml" ] || die "compose.rollback.yml is still there"
grep -q '^COMPOSE_FILE=' "$dir/.env" && die ".env still names COMPOSE_FILE"
ready || die "$NEXT does not serve"
content_kept
pass "./stuga upgrade $NEXT takes the rollback out of the directory and .env, and $NEXT serves"

# ---- 7. a newer release's backup onto an older compose.yml
step "7. A backup $NEWER served, restored onto a stack whose compose.yml names $NEXT"
put_release "$dir" "$NEWER"
expect 0 upgrade-7 upgrade
stack_on "$NEWER"
expect 0 backup-7 backup
NEWER_BACKUP="$(sed -n 's/^Backup complete: //p' "$WORK/backup-7.log")"
[ -n "$NEWER_BACKUP" ] || { cat "$WORK/backup-7.log" >&2; die "./stuga backup named no backup"; }
# By hand, as case 3: a backup NEXT served is pruned by now, and case 1 covers ./stuga upgrade
# putting a release's files back.
put_release "$dir" "$NEXT"
expect 0 restore-7c restore --yes "$NEWER_BACKUP"
stack_on "$NEWER"
logged restore-7c "compose.yml names stuga $NEXT; get matching files with: ./stuga upgrade $NEWER" "the restore did not say how to get $NEWER's files"
expect 2 upgrade-7c upgrade
logged upgrade-7c "compose.yml names stuga $NEXT, older than stuga $NEWER, which last served this data" "the refusal does not say why"
stack_on "$NEWER"
ready || die "$NEWER stopped serving"
content_kept
pass "the restore runs $NEWER, and ./stuga upgrade refuses compose.yml's $NEXT"

# ---- 8. install.sh over a newer release's volume
step "8. install.sh --version $OLD over a volume $NEWER served"
down "$dir"
remove_dir "$dir"
new_dir again
started="$SECONDS"
run_install "$dir" "$OLD" && { cat "$WORK/install-again.log" >&2; die "install.sh succeeded"; }
took=$((SECONDS - started))
logged install-again "Stuga refuses the data here: Stuga $NEWER served it last" "install.sh did not print the refusal"
[ "$took" -le 30 ] || die "install.sh took ${took}s to give up"
pass "install.sh fails after ${took}s and prints the refusal"

step "All eight cases passed"
