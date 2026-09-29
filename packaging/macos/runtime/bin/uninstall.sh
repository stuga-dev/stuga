#!/bin/bash
# Remove Stuga from this Mac: its four jobs, Stuga.app, the runtime and the remote access connector.
# The data and the backups stay in /Library/Application Support/Stuga/data unless --delete-data is
# given, which also removes the logs, the connector's settings and the _stuga and _stugaremote
# accounts. The menu bar's Uninstall Stuga… runs this.
#
#   sudo "/Library/Application Support/Stuga/current/bin/uninstall.sh" [--delete-data]
set -euo pipefail

main() {
  local root="/Library/Application Support/Stuga" delete=no label user uid account
  case "${1:-}" in
    "") ;;
    --delete-data) delete=yes ;;
    *) echo "usage: $0 [--delete-data]" >&2; exit 2 ;;
  esac
  [ "$(id -u)" -eq 0 ] || { echo "error: run this as root (sudo)" >&2; exit 2; }

  # The helper first, so nothing starts the connector again; the node before Postgres, whose
  # shutdown would otherwise cut the node's connections.
  for label in dev.stuga.helper dev.stuga.remote dev.stuga.node dev.stuga.postgres; do
    launchctl bootout "system/$label" 2> /dev/null || true
    rm -f "/Library/LaunchDaemons/$label.plist"
  done

  user="$(stat -f %Su /dev/console 2> /dev/null || true)"
  uid="$(stat -f %u /dev/console 2> /dev/null || true)"
  if [ -n "$uid" ] && [ "$user" != root ]; then
    launchctl asuser "$uid" sudo -u "$user" osascript -e 'quit app id "dev.stuga.app"' > /dev/null 2>&1 || true
  fi
  rm -rf /Applications/Stuga.app
  rm -rf "$root/runtime" "$root/current" "$root/requests" "$root/status" "$root/connector"
  pkgutil --forget dev.stuga.node > /dev/null 2>&1 || true

  if [ "$delete" = yes ]; then
    rm -rf "$root" /Library/Logs/Stuga
    for account in _stuga _stugaremote; do
      dscl . -delete "/Users/$account" > /dev/null 2>&1 || true
      dscl . -delete "/Groups/$account" > /dev/null 2>&1 || true
    done
    echo "Stuga and its data are removed."
  else
    echo "Stuga is removed. Its data and backups stay in $root/data; installing Stuga again uses them."
  fi
}

main "$@"
