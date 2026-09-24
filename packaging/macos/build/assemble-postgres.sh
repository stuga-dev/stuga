#!/usr/bin/env bash
# Assemble the Postgres tree the Mac node runs: Postgres.app's Contents/Versions/<major>,
# pruned, with ParadeDB's pg_search added. Nothing is compiled.
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
pkg="$(fetch "$(pg_search_pkg_url)" "$PG_SEARCH_POSTGRESAPP_PKG_SHA256")"
echo "verified $(basename "$dmg") and $(basename "$pkg")"

mkdir -p "$mnt"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mnt" "$dmg"
attached=yes
# ditto, not cp: it keeps the symlinks between dylib versions as symlinks.
ditto "$mnt/Postgres.app/Contents/Versions/$PG_MAJOR" "$out"
hdiutil detach -quiet "$mnt"
attached=no

"$here/prune.sh" "$out"

# The pkg's payload has the tree's own lib/postgresql and share/postgresql/extension shape;
# its preinstall script only clears Postgres.app's per-extension directory.
pkgutil --expand-full "$pkg" "$work/pg_search"
payload="$(find "$work/pg_search" -type d -name Payload -path "*pg_search-$PG_MAJOR.pkg*" | head -1)"
[ -f "$payload/lib/postgresql/pg_search.dylib" ] || { echo "error: no pg_search.dylib in $pkg" >&2; exit 1; }
ditto "$payload/lib/postgresql/pg_search.dylib" "$out/lib/postgresql/pg_search.dylib"
ditto "$payload/share/postgresql/extension" "$out/share/postgresql/extension"

"$here/check-tree.sh" "$out"
