#!/usr/bin/env bash
# Build a Mac runtime: <out>/runtime/<version>/{postgres,node,app,bin,conf}.
#
#   packaging/macos/build/build-runtime.sh --out <dir> --version <v>
#       [--postgres-tree <dir>] [--app-link <checkout>]
#
#   postgres   an assembled Postgres tree (cached in $STUGA_MACOS_CACHE), or a copy of
#              --postgres-tree, pruned and checked
#   node       the pinned official Node for darwin-arm64, without npm, corepack or headers
#   app        packaging/shared/build-app.sh --version <v>, or with --app-link a symlink to a
#              built checkout (no VERSION file: the node reports a source build)
#   bin        the launchd wrappers, init-cluster.sh, rotate-log.mjs and the upgrade helper
#   conf       the Postgres configuration templates and versions.env
#   THIRD-PARTY-NOTICES.txt   the licenses of everything the runtime redistributes
#
# An existing runtime of the same version is replaced; nothing may be running from it.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
macos="$(cd "$here/.." && pwd)"
# shellcheck source=../../versions.env
. "$macos/../versions.env"
# shellcheck source=lib/fetch.sh
. "$here/lib/fetch.sh"

usage() { sed -n '4,5p' "$0" | sed 's/^# \{0,3\}//' >&2; exit 2; }

out="" version="" postgres_tree="" app_link=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --postgres-tree) postgres_tree="${2:-}"; shift 2 ;;
    --app-link) app_link="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
if [ -z "$out" ] || [ -z "$version" ]; then usage; fi
if ! printf '%s' "$version" | grep -Eq '^[0-9A-Za-z][0-9A-Za-z.+-]*$'; then
  echo "error: --version takes a version such as 1.2.3, got \"$version\"" >&2
  exit 2
fi
[ "$(uname -m)" = arm64 ] || { echo "error: the Mac runtime is built for Apple silicon only" >&2; exit 1; }

say() { printf '==> %s\n' "$*"; }

mkdir -p "$out/runtime"
out="$(cd "$out" && pwd)"
target="$out/runtime/$version"
staging="$out/runtime/.$version.partial"
rm -rf "$staging"
mkdir -p "$staging/bin" "$staging/conf"
trap 'rm -rf "$staging"' EXIT

say "postgres"
if [ -z "$postgres_tree" ]; then
  postgres_tree="$(cached_postgres_tree)"
fi
[ -x "$postgres_tree/bin/postgres" ] || { echo "error: no Postgres tree at $postgres_tree" >&2; exit 1; }
ditto "$postgres_tree" "$staging/postgres"
"$here/prune.sh" "$staging/postgres"
"$here/check-tree.sh" "$staging/postgres"

say "node $NODE_VERSION"
tarball="$(fetch "$(node_darwin_arm64_url)" "$NODE_DARWIN_ARM64_SHA256")"
mkdir -p "$staging/node"
tar -xzf "$tarball" -C "$staging/node" --strip-components 1
rm -rf "$staging/node/include" "$staging/node/share" "$staging/node/lib" "$staging/node/CHANGELOG.md" \
  "$staging/node/README.md" "$staging/node/bin/npm" "$staging/node/bin/npx" "$staging/node/bin/corepack"
[ "$("$staging/node/bin/node" --version)" = "v$NODE_VERSION" ] || { echo "error: the unpacked node is not v$NODE_VERSION" >&2; exit 1; }

if [ -n "$app_link" ]; then
  app_link="$(cd "$app_link" && pwd)"
  say "app: a link to $app_link"
  for built in services/node/bin/stuga-node.js apps/web/dist/index.html services/mcp/dist/stuga-mcp.js; do
    [ -f "$app_link/$built" ] || { echo "error: $app_link has no $built; build the checkout first (pnpm install && pnpm build)" >&2; exit 1; }
  done
  ln -s "$app_link" "$staging/app"
else
  say "app $version"
  "$macos/../shared/build-app.sh" "$staging/app" --version "$version"
fi

cp "$macos/runtime/bin/postgres-wrapper.sh" "$macos/runtime/bin/node-wrapper.sh" \
  "$macos/runtime/bin/init-cluster.sh" "$macos/runtime/bin/rotate-log.mjs" "$macos/runtime/bin/helper.sh" \
  "$macos/runtime/bin/uninstall.sh" "$staging/bin/"
cp "$macos/runtime/conf/postgresql.conf" "$macos/runtime/conf/pg_hba.conf" \
  "$macos/runtime/conf/pg_ident.conf" "$macos/../versions.env" "$staging/conf/"
sed -e "s/@PG_MAJOR@/$PG_MAJOR/g" -e "s/@POSTGRES_APP_VERSION@/$POSTGRES_APP_VERSION/g" \
  -e "s/@PG_SEARCH_VERSION@/$PG_SEARCH_VERSION/g" -e "s/@NODE_VERSION@/$NODE_VERSION/g" \
  "$macos/runtime/THIRD-PARTY-NOTICES.txt.in" > "$staging/THIRD-PARTY-NOTICES.txt"
if grep -q '@[A-Z_]*@' "$staging/THIRD-PARTY-NOTICES.txt"; then
  echo "error: THIRD-PARTY-NOTICES.txt.in names a pin build-runtime.sh does not fill in" >&2
  exit 1
fi

rm -rf "$target"
mv "$staging" "$target"
trap - EXIT
say "runtime at $target"
