#!/usr/bin/env bash
# Build Stuga.app, a menu-bar local trial that runs this checkout under launchd as you.
#
#   packaging/macos/local-trial/build.sh [--identity "Apple Development: you@example.com (ABCDE12345)"]
#   packaging/macos/local-trial/build.sh --uninstall     # remove the app and runtime, keep the data
#
# Options:
#   --identity <name|sha1>   re-sign the Postgres tree (library validation on) and the app with
#                            it; without one the tree keeps its upstream signatures and the app
#                            is signed ad hoc
#   --postgres-tree <dir>    copy this Postgres tree instead of the pinned assembled one
#   --app-dir <dir>          where Stuga.app goes (default ~/Applications)
#   --port <n>               the node's port (default 8787)
#   --origin <url>           the address other devices use when http://<this-mac>.local:<port>
#                            does not resolve for them, e.g. http://192.168.1.50:8787; the
#                            default follows the Mac's local host name at every start
#   --local-only             this Mac only: bind 127.0.0.1, no LAN address
#   --skip-web-build         use the checkout's web and MCP builds as they are
#
# Layout, under ~/Library/Application Support/Stuga Local:
#   runtime/local-<commit>/   build-runtime.sh --app-link this checkout
#   current -> runtime/local-<commit>
#   launchd/                  render-launchd.sh --mode agent --keep-env: a rebuild keeps the
#                             variables you added to a plist; loaded only by the app
#   data/                     the cluster, the node's data and the socket; kept by --uninstall
#   cache/                    downloads and the assembled Postgres tree
# Logs go to ~/Library/Logs/Stuga Local.
#
# By default the node binds every IPv4 interface with PUBLIC_ORIGIN http://<this-mac>.local:<port>,
# and 127.0.0.1 stays in EXTRA_ORIGINS as the fallback that needs no network and keeps a
# secure context. Plain http on a LAN is cleartext.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
BUILD="$REPO/packaging/macos/build"
ROOT="$HOME/Library/Application Support/Stuga Local"
LOGS="$HOME/Library/Logs/Stuga Local"
DOMAIN="gui/$(id -u)"
LABELS=(dev.stuga.local.node dev.stuga.local.postgres)

identity=""
postgres_tree=""
app_dir="$HOME/Applications"
port=8787
origin=""
follows_host_name=false
reach=lan
web_build=yes
uninstall=no
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) identity="${2:?}"; shift 2 ;;
    --postgres-tree) postgres_tree="${2:?}"; shift 2 ;;
    --app-dir) app_dir="${2:?}"; shift 2 ;;
    --port) port="${2:?}"; shift 2 ;;
    --origin) origin="${2:?}"; shift 2 ;;
    --local-only) reach=local; shift ;;
    --skip-web-build) web_build=no; shift ;;
    --uninstall) uninstall=yes; shift ;;
    -h | --help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "error: unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$port" in '' | *[!0-9]*) echo "error: --port must be a number" >&2; exit 2 ;; esac
if [ "$reach" = local ]; then
  [ -z "$origin" ] || { echo "error: --origin and --local-only contradict each other" >&2; exit 2; }
  origin="http://127.0.0.1:$port"; bind=127.0.0.1; extra_origins=""
else
  if [ -z "$origin" ]; then
    origin="http://$(scutil --get LocalHostName | tr '[:upper:]' '[:lower:]').local:$port"
    follows_host_name=true
  fi
  origin="${origin%/}"
  case "$origin" in http://* | https://*) ;; *) echo "error: --origin must be an http(s) origin, got $origin" >&2; exit 2 ;; esac
  bind=0.0.0.0; extra_origins="http://127.0.0.1:$port"
fi

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

# render_icon <iconset dir> <out.icns>: AppIcon.svg at every size an iconset holds. A plain .icns,
# since an asset catalog needs Xcode's actool; macOS frames one only at list-view sizes.
render_icon() {
  local size
  mkdir -p "$1"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" -s format png "$HERE/AppIcon.svg" --out "$1/icon_${size}x${size}.png" > /dev/null || return 1
    sips -z $((size * 2)) $((size * 2)) -s format png "$HERE/AppIcon.svg" --out "$1/icon_${size}x${size}@2x.png" > /dev/null || return 1
  done
  iconutil -c icns -o "$2" "$1"
}

stop_services() {
  local label
  for label in "${LABELS[@]}"; do
    if launchctl print "$DOMAIN/$label" > /dev/null 2>&1; then
      say "stopping $label"
      launchctl bootout "$DOMAIN/$label" || true
      while launchctl print "$DOMAIN/$label" > /dev/null 2>&1; do sleep 1; done
    fi
  done
}

if [ "$uninstall" = yes ]; then
  osascript -e 'quit app "Stuga"' > /dev/null 2>&1 || true
  stop_services
  rm -rf "$app_dir/Stuga.app" "$ROOT/runtime" "$ROOT/current" "$ROOT/launchd" "$ROOT/cache"
  say "removed Stuga.app and the runtime; your data is still in $ROOT/data (delete it to start over)"
  exit 0
fi

command -v pnpm > /dev/null || { echo "error: pnpm is needed to build the web app (see CONTRIBUTING.md)" >&2; exit 1; }
# shellcheck source=../build/lib/devtools.sh
. "$BUILD/lib/devtools.sh"
use_working_developer_tools

version="local-$(git -C "$REPO" rev-parse --short HEAD)"
mkdir -p "$ROOT/data" "$LOGS" "$app_dir"

# Nothing may run from the runtime this replaces.
osascript -e 'quit app "Stuga"' > /dev/null 2>&1 || true
stop_services

say "app: this checkout"
(cd "$REPO" && pnpm install --frozen-lockfile > /dev/null)
if [ "$web_build" = yes ]; then
  (cd "$REPO" && pnpm --filter @stuga/mcp --filter @stuga/web run build > /dev/null)
fi

say "runtime $version"
runtime_args=(--out "$ROOT" --version "$version" --app-link "$REPO")
[ -z "$postgres_tree" ] || runtime_args+=(--postgres-tree "$postgres_tree")
rm -rf "$ROOT/runtime"
STUGA_MACOS_CACHE="$ROOT/cache" "$BUILD/build-runtime.sh" "${runtime_args[@]}"
if [ -n "$identity" ]; then
  # codesign reports every file it re-signs; keep that in a log and show the verdict.
  if "$BUILD/sign.sh" --identity "$identity" "$ROOT/runtime/$version/postgres" > "$LOGS/sign.log" 2>&1; then
    tail -1 "$LOGS/sign.log"
  else
    grep -v 'replacing existing signature' "$LOGS/sign.log" | tail -20 >&2
    echo "error: signing the Postgres tree failed (full log: $LOGS/sign.log)" >&2
    exit 1
  fi
else
  echo "no --identity: the Postgres tree keeps its upstream signatures, so library validation stays off"
fi
ln -sfn "runtime/$version" "$ROOT/current"

say "LaunchAgent plists"
"$BUILD/render-launchd.sh" --mode agent --out "$ROOT/launchd" --root "$ROOT" --logs "$LOGS" \
  --public-origin "$origin" --bind "$bind" --port "$port" --extra-origins "$extra_origins" --keep-env > /dev/null

say "Stuga.app"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
app="$build/Stuga.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
swiftc -swift-version 5 -O -o "$app/Contents/MacOS/Stuga" "$HERE/Stuga.swift"
info="$app/Contents/Info.plist"
cat > "$info" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Stuga</string>
  <key>CFBundleIdentifier</key><string>dev.stuga.local</string>
  <key>CFBundleName</key><string>Stuga</string>
  <key>CFBundleDisplayName</key><string>Stuga</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
plutil -insert CFBundleShortVersionString -string "$version" "$info"
plutil -insert CFBundleVersion -string "$version" "$info"
plutil -insert StugaRoot -string "$ROOT" "$info"
plutil -insert StugaLogs -string "$LOGS" "$info"
plutil -insert StugaPort -integer "$port" "$info"
plutil -insert StugaOrigin -string "$origin" "$info"
plutil -insert StugaOriginFollowsHostName -bool "$follows_host_name" "$info"
# An icon that does not render leaves the generic one rather than failing the build.
if render_icon "$build/AppIcon.iconset" "$app/Contents/Resources/AppIcon.icns"; then
  plutil -insert CFBundleIconFile -string AppIcon "$info"
else
  echo "warning: AppIcon.svg did not render, so Stuga.app keeps the generic icon" >&2
fi
plutil -lint -s "$info"
if [ -n "$identity" ]; then
  codesign --force --options runtime --timestamp --sign "$identity" "$app"
else
  codesign --force --sign - "$app"
fi
codesign --verify --strict "$app"
rm -rf "$app_dir/Stuga.app"
ditto "$app" "$app_dir/Stuga.app"

say "done: $app_dir/Stuga.app (stuga $version)"
echo "    double-click it; the Stuga mark in the menu bar shows its state. Logs: $LOGS"
echo "    address:       $origin   (the menu-bar mark opens and copies it)"
if [ "$reach" = lan ]; then
  echo "    fallback:      http://127.0.0.1:$port   (no network needed, secure context)"
  fw=/usr/libexec/ApplicationFirewall/socketfilterfw
  if "$fw" --getglobalstate 2> /dev/null | grep -q 'State = 1' && ! "$fw" --getallowsigned 2> /dev/null | grep -q 'downloaded signed software ENABLED'; then
    echo "    the macOS firewall is on and does not auto-allow signed software: allow 'node' when it asks, or other devices get no answer"
  fi
fi
