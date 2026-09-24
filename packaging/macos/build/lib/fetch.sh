# shellcheck shell=bash
# Sourced after packaging/versions.env. Downloads, and the Postgres tree assembled from them,
# are cached in $STUGA_MACOS_CACHE.
#
# Every input is a release asset its publisher can replace in place, so the
# checksum in versions.env is the pin, not the version in the URL; a cached file
# is re-verified on every use.

STUGA_MACOS_CACHE="${STUGA_MACOS_CACHE:-${TMPDIR:-/tmp}/stuga-macos-downloads}"

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# fetch <url> <sha256>: prints the path of a verified copy in the cache.
fetch() {
  local url="$1" sha="$2" file
  mkdir -p "$STUGA_MACOS_CACHE" || return 1
  file="$STUGA_MACOS_CACHE/$(basename "$url")"
  if [ -f "$file" ] && [ "$(sha256_of "$file")" = "$sha" ]; then
    printf '%s' "$file"
    return 0
  fi
  # Command substitution does not inherit errexit in bash 3.2, so every step returns on failure.
  curl -fL --retry 3 -sS -o "$file.part" "$url" || return 1
  if [ "$(sha256_of "$file.part")" != "$sha" ]; then
    rm -f "$file.part"
    echo "error: $(basename "$url") does not match its pinned sha256" >&2
    return 1
  fi
  mv "$file.part" "$file" || return 1
  printf '%s' "$file"
}

postgres_app_url() {
  printf 'https://github.com/PostgresApp/PostgresApp/releases/download/v%s/Postgres-%s-%s.dmg' \
    "$POSTGRES_APP_VERSION" "$POSTGRES_APP_VERSION" "$PG_MAJOR"
}

pg_search_pkg_url() {
  printf 'https://github.com/paradedb/paradedb/releases/download/v%s/pg_search-pg%s-%s.pkg' \
    "$PG_SEARCH_VERSION" "$PG_MAJOR" "$PG_SEARCH_VERSION"
}

node_darwin_arm64_url() {
  printf 'https://nodejs.org/dist/v%s/node-v%s-darwin-arm64.tar.gz' "$NODE_VERSION" "$NODE_VERSION"
}

# cached_postgres_tree: prints the path of an assembled Postgres tree for the current pins,
# assembling it on first use. Keyed by the input checksums, so a re-pinned asset rebuilds.
cached_postgres_tree() {
  local lib key tree
  lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || return 1
  key="$(printf '%s %s' "$POSTGRES_APP_DMG_SHA256" "$PG_SEARCH_POSTGRESAPP_PKG_SHA256" | shasum -a 256 | cut -c1-12)"
  tree="$STUGA_MACOS_CACHE/postgres-$PG_MAJOR-$key"
  if [ ! -x "$tree/bin/postgres" ]; then
    rm -rf "$tree" "$tree.partial" || return 1
    "$lib/../assemble-postgres.sh" "$tree.partial" >&2 || return 1
    mv "$tree.partial" "$tree" || return 1
  fi
  printf '%s' "$tree"
}
