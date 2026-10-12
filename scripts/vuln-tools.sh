#!/usr/bin/env bash
# Download the pinned scanners, osv-scanner and trivy, into <dir>, each checked against its sha256
# in .github/security/tools.env. govulncheck is built with the pinned Go by
# packaging/shared/connector/vulncheck.sh.
#
#   scripts/vuln-tools.sh <dir>
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../.github/security/tools.env
. "$root/.github/security/tools.env"
# shellcheck source=../packaging/macos/build/lib/fetch.sh
. "$root/packaging/macos/build/lib/fetch.sh"

dir="${1:-}"
[ -n "$dir" ] || { echo "usage: $0 <dir>" >&2; exit 2; }
if [ "$(uname -s)/$(uname -m)" != Linux/x86_64 ]; then
  echo "error: the scanners are pinned for linux/amd64, not $(uname -s)/$(uname -m)" >&2
  exit 1
fi
mkdir -p "$dir"

osv="$(fetch "https://github.com/google/osv-scanner/releases/download/v$OSV_SCANNER_VERSION/osv-scanner_linux_amd64" \
  "$OSV_SCANNER_LINUX_AMD64_SHA256")"
install -m 0755 "$osv" "$dir/osv-scanner"
"$dir/osv-scanner" --version | grep -qx "osv-scanner version: $OSV_SCANNER_VERSION" \
  || { echo "error: osv-scanner is not $OSV_SCANNER_VERSION" >&2; exit 1; }

trivy="$(fetch "https://github.com/aquasecurity/trivy/releases/download/v$TRIVY_VERSION/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" \
  "$TRIVY_LINUX_AMD64_SHA256")"
tar -xzf "$trivy" -C "$dir" trivy
"$dir/trivy" --version | grep -qx "Version: $TRIVY_VERSION" || { echo "error: trivy is not $TRIVY_VERSION" >&2; exit 1; }

echo "osv-scanner $OSV_SCANNER_VERSION and trivy $TRIVY_VERSION in $dir"
