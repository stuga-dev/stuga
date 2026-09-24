#!/usr/bin/env bash
# Render the Postgres and node launchd plists, and in daemon mode the upgrade helper's, from
# packaging/macos/runtime/launchd/*.plist.in.
#
#   packaging/macos/build/render-launchd.sh --mode daemon|agent --out <dir> --public-origin <url>
#       [--root <dir>] [--logs <dir>] [--bind <addr>] [--port <n>] [--extra-origins <origins>] [--keep-env]
#
#   daemon   dev.stuga.{postgres,node}, run as _stuga from boot; install into /Library/LaunchDaemons.
#            Root /Library/Application Support/Stuga, logs /Library/Logs/Stuga.
#   agent    dev.stuga.local.{postgres,node}, run as the logged-in user: the local trial.
#            Root ~/Library/Application Support/Stuga Local, logs ~/Library/Logs/Stuga Local.
#
# --public-origin is the address people open: the node's whole CORS allow-set with
# --extra-origins, and the issuer of every session token. --bind defaults to 127.0.0.1,
# --port to 8787. Writes <out>/<label>.plist for both jobs and lints them. With --keep-env, the
# environment variables of a plist already there that this script does not set are carried over;
# the ones it sets are rendered anew, and each of those whose value changes is named on stderr.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
templates="${STUGA_LAUNCHD_TEMPLATES:-$here/../runtime/launchd}"
# shellcheck source=lib/uri.sh
. "$here/lib/uri.sh"

usage() { sed -n '4,5p' "$0" | sed 's/^# \{0,3\}//' >&2; exit 2; }

mode="" out="" origin="" root="" logs="" bind=127.0.0.1 port=8787 extra_origins="" keep_env=no
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) mode="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --public-origin) origin="${2:-}"; shift 2 ;;
    --root) root="${2:-}"; shift 2 ;;
    --logs) logs="${2:-}"; shift 2 ;;
    --bind) bind="${2:-}"; shift 2 ;;
    --port) port="${2:-}"; shift 2 ;;
    --extra-origins) extra_origins="${2:-}"; shift 2 ;;
    --keep-env) keep_env=yes; shift ;;
    *) usage ;;
  esac
done
if [ -z "$out" ] || [ -z "$origin" ]; then usage; fi
case "$port" in '' | *[!0-9]*) echo "error: --port must be a number" >&2; exit 2 ;; esac
mkdir -p "$out"
out="$(cd "$out" && pwd)"

case "$mode" in
  daemon)
    label_prefix=dev.stuga
    bundle_id=dev.stuga.app
    root="${root:-/Library/Application Support/Stuga}"
    logs="${logs:-/Library/Logs/Stuga}"
    # launchd reads a job's environment only at bootstrap, so a kickstart keeps the old one.
    restart_hint="Edit /Library/LaunchDaemons/dev.stuga.node.plist, then reload the job (sudo launchctl bootout system/dev.stuga.node; sudo launchctl bootstrap system /Library/LaunchDaemons/dev.stuga.node.plist): a restart alone keeps the old environment."
    upgrade_hint="Choose Update now: the Mac that runs this node installs the release and backs up first. Or install the newer Stuga package on that Mac yourself."
    ;;
  agent)
    label_prefix=dev.stuga.local
    bundle_id=dev.stuga.local
    root="${root:-$HOME/Library/Application Support/Stuga Local}"
    logs="${logs:-$HOME/Library/Logs/Stuga Local}"
    # Stuga.app's Stop and Start boot the job out and in again, which is when launchd reads the plist.
    restart_hint="A rebuild sets the address, port, extra origins, data directory and database again, whatever the plist says: to change the address or port, rebuild with packaging/macos/local-trial/build.sh (--origin, --port, --local-only). To change anything else, edit $out/$label_prefix.node.plist, then choose Stop and Start in the menu bar."
    upgrade_hint="Take a backup, update the checkout, and run packaging/macos/local-trial/build.sh again with the flags you used before."
    ;;
  *) usage ;;
esac

# XML text, then escaped for a sed replacement delimited by |.
replacement() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/[\\|&]/\\&/g'
}

# carry_env <previous plist> <new plist>: copies each environment variable the new plist lacks, and
# names each one the new plist sets differently, so a hand edit a rebuild overwrites is not lost silently.
carry_env() {
  local keys key previous
  [ "$(plutil -type EnvironmentVariables "$1" 2> /dev/null)" = dictionary ] || return 0
  keys="$(plutil -extract EnvironmentVariables raw -o - "$1")"
  while IFS= read -r key; do
    case "$key" in
      '') continue ;;
      # A dot would split the key path.
      *.*) echo "warning: not keeping $key from the previous $(basename "$1"): a dot in its name" >&2; continue ;;
    esac
    # As XML, so the value keeps its type and every character.
    previous="$(plutil -extract "EnvironmentVariables.$key" xml1 -o - "$1")"
    if plutil -type "EnvironmentVariables.$key" "$2" > /dev/null 2>&1; then
      # Names only: a value such as DATABASE_URL may carry a password.
      [ "$previous" = "$(plutil -extract "EnvironmentVariables.$key" xml1 -o - "$2")" ] ||
        echo "replaced $key from the previous $(basename "$1") with the value the build sets" >&2
      continue
    fi
    plutil -insert "EnvironmentVariables.$key" -xml "$previous" "$2"
    echo "kept $key from the previous $(basename "$1")" >&2
  done <<< "$keys"
}

render() { # render <template> <label>
  local target="$out/$2.plist"
  sed -e "s|@LABEL@|$(replacement "$2")|g" \
      -e "s|@BUNDLE_ID@|$(replacement "$bundle_id")|g" \
      -e "s|@ROOT@|$(replacement "$root")|g" \
      -e "s|@LOGS@|$(replacement "$logs")|g" \
      -e "s|@SOCKET_DIR_URI@|$(replacement "$(uri_path "$root/data/run")")|g" \
      -e "s|@PUBLIC_ORIGIN@|$(replacement "$origin")|g" \
      -e "s|@EXTRA_ORIGINS@|$(replacement "$extra_origins")|g" \
      -e "s|@BIND@|$(replacement "$bind")|g" \
      -e "s|@PORT@|$port|g" \
      -e "s|@RESTART_HINT@|$(replacement "$restart_hint")|g" \
      -e "s|@UPGRADE_HINT@|$(replacement "$upgrade_hint")|g" \
      "$templates/$1" > "$target.tmp"
  if grep -n '@[A-Z_]*@' "$target.tmp" >&2; then
    rm -f "$target.tmp"
    echo "error: $1 has a placeholder this script does not fill" >&2
    exit 1
  fi
  if [ "$mode" = agent ]; then
    plutil -remove UserName "$target.tmp" > /dev/null
    plutil -remove GroupName "$target.tmp" > /dev/null
    # No helper runs beside a local trial, so the node offers no install.
    plutil -remove EnvironmentVariables.STUGA_UPGRADE_REQUESTS "$target.tmp" > /dev/null 2>&1 || true
    plutil -remove EnvironmentVariables.STUGA_UPGRADE_STATUS "$target.tmp" > /dev/null 2>&1 || true
  fi
  if [ "$keep_env" = yes ] && [ -f "$target" ]; then
    carry_env "$target" "$target.tmp"
  fi
  plutil -lint -s "$target.tmp"
  mv "$target.tmp" "$target"
  echo "$target"
}

render dev.stuga.postgres.plist.in "$label_prefix.postgres"
render dev.stuga.node.plist.in "$label_prefix.node"
# Only a daemon install has a helper: it runs as root, and installs a newer package on request.
if [ "$mode" = daemon ]; then render dev.stuga.helper.plist.in "$label_prefix.helper"; fi
