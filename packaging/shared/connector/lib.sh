# shellcheck shell=bash
# Sourced by build.sh and vulncheck.sh, after packaging/versions.env. Tested by
# packaging/shared/test/connector.test.mjs.

# native_target <uname -s> <uname -m>: this machine as a target such as linux/amd64, when
# versions.env pins a Go for it; nothing, and 1, otherwise.
native_target() {
  case "$1/$2" in
    Darwin/arm64) echo darwin/arm64 ;;
    Linux/x86_64) echo linux/amd64 ;;
    Linux/aarch64 | Linux/arm64) echo linux/arm64 ;;
    *) return 1 ;;
  esac
}

# go_for_target <target> <uname -s> <uname -m>: the Go download (os-arch) and the versions.env key of
# its sha256, when this machine builds the target natively; nothing, and 1, otherwise.
go_for_target() {
  case "$1 $2/$3" in
    "darwin/arm64 Darwin/arm64") echo "darwin-arm64 GO_DARWIN_ARM64_SHA256" ;;
    "linux/amd64 Linux/x86_64") echo "linux-amd64 GO_LINUX_AMD64_SHA256" ;;
    "linux/arm64 Linux/aarch64" | "linux/arm64 Linux/arm64") echo "linux-arm64 GO_LINUX_ARM64_SHA256" ;;
    *) return 1 ;;
  esac
}

# pinned_team <release.sh>: the team whose Developer ID the helper and bin/stuga trust (STUGA_TEAM_ID).
pinned_team() { sed -n 's/.*STUGA_TEAM_ID:-\([A-Z0-9]*\)}.*/\1/p' "$1"; }

# connector_requirement <team>: what the helper requires of frpc's signature before it installs it.
connector_requirement() {
  printf '=anchor apple generic and certificate leaf[subject.OU] = "%s" and identifier "dev.stuga.remote" and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13]' "$1"
}

# zip_members <zip>: its entries on one line, in byte order whatever the locale.
zip_members() { unzip -Z1 "$1" | LC_ALL=C sort | tr '\n' ' '; }

# case_escape <module path or version>: as the module cache and proxy spell it.
case_escape() { printf '%s' "$1" | sed 's/[A-Z]/!&/g' | tr '[:upper:]' '[:lower:]'; }

# module_dir <path> <version>: where $GOMODCACHE holds a module.
module_dir() { printf '%s/%s@%s' "$GOMODCACHE" "$(case_escape "$1")" "$(case_escape "$2")"; }

# notice_files <dir>...: the NOTICE files in these directories, one per line. Apache-2.0 §4(d) has a
# redistribution carry them.
notice_files() {
  local dir file
  for dir in "$@"; do
    for file in "$dir"/NOTICE*; do
      if [ -f "$file" ]; then printf '%s\n' "$file"; fi
    done
  done
}

# use_go <tarball> <work>: unpacks the pinned Go into <work> and points go at it alone: only the
# public proxy and checksum database, caches in <work>, and nothing from the caller's go env.
use_go() {
  tar -xzf "$1" -C "$2" || return 1
  unset GOOS GOARCH GOARM64 GOAMD64 GOEXPERIMENT GOFIPS140 GODEBUG GOBIN
  export GOROOT="$2/go" PATH="$2/go/bin:$PATH" GOTOOLCHAIN=local GOENV=off GOWORK=off \
    GOFLAGS=-modcacherw GOPATH="$2/gopath" GOMODCACHE="$2/gopath/pkg/mod" GOCACHE="$2/gocache" \
    GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOPRIVATE="" GONOPROXY="" GONOSUMDB="" \
    GOINSECURE="" CGO_ENABLED=0
  if [ "$(go env GOVERSION)" != "go$GO_VERSION" ]; then
    echo "error: the unpacked Go is $(go env GOVERSION), not go$GO_VERSION" >&2
    return 1
  fi
}

# clone_frp <dir>: frp's tag v$FRP_VERSION, refused unless it points at the pinned FRP_COMMIT.
clone_frp() {
  local head
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "v$FRP_VERSION" \
    https://github.com/fatedier/frp.git "$1" || return 1
  head="$(git -C "$1" rev-parse HEAD)" || return 1
  if [ "$head" != "$FRP_COMMIT" ]; then
    echo "error: frp's tag v$FRP_VERSION is $head, not the pinned $FRP_COMMIT" >&2
    return 1
  fi
}
