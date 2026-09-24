#!/usr/bin/env bash
# Lay out the Docker release assets of one version: compose.yml with both images pinned to it,
# env.example, the stuga operator shell and install.sh, which fetches the other three.
#
#   packaging/docker/package.sh <version> <out-dir>
set -euo pipefail

version="${1:-}"
out="${2:-}"
if [ -z "$version" ] || [ -z "$out" ]; then
  echo "usage: $0 <version> <out-dir>" >&2
  exit 2
fi
if ! printf '%s' "$version" | grep -Eq '^[0-9A-Za-z][0-9A-Za-z.+-]*$'; then
  echo "error: \"$version\" is not a version" >&2
  exit 2
fi

here="$(cd "$(dirname "$0")" && pwd)"
placeholder="0.0.0-dev"
mkdir -p "$out"
sed "s|^\(    image: [^ ]*/stuga-[a-z]*\):$placeholder\$|\1:$version|" "$here/compose.yml" > "$out/compose.yml"
cp "$here/env.example" "$out/env.example"
cp "$here/stuga" "$out/stuga"
cp "$here/install.sh" "$out/install.sh"
chmod +x "$out/stuga" "$out/install.sh"

# A substitution that matches nothing is silent, and would ship a file naming images that do not exist.
pinned="$(grep -Ec "^    image: [^ ]*/stuga-(node|postgres):$version\$" "$out/compose.yml" || true)"
[ "$pinned" = 2 ] || { echo "error: compose.yml does not pin both images to $version" >&2; exit 1; }
if [ "$version" != "$placeholder" ] && grep -q ":$placeholder" "$out/compose.yml"; then
  echo "error: compose.yml still names $placeholder" >&2
  exit 1
fi
if grep -qE '^[[:space:]]+build:' "$out/compose.yml"; then
  echo "error: compose.yml builds from source" >&2
  exit 1
fi
docker compose -f "$out/compose.yml" config -q
