#!/usr/bin/env bash
# Fail when a pin outside packaging/versions.env disagrees with it: .nvmrc, the root package.json's
# packageManager, @types/node (package.json and its pnpm-workspace.yaml override), every Dockerfile
# ARG default named in versions.env, and the Postgres major the node's preflight accepts.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
# shellcheck source=versions.env
. packaging/versions.env

failures=0
mismatch() { echo "pin mismatch: $1" >&2; failures=$((failures + 1)); }

required=(NODE_VERSION NODE_DARWIN_ARM64_SHA256 PNPM_VERSION PG_MAJOR PGVECTOR_VERSION PG_SEARCH_VERSION
  PG_SEARCH_DEB_AMD64_SHA256 PG_SEARCH_DEB_ARM64_SHA256 PG_SEARCH_POSTGRESAPP_PKG_SHA256 POSTGRES_APP_VERSION
  POSTGRES_APP_DMG_SHA256 DEBIAN_SUITE PGDG_KEY_SHA256 INITDB_ARGS)
for key in "${required[@]}"; do
  [ -n "${!key:-}" ] || mismatch "versions.env does not set $key"
done
for key in NODE_DARWIN_ARM64_SHA256 PG_SEARCH_DEB_AMD64_SHA256 PG_SEARCH_DEB_ARM64_SHA256 \
  PG_SEARCH_POSTGRESAPP_PKG_SHA256 POSTGRES_APP_DMG_SHA256 PGDG_KEY_SHA256; do
  printf '%s' "${!key:-}" | grep -Eq '^[0-9a-f]{64}$' || mismatch "$key is not a sha256"
done

node_major="${NODE_VERSION%%.*}"

nvmrc="$(tr -d '[:space:]' < .nvmrc)"
[ "$nvmrc" = "$NODE_VERSION" ] || [ "$nvmrc" = "$node_major" ] \
  || mismatch ".nvmrc is $nvmrc, versions.env NODE_VERSION is $NODE_VERSION"

manager="$(sed -n 's/^  "packageManager": "\(.*\)",$/\1/p' package.json)"
[ "$manager" = "pnpm@$PNPM_VERSION" ] || mismatch "package.json packageManager is $manager, versions.env PNPM_VERSION is $PNPM_VERSION"

types="$(sed -n 's/.*"@types\/node": "[~^]\{0,1\}\([0-9]*\)\..*/\1/p' package.json pnpm-workspace.yaml | sort -u)"
[ -n "$types" ] || mismatch "package.json pins no @types/node"
for major in $types; do
  [ "$major" = "$node_major" ] || mismatch "package.json pins @types/node $major.x, versions.env NODE_VERSION is $NODE_VERSION"
done

# arg_defaults <Dockerfile>: NAME<TAB>value for every ARG with a default, quotes removed.
arg_defaults() {
  sed -n 's/^ARG \([A-Z0-9_]*\)=\(.*\)$/\1	\2/p' "$1" | sed 's/	"\(.*\)"$/	\1/'
}

for dockerfile in packaging/docker/node.Dockerfile packaging/docker/postgres.Dockerfile; do
  seen=0
  while IFS="$(printf '\t')" read -r name value; do
    if [ -n "${!name+set}" ] && printf '%s\n' "${required[@]}" | grep -qx "$name"; then
      seen=$((seen + 1))
      [ "$value" = "${!name}" ] || mismatch "$dockerfile ARG $name=$value, versions.env has ${!name}"
    fi
  done < <(arg_defaults "$dockerfile")
  [ "$seen" -gt 0 ] || mismatch "$dockerfile has no ARG default named in versions.env"
done

grep -q "^export const PG_MIN = ${PG_MAJOR}0000;" services/node/src/boot/preflight.ts \
  || mismatch "services/node/src/boot/preflight.ts does not accept Postgres $PG_MAJOR as PG_MIN"

if [ "$failures" -gt 0 ]; then
  echo "$failures pin(s) disagree with packaging/versions.env" >&2
  exit 1
fi
echo "every pin agrees with packaging/versions.env"
