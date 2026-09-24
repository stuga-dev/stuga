#!/usr/bin/env bash
# Re-sign every Mach-O in a Postgres tree with one identity, hardened runtime on.
#
#   packaging/macos/build/sign.sh --identity "Developer ID Application: <Name> (<TEAMID>)" <tree>
#   packaging/macos/build/sign.sh --dry-run <tree>
#
# Each file gets `codesign --force --sign <identity> --options runtime --timestamp` and no
# entitlements, which drops Postgres.app's disable-library-validation: with one team and
# hardened runtime, library validation makes postgres load only libraries signed here.
# Afterwards every file must verify --strict, carry the runtime flag and the identity's
# team, and have no entitlements.
#
# Any code-signing identity works for trying the signed tree locally; only a Developer ID
# Application certificate can be notarized. Only a Postgres tree is accepted: Node needs
# allow-jit under hardened runtime, which this script never adds.
#
# Universal files are signed in every slice. Thin them (lipo -thin) before signing, if at
# all: that invalidates a signature.
set -euo pipefail

identity=""
dry_run=no
tree=""
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) identity="${2:-}"; shift 2 ;;
    --identity=*) identity="${1#--identity=}"; shift ;;
    --dry-run) dry_run=yes; shift ;;
    -h | --help) sed -n '2,6p' "$0"; exit 0 ;;
    -*) echo "error: unknown option $1" >&2; exit 2 ;;
    *) [ -z "$tree" ] || { echo "error: one tree at a time" >&2; exit 2; }; tree="$1"; shift ;;
  esac
done

[ -n "$tree" ] || { echo "usage: $0 --identity \"Developer ID Application: Name (TEAMID)\" <tree> | --dry-run <tree>" >&2; exit 2; }
[ -d "$tree" ] || { echo "error: $tree is not a directory" >&2; exit 2; }
if [ ! -x "$tree/bin/postgres" ] || [ ! -f "$tree/lib/postgresql/pg_search.dylib" ]; then
  echo "error: $tree is not a Postgres tree (no bin/postgres or lib/postgresql/pg_search.dylib); this script signs only that" >&2
  exit 2
fi
if [ "$dry_run" = no ] && [ -z "$identity" ]; then
  echo "error: --identity is required (a code-signing certificate's full name in the keychain, or its SHA-1)" >&2
  exit 2
fi

team=""
if [ "$dry_run" = no ]; then
  identities="$(security find-identity -v -p codesigning)"
  if ! printf '%s' "$identities" | grep -qF "$identity"; then
    echo "error: no valid code-signing identity matching \"$identity\" in the keychain (security find-identity -v -p codesigning)" >&2
    exit 1
  fi
  # A signature carries the certificate's OU as its team. The code in parentheses in the
  # name is the team only for Developer ID; for Apple Development it is the member's ID.
  cert_name="$identity"
  case "$identity" in
    *[!0-9A-Fa-f]*) ;;
    *) cert_name="$(printf '%s\n' "$identities" | awk -v h="$identity" 'toupper($2) == toupper(h) { sub(/^[^"]*"/, ""); sub(/"$/, ""); print; exit }')" ;;
  esac
  team="$(security find-certificate -c "$cert_name" -p 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*OU *= *\([A-Z0-9]*\).*/\1/p' | head -1 || true)"
  if [ -z "$team" ]; then
    echo "error: could not read the team (the certificate subject's OU) of \"$identity\"" >&2
    exit 1
  fi
  echo "signing as \"$cert_name\", team $team"
fi

libraries=()
executables=()
archives=()
while IFS= read -r -d '' file; do
  kind="$(file -b "$file")"
  case "$kind" in
    *"ar archive"*) archives+=("$file") ;;
    *"Mach-O"*"dynamically linked shared library"* | *"Mach-O"*"bundle"*) libraries+=("$file") ;;
    *"Mach-O"*) executables+=("$file") ;;
  esac
done < <(find "$tree" -type f -print0)

if [ "${#archives[@]}" -gt 0 ]; then
  echo "error: static archives cannot be signed; prune them (prune.sh) first:" >&2
  printf '  %s\n' "${archives[@]}" >&2
  exit 1
fi
total=$(( ${#libraries[@]} + ${#executables[@]} ))
[ "$total" -gt 0 ] || { echo "error: no Mach-O files found under $tree" >&2; exit 1; }

entitlement_count() {
  local xml
  xml="$(codesign -d --entitlements - --xml "$1" 2>/dev/null || true)"
  printf '%s' "$xml" | { grep -o '<key>' || true; } | wc -l | tr -d ' '
}

describe() {
  local authority ents
  authority="$(codesign -dvv "$1" 2>&1 | sed -n 's/^Authority=//p' | head -1 || true)"
  ents="$(entitlement_count "$1")"
  printf '%s | signer: %s | entitlements: %s\n' "${1#"$tree"/}" "${authority:-none}" "${ents:-0}"
}

if [ "$dry_run" = yes ]; then
  echo "would sign ${#libraries[@]} libraries, then ${#executables[@]} executables, in $tree:"
  for file in "${libraries[@]}" "${executables[@]}"; do describe "$file"; done
  echo "each with: codesign --force --sign \"${identity:-<identity>}\" --options runtime --timestamp <file>"
  exit 0
fi

check() {
  local file="$1" info ents
  if ! codesign --verify --strict --verbose=1 "$file" 2>/dev/null; then
    echo "FAIL verify: $file" >&2; return 1
  fi
  info="$(codesign -dvv "$file" 2>&1)"
  if ! printf '%s' "$info" | grep -q 'flags=.*runtime'; then
    echo "FAIL no hardened runtime: $file" >&2; return 1
  fi
  if ! printf '%s' "$info" | grep -qx "TeamIdentifier=$team"; then
    echo "FAIL team is not $team: $file" >&2; return 1
  fi
  ents="$(entitlement_count "$file")"
  if [ "$ents" -ne 0 ]; then
    echo "FAIL has entitlements: $file" >&2; return 1
  fi
}

failures=0
signed=0
for file in "${libraries[@]}" "${executables[@]}"; do
  codesign --force --sign "$identity" --options runtime --timestamp "$file"
  check "$file" || failures=$((failures + 1))
  signed=$((signed + 1))
done

echo "signed $signed files in $tree; $failures failed their check"
[ "$failures" -eq 0 ]
