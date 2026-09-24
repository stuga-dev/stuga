#!/usr/bin/env bash
# Build the app tree both packagings run, from this checkout:
#
#   packaging/shared/build-app.sh <out-dir> [--version V]
#
# <out-dir> gets services/node (bin, src and production node_modules), apps/web/dist and, with
# --version, VERSION, plus RELEASED when CHANGELOG.md dates that version. The layout mirrors the
# checkout because the node finds its web assets and VERSION three directories above
# services/node/src. Start it with:
#
#   node <out-dir>/services/node/bin/stuga-node.js serve
#
# Build on the OS and architecture the tree runs on: tsx carries a native esbuild binary.
set -euo pipefail

usage() { echo "usage: $0 <out-dir> [--version V]" >&2; exit 2; }

out=""
version=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || usage; version="$2"; shift 2 ;;
    -h | --help) usage ;;
    -*) echo "error: unknown option $1" >&2; usage ;;
    *) [ -z "$out" ] || usage; out="$1"; shift ;;
  esac
done
[ -n "$out" ] || usage
[ ! -e "$out" ] || { echo "error: $out already exists" >&2; exit 1; }
if [ -n "$version" ] && ! printf '%s' "$version" | grep -Eq '^[0-9A-Za-z][0-9A-Za-z.+-]*$'; then
  echo "error: --version takes a version such as 1.2.3, got \"$version\"" >&2
  exit 2
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$(dirname "$out")"
parent="$(cd "$(dirname "$out")" && pwd)"
out="${parent%/}/$(basename "$out")"
cd "$root"

pnpm install --frozen-lockfile
pnpm --filter @stuga/mcp --filter @stuga/web run build
[ -f apps/web/dist/index.html ] || { echo "error: the web build produced no apps/web/dist/index.html" >&2; exit 1; }
[ -f services/mcp/dist/stuga-mcp.js ] || { echo "error: the mcp build produced no services/mcp/dist/stuga-mcp.js" >&2; exit 1; }

# pnpm deploy links one set of bins at the target's path relative to the workspace, resolved from
# services/node instead. Staged under the checkout, that stray copy lands in services/node/<stage>.
stage="$(mktemp -d "$root/.build-app.XXXXXX")"
stray="$root/services/node/$(basename "$stage")"
trap 'rm -rf "$stage" "$stray"' EXIT
pnpm --filter @stuga/node deploy --prod "$stage/services/node"
mkdir -p "$out/services"
mv "$stage/services/node" "$out/services/node"
rm -rf "$stage" "$stray"
node_dir="$out/services/node"

# keep_only <dir> <entry>...: deploy copies every file of a workspace package, local .env files included.
keep_only() {
  local dir="$1" entry keep name wanted
  shift
  for entry in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="$(basename "$entry")"
    keep=no
    for wanted in "$@"; do [ "$name" = "$wanted" ] && keep=yes; done
    [ "$keep" = yes ] || rm -rf "$entry"
  done
}

keep_only "$node_dir" bin src package.json node_modules tsconfig.json
for pkg in "$node_dir"/node_modules/.pnpm/@stuga+*/node_modules/@stuga/*; do
  case "$(basename "$pkg")" in
    mcp) keep_only "$pkg" package.json dist ;;
    *) keep_only "$pkg" package.json src migrations ;;
  esac
  rm -rf "$pkg/src/testing" "$pkg/src/fixtures"
done
find "$node_dir/src" "$node_dir"/node_modules/.pnpm/@stuga+*/node_modules/@stuga \
  -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -delete
# Bin shims name the staging path, and the node never runs one.
find "$node_dir/node_modules" -type d -name .bin -prune -exec rm -rf {} +
[ -f "$node_dir/node_modules/@stuga/mcp/dist/stuga-mcp.js" ] || { echo "error: the deployed tree has no stuga-mcp bundle" >&2; exit 1; }

# The node's tsconfig, which bin/stuga-node.js hands to tsx, extends this.
cp tsconfig.base.json "$out/tsconfig.base.json"
# Stuga's own license, copyright notice and the trademark terms NOTICE points to travel with every copy of the tree.
cp LICENSE NOTICE TRADEMARKS.md "$out/"
mkdir -p "$out/apps/web"
cp -R apps/web/dist "$out/apps/web/dist"
if [ -n "$version" ]; then
  printf '%s\n' "$version" > "$out/VERSION"
  # The day the changelog gives the version. A build of anything else, a CI build included, has none.
  if released="$(node packaging/release/feed.mjs date "$version" 2>/dev/null)"; then
    printf '%s\n' "$released" > "$out/RELEASED"
  fi
fi

echo "app tree at $out (version ${version:-0.0.0-dev, a source build})"
