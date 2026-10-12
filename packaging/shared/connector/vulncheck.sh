#!/usr/bin/env bash
# Check frp's pinned commit for known vulnerabilities in the code the connector, frpc, can reach:
# govulncheck in source mode, with the pinned Go and the connector's build tags, once per platform it
# ships for. Writes one JSON stream per platform, govulncheck-frpc-<os>-<arch>.json, for
# scripts/vuln-gate.mjs.
#
#   packaging/shared/connector/vulncheck.sh --out <dir> [--pins <versions.env>]
#
# The standard library is the pinned Go's, so a finding in it is fixed by a GO_VERSION bump. --pins
# reads another versions.env, such as a release's.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
packaging="$(cd "$here/../.." && pwd)"
root="$(cd "$packaging/.." && pwd)"

usage() { sed -n '7,7p' "$0" | sed 's/^# \{0,3\}//' >&2; exit 2; }

out="" pins="$packaging/versions.env"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="${2:-}"; shift 2 ;;
    --pins) pins="${2:-}"; shift 2 ;;
    -h | --help) usage ;;
    *) echo "error: unknown option $1" >&2; usage ;;
  esac
done
[ -n "$out" ] || usage

[ -f "$pins" ] || { echo "error: no versions.env at $pins" >&2; exit 2; }
# shellcheck source=../../versions.env
. "$(cd "$(dirname "$pins")" && pwd)/$(basename "$pins")"
# shellcheck source=../../../.github/security/tools.env
. "$root/.github/security/tools.env"
# shellcheck source=../../macos/build/lib/fetch.sh
. "$packaging/macos/build/lib/fetch.sh"
# shellcheck source=lib.sh
. "$here/lib.sh"

say() { printf '==> %s\n' "$*"; }

if ! native="$(native_target "$(uname -s)" "$(uname -m)")"; then
  echo "error: no Go is pinned for $(uname -s)/$(uname -m)" >&2
  exit 1
fi
go="$(go_for_target "$native" "$(uname -s)" "$(uname -m)")"
go_platform="${go% *}" go_sha_key="${go#* }"

mkdir -p "$out"
out="$(cd "$out" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

say "go $GO_VERSION"
tarball="$(fetch "$(go_url "$go_platform")" "${!go_sha_key}")"
use_go "$tarball" "$work" || exit 1

say "govulncheck $GOVULNCHECK_VERSION"
GOBIN="$work/bin" go install "golang.org/x/vuln/cmd/govulncheck@$GOVULNCHECK_VERSION"

say "frp $FRP_VERSION"
clone_frp "$work/frp" || exit 1

for target in darwin/arm64 linux/amd64 linux/arm64; do
  file="$out/govulncheck-frpc-${target%/*}-${target#*/}.json"
  say "frpc for $target"
  # JSON exits 0 with findings too; any other failure is a scan that did not finish.
  (cd "$work/frp" && GOOS="${target%/*}" GOARCH="${target#*/}" \
    "$work/bin/govulncheck" -format json -tags frpc,noweb ./cmd/frpc > "$file")
done
say "done: $out"
