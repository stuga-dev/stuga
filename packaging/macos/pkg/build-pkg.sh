#!/usr/bin/env bash
# Build Stuga-<version>.pkg: the Mac runtime, Stuga.app and the scripts that install them as
# system daemons, every binary signed, the package signed, and notarized and stapled when a
# notarytool profile is given.
#
#   packaging/macos/pkg/build-pkg.sh --version 1.2.3 --out <dir> \
#     --app-identity "Developer ID Application: <Name> (<TEAM>)" \
#     --installer-identity "Developer ID Installer: <Name> (<TEAM>)" \
#     [--notary-profile <keychain profile>] [--postgres-tree <dir>]
#
# Without identities the package is signed ad hoc and unsigned: fine to inspect, not to ship.
# A notary profile is stored once with `xcrun notarytool store-credentials <profile>`, in a
# terminal of your own, so the credential never passes through this script.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
macos="$(cd "$here/.." && pwd)"
repo="$(cd "$macos/../.." && pwd)"

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

version="" out="" app_identity="" installer_identity="" notary="" postgres_tree=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --app-identity) app_identity="${2:-}"; shift 2 ;;
    --installer-identity) installer_identity="${2:-}"; shift 2 ;;
    --notary-profile) notary="${2:-}"; shift 2 ;;
    --postgres-tree) postgres_tree="${2:-}"; shift 2 ;;
    -h | --help) usage ;;
    *) echo "error: unknown option $1" >&2; usage ;;
  esac
done
if [ -z "$version" ] || [ -z "$out" ]; then usage; fi
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "error: --version takes a release such as 1.2.3" >&2; exit 2; }
if [ -n "$notary" ] && { [ -z "$app_identity" ] || [ -z "$installer_identity" ]; }; then
  echo "error: notarizing needs both Developer ID identities" >&2
  exit 2
fi
[ "$(uname -m)" = arm64 ] || { echo "error: build on Apple silicon" >&2; exit 1; }

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
mkdir -p "$out"
out="$(cd "$out" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
payload="$work/payload"
stuga_root="$payload/Library/Application Support/Stuga"
runtime="$stuga_root/runtime/$version"

# ---- the runtime: Postgres, Node, the app tree, the wrappers, and what renders the jobs
say "runtime $version"
runtime_args=(--out "$stuga_root" --version "$version")
[ -z "$postgres_tree" ] || runtime_args+=(--postgres-tree "$postgres_tree")
"$macos/build/build-runtime.sh" "${runtime_args[@]}"
mkdir -p "$runtime/share/launchd/lib" "$runtime/share/launchd/templates"
cp "$macos/build/render-launchd.sh" "$runtime/share/launchd/"
cp "$macos/build/lib/uri.sh" "$runtime/share/launchd/lib/"
cp "$macos/runtime/launchd/"*.plist.in "$runtime/share/launchd/templates/"

# ---- Stuga.app
say "Stuga.app"
app="$payload/Applications/Stuga.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
swiftc -swift-version 5 -O -target arm64-apple-macos13.0 -o "$app/Contents/MacOS/Stuga" "$macos/app/Stuga.swift"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Stuga</string>
  <key>CFBundleIdentifier</key><string>dev.stuga.app</string>
  <key>CFBundleName</key><string>Stuga</string>
  <key>CFBundleDisplayName</key><string>Stuga</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
plutil -lint -s "$app/Contents/Info.plist"
iconset="$work/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" -s format png "$macos/local-trial/AppIcon.svg" --out "$iconset/icon_${size}x${size}.png" > /dev/null
  sips -z $((size * 2)) $((size * 2)) -s format png "$macos/local-trial/AppIcon.svg" --out "$iconset/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil -c icns -o "$app/Contents/Resources/AppIcon.icns" "$iconset"

# ---- signatures: every Mach-O with the hardened runtime, Node with only allow-jit
sign_one() { # sign_one <file> [entitlements]
  local args=(--force --options runtime --timestamp --sign "$app_identity")
  [ -z "${2:-}" ] || args+=(--entitlements "$2")
  codesign "${args[@]}" "$1"
}
if [ -n "$app_identity" ]; then
  say "signing as $app_identity"
  "$macos/build/sign.sh" --identity "$app_identity" "$runtime/postgres" > "$work/sign.log"
  tail -1 "$work/sign.log"
  cat > "$work/node.entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>
PLIST
  sign_one "$runtime/node/bin/node" "$work/node.entitlements"
  # Whatever else is native: esbuild, which tsx runs to read the node's TypeScript.
  while IFS= read -r -d '' file; do
    case "$(file -b "$file")" in *Mach-O*) sign_one "$file" ;; esac
  done < <(find "$runtime/app" -type f \( -perm +111 -o -name '*.node' -o -name '*.dylib' \) -print0)
  sign_one "$app"
else
  say "no --app-identity: signing ad hoc, for inspection only"
  codesign --force --sign - "$app"
fi

# ---- the package
say "package"
sed "s/@VERSION@/$version/g" "$here/scripts/postinstall" > "$work/postinstall"
mkdir -p "$work/scripts"
mv "$work/postinstall" "$work/scripts/postinstall"
cp "$here/scripts/preinstall" "$work/scripts/preinstall"
chmod 0755 "$work/scripts/preinstall" "$work/scripts/postinstall"
# Stuga.app stays where the package puts it, even if a copy exists elsewhere.
pkgbuild --analyze --root "$payload" "$work/components.plist" > /dev/null
plutil -replace 0.BundleIsRelocatable -bool false "$work/components.plist"
pkgbuild --root "$payload" --component-plist "$work/components.plist" --scripts "$work/scripts" \
  --identifier dev.stuga.node --version "$version" --install-location / "$work/stuga-node.pkg" > /dev/null
sed "s/@VERSION@/$version/g" "$here/distribution.xml.in" > "$work/distribution.xml"
mkdir -p "$work/resources"
cp "$here/resources/"*.html "$work/resources/"
cp "$repo/LICENSE" "$work/resources/LICENSE.txt"
product=("$out/Stuga-$version.pkg")
productbuild_args=(--distribution "$work/distribution.xml" --package-path "$work" --resources "$work/resources")
[ -z "$installer_identity" ] || productbuild_args+=(--sign "$installer_identity" --timestamp)
rm -f "${product[0]}"
productbuild "${productbuild_args[@]}" "${product[0]}" > /dev/null

# ---- notarization
if [ -n "$notary" ]; then
  say "notarizing (this waits for Apple)"
  xcrun notarytool submit "${product[0]}" --keychain-profile "$notary" --wait
  xcrun stapler staple "${product[0]}"
  spctl --assess --type install -vv "${product[0]}"
fi

say "done: ${product[0]} ($(du -h "${product[0]}" | cut -f1))"
[ -z "$installer_identity" ] || pkgutil --check-signature "${product[0]}" | sed -n '1,4p'
