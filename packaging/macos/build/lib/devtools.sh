# shellcheck shell=bash
# The developer tools in /usr/bin (lipo, otool, swiftc, git) are shims into the selected developer
# directory, and while that is an Xcode whose license nobody has accepted, every shim exits 69. The
# Command Line Tools answer the same shims without that gate.

COMMAND_LINE_TOOLS=/Library/Developer/CommandLineTools

# use_working_developer_tools: exports DEVELOPER_DIR=$COMMAND_LINE_TOOLS when the selected developer
# directory refuses to run its tools and the Command Line Tools do not. A DEVELOPER_DIR already set wins.
use_working_developer_tools() {
  [ -z "${DEVELOPER_DIR:-}" ] || return 0
  xcrun --find lipo > /dev/null 2>&1 && return 0
  if DEVELOPER_DIR="$COMMAND_LINE_TOOLS" xcrun --find lipo > /dev/null 2>&1; then
    export DEVELOPER_DIR="$COMMAND_LINE_TOOLS"
    echo "note: the selected Xcode cannot run its tools (is its license accepted?), so this uses $COMMAND_LINE_TOOLS" >&2
  fi
  return 0
}

# strip_local_symbols <Mach-O file>: strip -x, which keeps every exported symbol, then an ad-hoc
# signature: the strip breaks the file's signature, and an arm64 file with a broken one is killed
# before it runs. Ad hoc, without hardened runtime or entitlements, until a release signs it
# (build-pkg.sh). A file with nothing left to strip is not touched, so it keeps its signature.
strip_local_symbols() {
  local file="$1" out
  # strip warns that it invalidates the signature, which the ad-hoc one replaces.
  out="$(strip -x -o "$file.stripped" "$file" 2>&1)" || { printf '%s\n' "$out" >&2; rm -f "$file.stripped"; return 1; }
  if cmp -s "$file" "$file.stripped"; then
    rm -f "$file.stripped"
    return 0
  fi
  chmod "$(stat -f %Lp "$file")" "$file.stripped" || return 1
  mv -f "$file.stripped" "$file" || return 1
  codesign --force --sign - "$file" 2> /dev/null || return 1
  codesign --verify --strict "$file"
}
