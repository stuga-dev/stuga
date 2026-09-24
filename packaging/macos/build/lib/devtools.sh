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
