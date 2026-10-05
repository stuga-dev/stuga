#!/usr/bin/env bash
# Build the remote-access connector: frpc, frp's LICENSE and THIRD-PARTY-NOTICES.txt. For the Mac,
# stuga-connector-darwin-arm64.zip holding the three, and beside it a copy of that frpc; for Linux,
# the three files, which the stuga-remote image carries.
#
#   packaging/shared/connector/build.sh --target <darwin/arm64|linux/amd64|linux/arm64> --out <dir>
#       [--identity <Developer ID Application>] [--notary-profile <keychain profile>]
#
# frpc is built from frp's pinned commit with the pinned Go (packaging/versions.env), without the
# web UI, and its build info is checked. go-licenses writes the notices, which must name every module
# the binary links; the modules' NOTICE files go in too. With --identity frpc is signed as
# dev.stuga.remote with the hardened runtime; with --notary-profile too, it must meet the helper's
# requirement, a Developer ID of the team runtime/bin/release.sh pins, and the zip is notarized (a
# bare binary cannot be stapled). Without either it keeps the linker's ad hoc signature: fine for CI,
# not to ship.
#
# Each target builds natively, on its own OS and architecture; the Linux ones are never signed.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
packaging="$(cd "$here/../.." && pwd)"
macos="$packaging/macos"
# shellcheck source=../../versions.env
. "$packaging/versions.env"
# shellcheck source=../../macos/build/lib/fetch.sh
. "$macos/build/lib/fetch.sh"
# shellcheck source=lib.sh
. "$here/lib.sh"

usage() { sed -n '6,7p' "$0" | sed 's/^# \{0,3\}//' >&2; exit 2; }

target="" out="" identity="" notary=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    --identity) identity="${2:-}"; shift 2 ;;
    --notary-profile) notary="${2:-}"; shift 2 ;;
    -h | --help) usage ;;
    *) echo "error: unknown option $1" >&2; usage ;;
  esac
done
[ -n "$target" ] && [ -n "$out" ] || usage
case "$target" in
  darwin/arm64 | linux/amd64 | linux/arm64) ;;
  *) echo "error: --target is darwin/arm64, linux/amd64 or linux/arm64, not \"$target\"" >&2; exit 2 ;;
esac
goos="${target%/*}" goarch="${target#*/}"
if [ -n "$identity" ] && [ "$goos" != darwin ]; then
  echo "error: only the darwin/arm64 connector is signed" >&2
  exit 2
fi
if [ -n "$notary" ] && [ -z "$identity" ]; then
  echo "error: notarizing needs --identity" >&2
  exit 2
fi
# Byte order for sort and the rest, whatever the caller's locale.
export LC_ALL=C

if ! go="$(go_for_target "$target" "$(uname -s)" "$(uname -m)")"; then
  echo "error: build $target on $target, not on $(uname -s)/$(uname -m)" >&2
  exit 1
fi
go_platform="${go% *}" go_sha_key="${go#* }"
go_sha="${!go_sha_key}"
if [ -n "$notary" ] && ! command -v jq > /dev/null; then
  echo "error: notarizing needs jq (in /usr/bin since macOS 15)" >&2
  exit 1
fi

say() { printf '==> %s\n' "$*"; }
fail() { echo "error: $*" >&2; exit 1; }

mkdir -p "$out"
out="$(cd "$out" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
src="$work/frp"
stage="$work/stage"
mkdir -p "$stage" "$work/bin"
zip_name=stuga-connector-$goos-$goarch.zip

say "go $GO_VERSION"
tarball="$(fetch "$(go_url "$go_platform")" "$go_sha")"
tar -xzf "$tarball" -C "$work"
# Only this Go, only the public proxy and checksum database, and nothing from the caller's go env.
unset GOOS GOARCH GOARM64 GOAMD64 GOEXPERIMENT GOFIPS140 GODEBUG GOBIN
export GOROOT="$work/go" PATH="$work/go/bin:$PATH" GOTOOLCHAIN=local GOENV=off GOWORK=off \
  GOFLAGS=-modcacherw GOPATH="$work/gopath" GOMODCACHE="$work/gopath/pkg/mod" GOCACHE="$work/gocache" \
  GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOPRIVATE="" GONOPROXY="" GONOSUMDB="" \
  GOINSECURE="" CGO_ENABLED=0
[ "$(go env GOVERSION)" = "go$GO_VERSION" ] || fail "the unpacked Go is $(go env GOVERSION), not go$GO_VERSION"

say "go-licenses $GO_LICENSES_VERSION"
GOBIN="$work/bin" go install "github.com/google/go-licenses/v2@$GO_LICENSES_VERSION"

say "frp $FRP_VERSION"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "v$FRP_VERSION" \
  https://github.com/fatedier/frp.git "$src"
head="$(git -C "$src" rev-parse HEAD)"
[ "$head" = "$FRP_COMMIT" ] || fail "frp's tag v$FRP_VERSION is $head, not the pinned $FRP_COMMIT"

say "frpc for $target"
(cd "$src" && GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags "-s -w" -tags frpc,noweb \
  -o "$stage/frpc" ./cmd/frpc)
go version -m "$stage/frpc" > "$work/buildinfo"
[ "$(head -1 "$work/buildinfo")" = "$stage/frpc: go$GO_VERSION" ] || fail "frpc was not built with go$GO_VERSION"
tab="$(printf '\t')"
for line in "path${tab}github.com/fatedier/frp/cmd/frpc" "build${tab}-tags=frpc,noweb" "build${tab}-trimpath=true" \
  "build${tab}CGO_ENABLED=0" "build${tab}GOOS=$goos" "build${tab}GOARCH=$goarch" \
  "build${tab}vcs.revision=$FRP_COMMIT" "build${tab}vcs.modified=false"; do
  grep -qxF "${tab}$line" "$work/buildinfo" || fail "frpc's build info lacks \"${line#*"$tab"}\""
done

# Every module the binary links, as path, version, and the path its source comes from.
awk -F'\t' '
  $2 == "dep" { if (p != "") print p "\t" v "\t" r; p = $3; v = $4; r = $3; next }
  $2 == "=>" { v = $4; r = $3; next }
  END { if (p != "") print p "\t" v "\t" r }
' "$work/buildinfo" > "$work/deps.tsv"
main_module="$(awk -F'\t' '$2 == "mod" { print $3 }' "$work/buildinfo")"
[ -s "$work/deps.tsv" ] && [ -n "$main_module" ] || fail "frpc's build info lists no modules"

say "license notices"
cat > "$work/report.tmpl" <<'TMPL'
{{range .}}{{.Name}}	{{.Version}}	{{.LicenseName}}	{{.LicensePath}}
{{end}}
TMPL
if ! (cd "$src" && GOOS="$goos" GOARCH="$goarch" GOFLAGS="-modcacherw -tags=frpc,noweb" \
  "$work/bin/go-licenses" report --template "$work/report.tmpl" ./cmd/frpc \
  > "$work/report.tsv" 2> "$work/go-licenses.log"); then
  cat "$work/go-licenses.log" >&2
  fail "go-licenses failed"
fi

# Each library go-licenses reports belongs to exactly one module frpc links, at the version linked,
# with a known license, and each module has one. Prints module, version, source path, library,
# license, license file: one row per library, licenses of one file joined.
awk -F'\t' -v main="$main_module" -v frp="$FRP_VERSION" '
  NR == FNR { version[$1] = $2; source[$1] = $3; next }
  $1 == "" { next }
  {
    best = ""
    for (m in version) if (($1 == m || index($1, m "/") == 1) && length(m) > length(best)) best = m
    if ($1 == main || index($1, main "/") == 1) if (length(main) >= length(best)) best = main
    if (best == "") { print "error: go-licenses reports " $1 ", a module frpc does not link" > "/dev/stderr"; bad = 1; next }
    if ($3 == "Unknown" || $4 == "Unknown") { print "error: no known license for " $1 > "/dev/stderr"; bad = 1; next }
    if (best != main && $2 != version[best]) {
      print "error: go-licenses reports " $1 " at " $2 ", frpc links " best " " version[best] > "/dev/stderr"; bad = 1; next
    }
    seen[best] = 1
    key = $1 "\t" $4
    if (key in names) { names[key] = names[key] ", " $3; next }
    order[++n] = key; names[key] = $3; module[key] = best
  }
  END {
    for (m in version) if (!(m in seen)) { print "error: frpc links " m ", which go-licenses does not report" > "/dev/stderr"; bad = 1 }
    if (!(main in seen)) { print "error: go-licenses does not report " main > "/dev/stderr"; bad = 1 }
    if (bad) exit 1
    for (i = 1; i <= n; i++) {
      split(order[i], k, "\t"); m = module[order[i]]
      v = (m == main) ? "v" frp : version[m]; s = (m == main) ? m : source[m]
      print m "\t" v "\t" s "\t" k[1] "\t" names[order[i]] "\t" k[2]
    }
  }
' "$work/deps.tsv" "$work/report.tsv" > "$work/libraries.tsv" || fail "the notices would not match frpc"

# source_urls <path> <version>: where a module's source is, for licenses that require saying so.
source_urls() {
  local path="$1" version="$2" ref
  ref="${version%+incompatible}"
  if printf '%s' "$ref" | grep -Eq -- '-[0-9]{14}-[0-9a-f]{12}$'; then ref="${ref##*-}"; fi
  # A repository's root module; one in a subdirectory tags its versions with a prefix.
  if printf '%s' "$path" | grep -Eq '^github\.com/[^/]+/[^/]+(/v[0-9]+)?$'; then
    printf '    Source: https://github.com/%s/tree/%s\n' "$(printf '%s' "$path" | cut -d/ -f2-3)" "$ref"
  fi
  printf '    Source: https://proxy.golang.org/%s/@v/%s.zip\n' "$(case_escape "$path")" "$(case_escape "$version")"
}

notices="$stage/THIRD-PARTY-NOTICES.txt"
{
  cat <<HEAD
Third-party software in the Stuga connector

frpc is frp $FRP_VERSION, Apache-2.0, in LICENSE beside this file. Its source:
https://github.com/fatedier/frp/tree/$FRP_COMMIT

It was built with Go $GO_VERSION and links the Go standard library and the modules below, each
under its own license. Their license texts, and any NOTICE files, follow the list.

  Go standard library go$GO_VERSION: BSD-3-Clause
HEAD
  while IFS="$tab" read -r module version source library names file; do
    [ "$file" != "$src/LICENSE" ] || continue
    if [ "$source" = "$module" ]; then
      printf '  %s %s: %s\n' "$library" "$version" "$names"
    else
      printf '  %s, replaced by %s %s: %s\n' "$library" "$source" "$version" "$names"
    fi
    case "$names" in *MPL* | *EPL* | *LGPL* | *CDDL*) source_urls "$source" "$version" ;; esac
  done < "$work/libraries.tsv"
  section() { # section <title> <file>
    printf '\n================================================================================\n'
    printf '%s\n' "$1"
    printf '================================================================================\n\n'
    cat "$2"
  }
  section "Go standard library go$GO_VERSION" "$GOROOT/LICENSE"
  # A NOTICE sits beside the license or at the module's root; each is printed once.
  noticed=""
  while IFS="$tab" read -r module version source library names file; do
    [ "$file" = "$src/LICENSE" ] || section "$library $version: $names" "$file"
    root="$src"
    [ "$module" = "$main_module" ] || root="$(module_dir "$source" "$version")"
    while IFS= read -r notice; do
      case "$noticed" in *"|$notice|"*) continue ;; esac
      noticed="$noticed|$notice|"
      section "$source $version: $(basename "$notice")" "$notice"
    done < <(notice_files "$(dirname "$file")" "$root")
  done < "$work/libraries.tsv"
} > "$notices"
say "THIRD-PARTY-NOTICES.txt: the Go standard library and $(wc -l < "$work/deps.tsv" | tr -d ' ') modules"

cp "$src/LICENSE" "$stage/LICENSE"
chmod 0755 "$stage/frpc"
chmod 0644 "$stage/LICENSE" "$notices"

if [ -n "$identity" ]; then
  say "signing as $identity"
  codesign --force --options runtime --timestamp --identifier dev.stuga.remote --sign "$identity" "$stage/frpc"
  codesign --verify --strict "$stage/frpc"
  signature="$(codesign -dv "$stage/frpc" 2>&1)"
  printf '%s\n' "$signature" | grep -qx 'Identifier=dev.stuga.remote' || fail "frpc is not signed as dev.stuga.remote"
  printf '%s\n' "$signature" | grep -q '^CodeDirectory .*flags=.*runtime' || fail "frpc has no hardened runtime"
  if [ -n "$notary" ]; then
    # What the helper requires before it installs the download, of the team release.sh pins.
    team="$(pinned_team "$macos/runtime/bin/release.sh")"
    [ -n "$team" ] || fail "runtime/bin/release.sh pins no team"
    signed_by="$(printf '%s\n' "$signature" | sed -n 's/^TeamIdentifier=//p')"
    [ "$signed_by" = "$team" ] || fail "frpc is signed by team ${signed_by:-none}; the helper trusts only $team"
    codesign --verify --strict -R "$(connector_requirement "$team")" "$stage/frpc" \
      || fail "frpc's signature is not a Developer ID of team $team"
  fi
fi
[ "$("$stage/frpc" --version)" = "$FRP_VERSION" ] || fail "frpc --version is not $FRP_VERSION"

if [ "$goos" = linux ]; then
  rm -f "$out/frpc" "$out/LICENSE" "$out/THIRD-PARTY-NOTICES.txt"
  cp "$stage/frpc" "$stage/LICENSE" "$notices" "$out/"
  say "done: $out/frpc, sha256 $(sha256_of "$out/frpc")"
  exit 0
fi

say "$zip_name"
(cd "$stage" && zip -X -q "$work/$zip_name" frpc LICENSE THIRD-PARTY-NOTICES.txt)
[ "$(zip_members "$work/$zip_name")" = "LICENSE THIRD-PARTY-NOTICES.txt frpc " ] \
  || fail "$zip_name does not hold exactly frpc, LICENSE and THIRD-PARTY-NOTICES.txt"

if [ -n "$notary" ]; then
  say "notarizing (this waits for Apple)"
  xcrun notarytool submit "$work/$zip_name" --keychain-profile "$notary" --wait --output-format json \
    > "$work/submit.json" || true
  id="$(jq -r '.id // empty' "$work/submit.json")"
  status="$(jq -r '.status // empty' "$work/submit.json")"
  [ -n "$id" ] || { cat "$work/submit.json" >&2; fail "notarytool returned no submission"; }
  xcrun notarytool log "$id" --keychain-profile "$notary" "$work/notary-log.json" > /dev/null
  if [ "$status" != Accepted ] || ! jq -e '.status == "Accepted" and ((.issues // []) | length == 0)' \
    "$work/notary-log.json" > /dev/null; then
    cat "$work/notary-log.json" >&2
    fail "notarization of $zip_name: $status"
  fi
fi

rm -f "$out/$zip_name" "$out/frpc"
cp "$stage/frpc" "$out/frpc"
mv "$work/$zip_name" "$out/$zip_name"
say "done: $out/$zip_name, sha256 $(sha256_of "$out/$zip_name")"
