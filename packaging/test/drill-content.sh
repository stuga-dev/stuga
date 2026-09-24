#!/usr/bin/env bash
# The restore drill, on any platform: put one of each kind of state a node keeps into it over the
# HTTP API, back up, lose the Postgres cluster and the data directory, restore, and prove it all
# came back. Each packaging supplies the commands:
#
#   packaging/test/drill-content.sh --url <node base url> --setup-code <cmd> \
#     --backup <cmd> [--verify <cmd>] --stop <cmd> --wipe <cmd> --restore <cmd> --start <cmd> [--list <cmd>]
#
#   --setup-code  print the new node's setup code, which its first account needs
#   --backup   back up with the platform's own command and leave the node serving; its output has
#              stuga-node's "Backup complete: <path>" line
#   --verify   check that backup
#   --stop     stop the node
#   --wipe     replace the Postgres cluster with an empty running one, empty the data directory, and
#              fail unless both are empty
#   --restore  restore the backup
#   --start    start the node if --restore did not
#   --list     print what the restore kept; it must name the replaced data directory and database
#
# Commands run under bash from the caller's directory; every one after --backup sees the backup's
# path as DRILL_BACKUP. The node must accept a first account (a new node does, with its setup code).
set -euo pipefail

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0" >&2; exit 2; }

URL="" HOOK_SETUP_CODE="" HOOK_BACKUP="" HOOK_VERIFY="" HOOK_STOP="" HOOK_WIPE="" HOOK_RESTORE="" HOOK_START="" HOOK_LIST=""
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || usage
  case "$1" in
    --url) URL="${2%/}" ;;
    --setup-code) HOOK_SETUP_CODE="$2" ;;
    --backup) HOOK_BACKUP="$2" ;;
    --verify) HOOK_VERIFY="$2" ;;
    --stop) HOOK_STOP="$2" ;;
    --wipe) HOOK_WIPE="$2" ;;
    --restore) HOOK_RESTORE="$2" ;;
    --start) HOOK_START="$2" ;;
    --list) HOOK_LIST="$2" ;;
    *) usage ;;
  esac
  shift 2
done
for required in "$URL" "$HOOK_SETUP_CODE" "$HOOK_BACKUP" "$HOOK_STOP" "$HOOK_WIPE" "$HOOK_RESTORE" "$HOOK_START"; do
  [ -n "$required" ] || usage
done

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\033[31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# hook <name> <command>: output goes to $WORK/<name>.log and is shown when the command fails.
hook() {
  if ! bash -c "$2" > "$WORK/$1.log" 2>&1; then
    printf -- '--- %s output ---\n' "$1" >&2
    cat "$WORK/$1.log" >&2
    die "the $1 command failed: $2"
  fi
}

api() { # api METHOD PATH [json body] [bearer token]
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local args=(-sS -X "$method" "$URL$path" -H 'content-type: application/json')
  if [ -n "$token" ]; then args+=(-H "authorization: Bearer $token"); fi
  if [ -n "$body" ]; then args+=(-d "$body"); fi
  curl "${args[@]}"
}

jsonfield() { # jsonfield KEY: the first string value of KEY on stdin
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
}

wait_ready() { # wait_ready SECONDS
  for _ in $(seq 1 "$1"); do
    if curl -fsS --max-time 5 -o /dev/null "$URL/ready" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

found_by_search() { # found_by_search TOKEN
  api POST /api/search "{\"q\":\"$MARKER\"}" "$1" | grep -q "\"doc_id\":\"$DOC\""
}

# fetch_image TOKEN OUT_HEADERS OUT_BODY: media is read with the ticket cookie, as a browser reads it.
fetch_image() {
  curl -sS -c "$WORK/jar" -o /dev/null "$URL/api/media/ticket" -H "authorization: Bearer $1"
  curl -sS -b "$WORK/jar" -D "$2" -o "$3" "$URL$IMAGE_URL"
}

wait_ready 180 || die "the node at $URL is not ready"

step "Creating content"
hook setup-code "$HOOK_SETUP_CODE"
SETUP_CODE="$(tr -d '[:space:]' < "$WORK/setup-code.log")"
[ -n "$SETUP_CODE" ] || die "the setup-code command printed nothing"
TOKEN="$(api POST /auth/register "{\"username\":\"drill\",\"password\":\"correct horse battery\",\"name\":\"Drill\",\"setup_code\":\"$SETUP_CODE\"}" | jsonfield access_token)"
[ -n "$TOKEN" ] || die "could not register the first account"
pass "account created"

WS="$(api POST /api/workspaces '{"name":"Drill Workspace"}' "$TOKEN" | jsonfield workspace_id)"
[ -n "$WS" ] || die "could not create a workspace"
pass "workspace $WS"

MARKER="the-quick-brown-fox-$(date -u +%s)"
DOC="$(api POST /api/docs "{\"title\":\"Drill Document\",\"markdown\":\"# Drill Document\\n\\n$MARKER\"}" "$TOKEN" | jsonfield doc_id)"
[ -n "$DOC" ] || die "could not create a document"
pass "document $DOC containing $MARKER"

# The actor flushes the body after the POST returns. Checking it before the backup is what lets a
# missing body after the restore mean the restore lost it.
for _ in $(seq 1 30); do
  if api GET "/api/docs/$DOC/markdown" "" "$TOKEN" | grep -q "$MARKER"; then break; fi
  sleep 1
done
api GET "/api/docs/$DOC/markdown" "" "$TOKEN" | grep -q "$MARKER" \
  || die "the document body never became readable, before any backup was taken"
pass "body is readable and contains the marker"

# Indexing follows the actor's 30-second flush timer and the job worker's poll.
for _ in $(seq 1 90); do
  if found_by_search "$TOKEN"; then break; fi
  sleep 1
done
found_by_search "$TOKEN" || die "a keyword search for the marker never found the document, before any backup was taken"
pass "a keyword search for the marker finds the document"

api GET "/api/docs/$DOC/markdown" "" "$TOKEN" | jsonfield markdown > "$WORK/body.before"
[ -s "$WORK/body.before" ] || die "could not read the document's markdown"

printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' \
  | base64 -d > "$WORK/image.png"
IMAGE_URL="$(curl -sS -X POST "$URL/api/docs/$DOC/media" -H "authorization: Bearer $TOKEN" -F "file=@$WORK/image.png;type=image/png" | jsonfield url)"
[ -n "$IMAGE_URL" ] || die "could not upload an image"
fetch_image "$TOKEN" "$WORK/image-headers.before" "$WORK/image.before"
grep -qi '^content-type: image/png' "$WORK/image-headers.before" || die "the uploaded image is not served as image/png, before any backup was taken"
cmp -s "$WORK/image.png" "$WORK/image.before" || die "the uploaded image does not read back, before any backup was taken"
pass "an image is stored and served as image/png"

TABLE_DB="$(api POST /api/docs '{"title":"Drill Table","doc_type":"database"}' "$TOKEN" | jsonfield doc_id)"
[ -n "$TABLE_DB" ] || die "could not create a database"
TABLE_RES="$(api POST "/api/databases/$TABLE_DB/tables" '{"display":"Items","columns":[{"name":"Name","type":"text"}]}' "$TOKEN")"
TABLE="$(printf '%s' "$TABLE_RES" | jsonfield table_id)"
[ -n "$TABLE" ] || die "could not create a table: $TABLE_RES"
ROW_RES="$(api POST "/api/databases/$TABLE_DB/tables/$TABLE/rows" "{\"rows\":[{\"Name\":\"row-$MARKER\"}]}" "$TOKEN")"
api POST "/api/databases/$TABLE_DB/tables/$TABLE/rows/list" '{}' "$TOKEN" | grep -q "row-$MARKER" \
  || die "the database row did not read back, before any backup was taken (insert said: $ROW_RES)"
pass "a database table has a row"

step "Backing up"
hook backup "$HOOK_BACKUP"
DRILL_BACKUP="$(sed -n 's/^Backup complete: //p' "$WORK/backup.log" | tail -1)"
[ -n "$DRILL_BACKUP" ] || { cat "$WORK/backup.log" >&2; die "the backup command did not say where the backup is"; }
export DRILL_BACKUP
wait_ready 60 || die "the node did not come back after the backup"
pass "backup at $DRILL_BACKUP; the node is serving again"
if [ -n "$HOOK_VERIFY" ]; then
  hook verify "$HOOK_VERIFY"
  pass "verify accepts it"
fi

step "Losing everything"
hook stop "$HOOK_STOP"
hook wipe "$HOOK_WIPE"
pass "the Postgres cluster was replaced by an empty one and the data directory emptied"

step "Restoring"
hook restore "$HOOK_RESTORE"
hook start "$HOOK_START"
wait_ready 300 || die "the node did not become ready after the restore"
pass "restored, and the node is ready"

step "Checking the content came back"
# Only the restored signing key verifies a token issued before the backup.
api GET "/api/docs/$DOC" "" "$TOKEN" | grep -q "Drill Document" \
  || die "a token issued before the backup is refused — the signing key did not survive (or the document is gone)"
pass "the signing key survived: a token from before the backup still works"

TOKEN2="$(api POST /auth/login '{"username":"drill","password":"correct horse battery"}' | jsonfield access_token)"
[ -n "$TOKEN2" ] || die "could not sign in after the restore — the account did not survive"
pass "the account survived"

# The document's actor is cold after a restore and rehydrates from the restored snapshot.
for _ in $(seq 1 30); do
  if api GET "/api/docs/$DOC/markdown" "" "$TOKEN2" | grep -q "$MARKER"; then break; fi
  sleep 1
done
api GET "/api/docs/$DOC/markdown" "" "$TOKEN2" | grep -q "$MARKER" \
  || die "the document came back EMPTY — the row survived but its body did not (blob store or actor state)"
api GET "/api/docs/$DOC/markdown" "" "$TOKEN2" | jsonfield markdown > "$WORK/body.after"
cmp -s "$WORK/body.before" "$WORK/body.after" || die "the document's body came back different"
pass "its body survived, byte for byte"

fetch_image "$TOKEN2" "$WORK/image-headers.after" "$WORK/image.after"
grep -qi '^content-type: image/png' "$WORK/image-headers.after" \
  || die "the image is no longer served as image/png — its blob or its sidecar did not survive"
cmp -s "$WORK/image.png" "$WORK/image.after" || die "the image came back different"
pass "the image survived, with its content type"

api POST "/api/databases/$TABLE_DB/tables/$TABLE/rows/list" '{}' "$TOKEN2" | grep -q "row-$MARKER" \
  || die "the database table row is gone — the database actor's store did not survive"
pass "the database table row survived"

# Every check above reads by id; only a search reads the pg_search extension and BM25 indexes.
found_by_search "$TOKEN2" || die "a keyword search for the marker no longer finds the document — the search indexes did not survive the restore"
pass "keyword search finds it"

if [ -n "$HOOK_LIST" ]; then
  hook list "$HOOK_LIST"
  grep -q "replaced data directory" "$WORK/list.log" || die "the restore did not keep the data directory it replaced"
  grep -q "replaced database" "$WORK/list.log" || die "the restore did not keep the database it replaced"
  pass "what the restore replaced is kept, both halves"
fi

printf '\n\033[32mDrill passed\033[0m — content created before a total loss was there after the restore.\n'
