#!/bin/bash
# Stuga's upgrade helper, run by launchd as root whenever the requests directory changes
# (dev.stuga.helper, WatchPaths). It does one thing: install a Stuga package that a release
# published, when the node asks for a newer version.
#
#   requests/upgrade      written by the node (_stuga): one line, the version, such as 1.4.2
#   status/upgrade.json   written here: {"version","state","message","at"} for the node to read
#
# The request names a version and nothing else: the package comes from that release's URL, built
# here from a checked version, and is installed only when Gatekeeper accepts it as notarized and
# signed by Stuga's team, and it is newer than the runtime in place. So the node, which runs as
# _stuga and cannot change the software it runs, can ask for an official upgrade and nothing more.
# The package's own scripts take it from there, and the new node backs up before it upgrades.
#
# Files the node can reach are never trusted: the request must be a plain file, is read for one
# short line, and is removed first; status is written into a directory only root can write.
set -euo pipefail

main() {
  local root="${STUGA_ROOT:-/Library/Application Support/Stuga}"
  local team="${STUGA_TEAM_ID:-8W9F4LY7AP}"
  local releases="${STUGA_RELEASES_URL:-https://github.com/stuga-dev/stuga/releases/download}"
  local requests="$root/requests" status_dir="$root/status"
  local request="$requests/upgrade"

  # launchd runs this for any change, a removal included.
  [ -e "$request" ] || [ -L "$request" ] || exit 0
  if [ -L "$request" ] || [ ! -f "$request" ]; then
    rm -f "$request"
    exit 0
  fi
  local wanted
  wanted="$(head -c 32 "$request" | head -1 | tr -d '[:space:]')"
  rm -f "$request"

  mkdir -p "$status_dir"
  if [ "$(id -u)" -eq 0 ]; then chown root:wheel "$status_dir"; fi
  chmod 0755 "$status_dir"

  # status <state> <message>: a new file renamed into place, so nothing the node made is written through.
  status() {
    local tmp
    tmp="$(mktemp "$status_dir/.upgrade.XXXXXX")"
    printf '{"version":"%s","state":"%s","message":"%s","at":"%s"}\n' \
      "$wanted" "$1" "$(printf '%s' "$2" | tr -d '\\"' | tr '\n' ' ')" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
    chmod 0644 "$tmp"
    mv -f "$tmp" "$status_dir/upgrade.json"
  }

  if ! printf '%s' "$wanted" | grep -Eq '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$'; then
    wanted=""
    status refused "the request did not name a version"
    exit 0
  fi

  local current
  current="$(tr -d '[:space:]' < "$root/current/app/VERSION" 2>/dev/null || true)"
  if [ -n "$current" ] && ! newer "$wanted" "$current"; then
    status refused "Stuga $wanted is not newer than the $current in place"
    exit 0
  fi

  local pkg
  # Not local: the EXIT trap runs after main has returned.
  work="$(mktemp -d /private/var/tmp/stuga-upgrade.XXXXXX)"
  chmod 0700 "$work"
  trap 'rm -rf "$work"' EXIT
  pkg="$work/Stuga-$wanted.pkg"

  status downloading "downloading Stuga $wanted"
  if ! curl -fsSL --max-time 1800 -o "$pkg" "$releases/v$wanted/Stuga-$wanted.pkg"; then
    status failed "could not download Stuga $wanted"
    exit 0
  fi

  status verifying "checking the package's signature"
  local verdict
  verdict="$(spctl --assess --type install -vv "$pkg" 2>&1 || true)"
  if ! printf '%s\n' "$verdict" | grep -q '^source=Notarized Developer ID$' ||
    ! printf '%s\n' "$verdict" | grep -Eq "^origin=Developer ID Installer: .* \\($team\\)$"; then
    status failed "the package is not notarized and signed by Stuga ($team)"
    exit 0
  fi
  local shipped
  shipped="$(cd "$work" && xar -xf "$pkg" Distribution && sed -n 's/.*<product[^>]* version="\([0-9.]*\)".*/\1/p' Distribution | head -1)"
  if [ "$shipped" != "$wanted" ]; then
    status failed "the package is Stuga ${shipped:-of no version}, not $wanted"
    exit 0
  fi

  status installing "installing Stuga $wanted"
  if installer -pkg "$pkg" -target / > "$work/installer.log" 2>&1; then
    status 'done' "installed Stuga $wanted"
  else
    status failed "the installer stopped: $(tail -1 "$work/installer.log")"
  fi
}

# newer A B: release A comes after release B.
newer() {
  local a b i
  IFS=. read -r -a a <<< "$1"
  IFS=. read -r -a b <<< "$2"
  for i in 0 1 2; do
    if [ "${a[i]:-0}" -gt "${b[i]:-0}" ]; then return 0; fi
    if [ "${a[i]:-0}" -lt "${b[i]:-0}" ]; then return 1; fi
  done
  return 1
}

main "$@"
