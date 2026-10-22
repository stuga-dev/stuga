# shellcheck shell=bash
# The Mac runtime's component list, conf/components.cdx.json (CycloneDX 1.6): what it carries, at
# the versions the files themselves state. No scanner reads the native libraries, so the daily watch
# compares this list with upstream releases, and each release publishes it as
# stuga-runtime-<version>.cdx.json. Sourced by build-runtime.sh and check-tree.sh, after
# packaging/versions.env. Tested by packaging/macos/test/components.test.mjs.

# dylib_component <file name>: the component a library in postgres/lib belongs to; nothing, and 1,
# for one this list does not name, which check-tree.sh refuses.
dylib_component() {
  case "$1" in
    libpq.* | libecpg.* | libecpg_compat.* | libpgtypes.*) echo postgresql ;;
    libssl.* | libcrypto.*) echo openssl ;;
    libicu*) echo icu ;;
    libxml2.*) echo libxml2 ;;
    libxslt.* | libexslt.*) echo libxslt ;;
    liblz4.*) echo lz4 ;;
    libzstd.*) echo zstd ;;
    *) return 1 ;;
  esac
}

# one_match <what> <regex>: the single line of stdin matching <regex>; fails on none or several.
one_match() {
  local found
  found="$(grep -E "$2" | sort -u)" || true
  if [ -z "$found" ] || [ "$(printf '%s\n' "$found" | wc -l | tr -d ' ')" != 1 ]; then
    echo "error: cannot read the version of $1 (found: ${found:-nothing})" >&2
    return 1
  fi
  printf '%s' "$found"
}

# file_version <lib dir> <prefix>: the version in a library's file name, libzstd.1.5.7.dylib -> 1.5.7.
file_version() {
  local f
  for f in "$1/$2".*.dylib; do printf '%s\n' "${f##*/}"; done \
    | sed -n "s/^$2\\.\\([0-9][0-9.]*[0-9]\\)\\.dylib\$/\\1/p" | one_match "$2" '\.'
}

# packed_version <number>: libxml2 and libxslt state 2.15.3 as 21503.
packed_version() { printf '%d.%d.%d' "${1:0:1}" "$((10#${1:1:2}))" "$((10#${1:3:2}))"; }

# component <name> <version> <purl> [source]: one entry; a version that is not one is refused.
component() {
  local name="$1" version="$2" purl="$3" source="${4:-}"
  if [ -n "$version" ] && ! printf '%s' "$version" | grep -Eq '^[0-9][0-9A-Za-z.+-]*$'; then
    echo "error: $name's version \"$version\" is not a version" >&2
    return 1
  fi
  local type=library
  case "$name" in node | postgres.app | postgresql | frpc) type=application ;; esac
  printf '    {"type": "%s", "bom-ref": "%s", "name": "%s"' "$type" "$name" "$name"
  [ -z "$version" ] || printf ', "version": "%s"' "$version"
  [ -z "$purl" ] || printf ', "purl": "%s"' "$purl"
  [ -z "$source" ] || printf ', "properties": [{"name": "stuga:built-by", "value": "%s"}]' "$source"
  printf '}\n'
}

# write_components <runtime dir> <version> [connector sha256]: the list, on stdout. Fails when a
# version cannot be read, so the list never names a library without one.
write_components() {
  local version="$2" connector="${3:-}" pg="$1/postgres" lib="$1/postgres/lib" app
  local postgres openssl xml xslt icu lz4 zstd vector
  app="Postgres.app $POSTGRES_APP_VERSION"
  postgres="$("$pg/bin/postgres" --version | sed -n 's/^postgres (PostgreSQL) \([0-9][0-9.]*\).*/\1/p')" || return 1
  [ -n "$postgres" ] || { echo "error: cannot read the PostgreSQL version" >&2; return 1; }
  openssl="$(LC_ALL=C strings -a "$lib/libcrypto.3.dylib" | sed -n 's/^OpenSSL \([0-9][0-9.]*[a-z]*\) .*/\1/p' \
    | one_match OpenSSL '.')" || return 1
  xml="$(LC_ALL=C strings -a "$lib"/libxml2.*.dylib | one_match libxml2 '^2[0-9]{4}$')" || return 1
  xslt="$(LC_ALL=C strings -a "$lib"/libxslt.*.dylib | one_match libxslt '^1[0-9]{4}$')" || return 1
  icu="$(file_version "$lib" libicuuc)" || return 1
  lz4="$(file_version "$lib" liblz4)" || return 1
  zstd="$(file_version "$lib" libzstd)" || return 1
  vector="$(sed -n "s/^default_version = '\(.*\)'$/\1/p" "$pg/share/postgresql/extension/vector.control")"
  local f
  for f in wal2json.dylib plugin_debugger.dylib; do
    [ -f "$lib/postgresql/$f" ] || { echo "error: $lib/postgresql/$f is missing" >&2; return 1; }
  done

  printf '{\n  "bomFormat": "CycloneDX",\n  "specVersion": "1.6",\n  "version": 1,\n'
  printf '  "metadata": {"component": {"type": "application", "bom-ref": "stuga-runtime", "name": "stuga-runtime", "version": "%s"}},\n' "$version"
  printf '  "components": [\n'
  {
    component node "$NODE_VERSION" "pkg:generic/node@$NODE_VERSION"
    component postgres.app "$POSTGRES_APP_VERSION" "pkg:github/postgresapp/postgresapp@v$POSTGRES_APP_VERSION"
    component postgresql "$postgres" "pkg:generic/postgresql@$postgres" "$app"
    component pgvector "$vector" "pkg:github/pgvector/pgvector@v$vector" "$app"
    component wal2json "" "" "$app"
    component pldbgapi "" "" "$app"
    component openssl "$openssl" "pkg:generic/openssl@$openssl" "$app"
    component icu "$icu" "pkg:generic/icu@$icu" "$app"
    component libxml2 "$(packed_version "$xml")" "pkg:generic/libxml2@$(packed_version "$xml")" "$app"
    component libxslt "$(packed_version "$xslt")" "pkg:generic/libxslt@$(packed_version "$xslt")" "$app"
    component lz4 "$lz4" "pkg:generic/lz4@$lz4" "$app"
    component zstd "$zstd" "pkg:generic/zstd@$zstd" "$app"
    component frpc "$FRP_VERSION" "pkg:golang/github.com/fatedier/frp@v$FRP_VERSION" "Go $GO_VERSION"
  } | sed '$!s/$/,/'
  printf '  ]'
  [ -z "$connector" ] || printf ',\n  "properties": [{"name": "stuga:connector-sha256", "value": "%s"}]' "$connector"
  printf '\n}\n'
}
