# shellcheck shell=bash
# Sourced by build.sh. Tested by packaging/shared/test/connector.test.mjs.

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

# pinned_team <helper.sh>: the team whose Developer ID the upgrade helper trusts (STUGA_TEAM_ID).
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
