# shellcheck shell=bash
# The hold mark, status/restoring: bin/stuga writes it, as root, while it restores a backup or goes
# back to an earlier version. Line 1 is its process id, line 2 that process's start time as
# `TZ=UTC0 LC_ALL=C /bin/ps -p <pid> -o lstart=` prints it, trimmed: in UTC, since sudo keeps the
# administrator's TZ and launchd uses the Mac's. While it holds, node-wrapper.sh does not start the
# node and helper.sh installs nothing. It holds only while that process runs, so a restart or a kill
# ends it with nothing to clean up. Sourced; Stuga.app reads it the same way.

# process_started <pid>: when that process started, or nothing when it is not running.
process_started() {
  TZ=UTC0 LC_ALL=C /bin/ps -p "$1" -o lstart= 2> /dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

# restore_under_way <root>: the mark is a plain file naming a running process by its id and start.
restore_under_way() {
  local mark="$1/status/restoring" pid="" started=""
  [ -f "$mark" ] && [ ! -L "$mark" ] || return 1
  { IFS= read -r pid; IFS= read -r started; } < "$mark" || true
  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
  [ -n "$started" ] && [ "$started" = "$(process_started "$pid")" ]
}
