#!/bin/bash
# Remove Stuga from this Mac: its three jobs, Stuga.app and the runtime. The data and the backups
# stay in /Library/Application Support/Stuga/data unless --delete-data is given, which also removes
# the logs and the _stuga account. The menu bar's Uninstall Stuga… runs this.
#
#   sudo "/Library/Application Support/Stuga/current/bin/uninstall.sh" [--delete-data]
set -euo pipefail

main() {
  local root="/Library/Application Support/Stuga" delete=no label user uid
  case "${1:-}" in
    "") ;;
    --delete-data) delete=yes ;;
    *) echo "usage: $0 [--delete-data]" >&2; exit 2 ;;
  esac
  [ "$(id -u)" -eq 0 ] || { echo "error: run this as root (sudo)" >&2; exit 2; }

  # The node first: it holds connections a Postgres shutdown would otherwise cut.
  for label in dev.stuga.node dev.stuga.postgres dev.stuga.helper; do
    launchctl bootout "system/$label" 2> /dev/null || true
    rm -f "/Library/LaunchDaemons/$label.plist"
  done

  user="$(stat -f %Su /dev/console 2> /dev/null || true)"
  uid="$(stat -f %u /dev/console 2> /dev/null || true)"
  if [ -n "$uid" ] && [ "$user" != root ]; then
    launchctl asuser "$uid" sudo -u "$user" osascript -e 'quit app id "dev.stuga.app"' > /dev/null 2>&1 || true
  fi
  rm -rf /Applications/Stuga.app
  rm -rf "$root/runtime" "$root/current" "$root/requests" "$root/status"
  pkgutil --forget dev.stuga.node > /dev/null 2>&1 || true

  if [ "$delete" = yes ]; then
    rm -rf "$root" /Library/Logs/Stuga
    dscl . -delete /Users/_stuga > /dev/null 2>&1 || true
    dscl . -delete /Groups/_stuga > /dev/null 2>&1 || true
    echo "Stuga and its data are removed."
  else
    echo "Stuga is removed. Its data and backups stay in $root/data; installing Stuga again uses them."
  fi
}

main "$@"
