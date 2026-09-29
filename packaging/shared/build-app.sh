#!/usr/bin/env bash
# Build the app tree both packagings run, from this checkout:
#
#   packaging/shared/build-app.sh <out-dir> [--version V]
#
# <out-dir> gets services/node (bin, the node's bundle in dist and @stuga/mcp's build), apps/web/dist
# and, with --version, VERSION, plus RELEASED when CHANGELOG.md dates that version. The layout
# mirrors the checkout because the node finds its web assets and VERSION three directories above
# services/node/dist. Start it with:
#
#   node <out-dir>/services/node/bin/stuga-node.js serve
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

# The node runs as one bundle (services/node/build.mjs). The only package the tree still carries is
# @stuga/mcp's build, which agent setup resolves through node_modules and the desktop extension packs.
node_dir="$out/services/node"
mkdir -p "$node_dir/node_modules/@stuga/mcp"
cp -R services/node/bin services/node/package.json "$node_dir/"
node services/node/build.mjs "$node_dir"
cp -R services/mcp/package.json services/mcp/dist "$node_dir/node_modules/@stuga/mcp/"

# Stuga's own license, copyright notice and the trademark terms NOTICE points to travel with every copy of the tree.
cp LICENSE NOTICE TRADEMARKS.md "$out/"
# The Stuga skill the agent installers hand out, from its one copy; integrations/ is MIT, so its license goes with it.
mkdir -p "$out/integrations"
cp -R integrations/skills integrations/LICENSE "$out/integrations/"
[ -f "$out/integrations/skills/stuga/SKILL.md" ] || { echo "error: the tree has no integrations/skills/stuga/SKILL.md" >&2; exit 1; }
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
