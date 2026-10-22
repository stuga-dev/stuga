#!/usr/bin/env bash
# Assemble the Postgres tree the Mac node runs: Postgres.app's Contents/Versions/<major>, pruned.
# Nothing is compiled.
#
#   packaging/macos/build/assemble-postgres.sh <out-dir>
#
# <out-dir> must not exist. Versions and checksums come from packaging/versions.env;
# downloads are cached in $STUGA_MACOS_CACHE.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../versions.env
. "$here/../../versions.env"
# shellcheck source=lib/fetch.sh
. "$here/lib/fetch.sh"

out="${1:-}"
[ -n "$out" ] || { echo "usage: $0 <out-dir>" >&2; exit 2; }
[ ! -e "$out" ] || { echo "error: $out already exists" >&2; exit 1; }

work="$(mktemp -d)"
mnt="$work/mnt"
attached=no
# Detach before removing: rm -rf across a still-attached image walks every file on it and
# then fails on the busy mountpoint. A flag, because `mount` prints /private/var for /var.
cleanup() {
  if [ "$attached" = yes ]; then
    hdiutil detach -quiet "$mnt" || hdiutil detach -quiet -force "$mnt" || {
      echo "error: could not detach $mnt; leaving $work in place" >&2
      return
    }
  fi
  rm -rf "$work"
}
trap cleanup EXIT

dmg="$(fetch "$(postgres_app_url)" "$POSTGRES_APP_DMG_SHA256")"
echo "verified $(basename "$dmg")"

mkdir -p "$mnt"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mnt" "$dmg"
attached=yes
# ditto, not cp: it keeps the symlinks between dylib versions as symlinks.
ditto "$mnt/Postgres.app/Contents/Versions/$PG_MAJOR" "$out"
hdiutil detach -quiet "$mnt"
attached=no

"$here/prune.sh" "$out"

"$here/check-tree.sh" "$out"
