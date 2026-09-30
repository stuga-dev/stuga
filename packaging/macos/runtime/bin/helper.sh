#!/bin/bash
# Stuga's helper, run by launchd as root whenever the requests directory changes (dev.stuga.helper,
# WatchPaths). It does two things, each only as the node asks: install a Stuga package that a
# release published, and run the remote access connector.
#
#   requests/upgrade      written by the node (_stuga): one line, the version, such as 1.4.2
#   status/upgrade.json   written here: {"version","state","message","at"} for the node to read
#   requests/remote       written by the node: one line, `on <config sha-256>` or `off`
#   status/remote.json    written here: {"state","message","at","connector_sha","config_sha"}
#
# The upgrade request names a version and nothing else: the package comes from that release's URL,
# built here from a checked version, and is installed only when Gatekeeper accepts it as notarized
# and signed by Stuga's team, and it is newer than the runtime in place. So the node, which runs as
# _stuga and cannot change the software it runs, can ask for an official upgrade and nothing more.
# The package's own scripts take it from there, and the new node backs up before it upgrades.
#
# The remote request is what the node wants now, and stays: every run compares it with what runs
# and brings the two together, so a run that failed or never happened is made good by the next.
# `on` installs the connector this runtime names (conf/connector.sha256) unless it is there: that
# release's download, with that sha-256, holding exactly its three files, and signed by Stuga's team
# as dev.stuga.remote. It then starts dev.stuga.remote, which runs it as _stugaremote, or restarts
# it when the connector or its settings changed since it started, and never otherwise. `off` stops it.
#
# Files the node can reach are never trusted: a request must be a plain file and is read for one
# short line; status is written into a directory only root can write. A request that changes while
# this runs is taken in another round, and a pending `off` goes before any long step.
set -euo pipefail

label=dev.stuga.remote
plist=/Library/LaunchDaemons/dev.stuga.remote.plist
# Not local: the EXIT trap runs after main has returned.
work=""
trap 'if [ -n "$work" ]; then rm -rf "$work"; fi' EXIT

main() {
  root="${STUGA_ROOT:-/Library/Application Support/Stuga}"
  team="${STUGA_TEAM_ID:-8W9F4LY7AP}"
  releases="${STUGA_RELEASES_URL:-https://github.com/stuga-dev/stuga/releases/download}"
  requests="$root/requests"
  status_dir="$root/status"

  mkdir -p "$status_dir"
  if [ "$(id -u)" -eq 0 ]; then chown root:wheel "$status_dir"; fi
  chmod 0755 "$status_dir"

  local round seen
  for round in 1 2 3 4 5 6 7 8 9 10; do
    seen="$(requests_seen)"
    upgrade
    remote
    [ "$(requests_seen)" != "$seen" ] || break
    echo "round $round: the requests changed meanwhile; again"
  done
}

# requests_seen: the two requests' names, inodes, times and sizes. The node renames each into place.
requests_seen() {
  stat -f '%N %i %Fm %z' "$requests/upgrade" "$requests/remote" 2> /dev/null || true
}

# write_status <file> <json>: a new file renamed into place, so nothing the node made is written through.
write_status() {
  local tmp
  tmp="$(mktemp "$status_dir/.$1.XXXXXX")"
  printf '%s\n' "$2" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$status_dir/$1"
}

# json_text <text>: safe between JSON quotes, and short: the node reads no status over 4 KiB.
json_text() {
  printf '%s' "$1" | tr -d '\\"' | tr '\n\t' '  ' | tr -d '[:cntrl:]' | head -c 1024
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---- upgrade

upgrade() {
  local request="$requests/upgrade" wanted
  # launchd runs this for any change, a removal included.
  [ -e "$request" ] || [ -L "$request" ] || return 0
  if [ -L "$request" ] || [ ! -f "$request" ]; then
    rm -f "$request"
    return 0
  fi
  wanted="$(head -c 32 "$request" | head -1 | tr -d '[:space:]')"
  rm -f "$request"

  if ! printf '%s' "$wanted" | grep -Eq '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$'; then
    wanted=""
    upgrade_status refused "the request did not name a version"
    return 0
  fi

  local current
  current="$(tr -d '[:space:]' < "$root/current/app/VERSION" 2> /dev/null || true)"
  if [ -n "$current" ] && ! newer "$wanted" "$current"; then
    upgrade_status refused "Stuga $wanted is not newer than the $current in place"
    return 0
  fi

  local pkg
  work="$(mktemp -d /private/var/tmp/stuga-upgrade.XXXXXX)"
  chmod 0700 "$work"
  pkg="$work/Stuga-$wanted.pkg"

  stop_if_off
  upgrade_status downloading "downloading Stuga $wanted"
  if ! curl -fsSL --max-time 1800 -o "$pkg" "$releases/v$wanted/Stuga-$wanted.pkg"; then
    upgrade_status failed "could not download Stuga $wanted"
    return 0
  fi

  upgrade_status verifying "checking the package's signature"
  local verdict
  verdict="$(spctl --assess --type install -vv "$pkg" 2>&1 || true)"
  if ! printf '%s\n' "$verdict" | grep -q '^source=Notarized Developer ID$' ||
    ! printf '%s\n' "$verdict" | grep -Eq "^origin=Developer ID Installer: .* \\($team\\)$"; then
    upgrade_status failed "the package is not notarized and signed by Stuga ($team)"
    return 0
  fi
  local shipped
  shipped="$(cd "$work" && xar -xf "$pkg" Distribution && sed -n 's/.*<product[^>]* version="\([0-9.]*\)".*/\1/p' Distribution | head -1)"
  if [ "$shipped" != "$wanted" ]; then
    upgrade_status failed "the package is Stuga ${shipped:-of no version}, not $wanted"
    return 0
  fi

  stop_if_off
  upgrade_status installing "installing Stuga $wanted"
  if installer -pkg "$pkg" -target / > "$work/installer.log" 2>&1; then
    upgrade_status 'done' "installed Stuga $wanted"
  else
    upgrade_status failed "the installer stopped: $(tail -1 "$work/installer.log")"
  fi
  rm -rf "$work"
  work=""
}

# upgrade_status <state> <message>, for the version `wanted` names.
upgrade_status() {
  write_status upgrade.json "$(printf '{"version":"%s","state":"%s","message":"%s","at":"%s"}' \
    "$wanted" "$1" "$(json_text "$2")" "$(now)")"
}

# newer A B: release A comes after release B.
newer() {
  local a b i
  IFS=. read -r -a a <<< "$1"
  IFS=. read -r -a b <<< "$2"
  for i in 0 1 2; do
    if [ "${a[i]:-0}" -gt "${b[i]:-0}" ]; then return 0; fi
    if [ "${a[i]:-0}" -lt "${b[i]:-0}" ]; then return 1; fi
  done
  return 1
}

# ---- remote access

# remote_request: `on <sha>`, `off`, `invalid`, or `none` when the node has asked nothing.
remote_request() {
  local request="$requests/remote" line
  if [ ! -e "$request" ] && [ ! -L "$request" ]; then echo none; return; fi
  if [ -L "$request" ] || [ ! -f "$request" ]; then echo invalid; return; fi
  line="$(head -c 80 "$request" | head -1)"
  if printf '%s' "$line" | grep -Eq '^(on [0-9a-f]{64}|off)$'; then echo "$line"; else echo invalid; fi
}

remote() {
  local wanted
  wanted="$(remote_request)"
  case "$wanted" in
    none) ;;
    off) remote_off stopped "remote access is off" ;;
    on\ *) remote_on "${wanted#on }" ;;
    *) remote_off refused "the request is neither on nor off" ;;
  esac
}

# stop_if_off: before a long step, a pending `off` goes first.
stop_if_off() {
  case "$(remote_request)" in
    off) remote_off stopped "remote access is off" ;;
    invalid) remote_off refused "the request is neither on nor off" ;;
  esac
}

# remote_status <state> <message> [connector sha] [config sha]
remote_status() {
  local connector="null" config="null"
  if [ -n "${3:-}" ]; then connector="\"$3\""; fi
  if [ -n "${4:-}" ]; then config="\"$4\""; fi
  write_status remote.json "$(printf '{"state":"%s","message":"%s","at":"%s","connector_sha":%s,"config_sha":%s}' \
    "$1" "$(json_text "$2")" "$(now)" "$connector" "$config")"
}

# job_field <regex>: the first top-level `<name> = <value>` of the job's launchctl print, or nothing.
job_field() {
  { launchctl print "system/$label" 2> /dev/null || true; } |
    sed -n "s/^[[:space:]]*$1 = \\(.*\\)\$/\\1/p" | head -1
}
job_loaded() { launchctl print "system/$label" > /dev/null 2>&1; }
job_pid() { job_field pid | grep -E '^[0-9]+$' || true; }

# stop_job: booted out and gone, or 1.
stop_job() {
  local i
  job_loaded || return 0
  launchctl bootout "system/$label" > /dev/null 2>&1 || true
  # The wrapper stops the connectors on SIGTERM; ExitTimeOut is 5 s.
  for i in $(seq 1 30); do
    job_loaded || return 0
    sleep 1
  done
  return 1
}

# remote_off <state> <message>: the job stopped and disabled. The connector stays, for turning it on again.
remote_off() {
  if ! stop_job; then
    remote_status failed "the connector did not stop"
    return 0
  fi
  launchctl disable "system/$label" > /dev/null 2>&1 || true
  rm -f "$root/connector/.started"
  remote_status "$1" "$2"
}

# remote_on <config sha>
remote_on() {
  local config="$1" connector sha_file="$root/current/conf/connector.sha256"
  if [ ! -f "$sha_file" ]; then
    remote_status unavailable "this Stuga carries no connector" "" "$config"
    return 0
  fi
  connector="$(head -c 80 "$sha_file" | head -1 | tr -d '[:space:]')"
  if ! printf '%s' "$connector" | grep -Eq '^[0-9a-f]{64}$'; then
    remote_status unavailable "this Stuga's connector checksum is unreadable" "" "$config"
    return 0
  fi

  installed=no
  if [ -f "$root/connector/$connector/frpc" ] && [ ! -L "$root/connector/$connector/frpc" ]; then
    installed=yes
  else
    install_connector "$connector" "$config"
  fi
  [ "$installed" = yes ] || return 0

  local previous
  previous="$(readlink "$root/connector/current" 2> /dev/null || true)"
  if [ "$previous" != "$connector" ]; then
    ln -s "$connector" "$root/connector/.current.$$"
    mv -h -f "$root/connector/.current.$$" "$root/connector/current"
    prune_connectors "$connector" "$previous"
  fi

  local started
  started="$(cat "$root/connector/.started" 2> /dev/null || true)"
  if [ -n "$(job_pid)" ] && [ "$started" = "$connector $config" ]; then
    remote_status running "the connector is running" "$connector" "$config"
    return 0
  fi

  # The download may have taken minutes: a request that changed meanwhile is the next round's.
  [ "$(remote_request)" = "on $config" ] || return 0
  if ! stop_job; then
    remote_status failed "the connector did not stop for its restart" "$connector" "$config"
    return 0
  fi
  local out
  if ! out="$(launchctl enable "system/$label" 2>&1 && launchctl bootstrap system "$plist" 2>&1)"; then
    remote_status failed "launchd did not start the connector: $out" "$connector" "$config"
    return 0
  fi
  printf '%s %s\n' "$connector" "$config" > "$root/connector/.started"
  confirm "$connector" "$config"
}

# install_connector <connector sha> <config sha>: into connector/<sha>, or a status saying why not.
# Sets `installed`.
install_connector() {
  local connector="$1" config="$2" version zip entries
  version="$(tr -d '[:space:]' < "$root/current/app/VERSION" 2> /dev/null || true)"
  if ! printf '%s' "$version" | grep -Eq '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$'; then
    remote_status unavailable "this Stuga is not a release, so it has no connector to download" "" "$config"
    return 0
  fi
  remote_status installing "downloading the connector for Stuga $version" "$connector" "$config"
  # The request may have changed while the status was written: a later round takes it.
  [ "$(remote_request)" = "on $config" ] || return 0

  if [ -n "$work" ]; then rm -rf "$work"; fi
  work="$(mktemp -d "$root/connector/.install.XXXXXX")"
  chmod 0700 "$work"
  zip="$work/connector.zip"
  if ! curl -fsSL --max-time 300 -o "$zip" "$releases/v$version/stuga-connector-darwin-arm64.zip"; then
    remote_status failed "could not download the connector for Stuga $version" "$connector" "$config"
    return 0
  fi
  if [ "$(shasum -a 256 "$zip" | awk '{print $1}')" != "$connector" ]; then
    remote_status refused "the connector downloaded is not the one this Stuga names" "$connector" "$config"
    return 0
  fi
  # Exactly three plain files, named, before and after unpacking.
  if ! entries="$(zipinfo -1 "$zip" 2> /dev/null)"; then
    remote_status refused "the connector's archive could not be unpacked" "$connector" "$config"
    return 0
  fi
  if [ "$(printf '%s\n' "$entries" | LC_ALL=C sort | tr '\n' ' ')" != "LICENSE THIRD-PARTY-NOTICES.txt frpc " ]; then
    remote_status refused "the connector's archive holds other files than its three" "$connector" "$config"
    return 0
  fi
  mkdir "$work/x"
  if ! ditto -x -k "$zip" "$work/x" > /dev/null 2>&1; then
    remote_status refused "the connector's archive could not be unpacked" "$connector" "$config"
    return 0
  fi
  entries="$(cd "$work/x" && find . -mindepth 1 | LC_ALL=C sort | tr '\n' ' ')"
  local file plain=yes
  for file in frpc LICENSE THIRD-PARTY-NOTICES.txt; do
    if [ -L "$work/x/$file" ] || [ ! -f "$work/x/$file" ]; then plain=no; fi
  done
  if [ "$entries" != "./LICENSE ./THIRD-PARTY-NOTICES.txt ./frpc " ] || [ "$plain" = no ]; then
    remote_status refused "the connector's archive holds other files than its three" "$connector" "$config"
    return 0
  fi
  if ! codesign --verify --strict -R "=anchor apple generic and certificate leaf[subject.OU] = \"$team\" and identifier \"dev.stuga.remote\" and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13]" "$work/x/frpc" > /dev/null 2>&1; then
    remote_status refused "the connector is not signed by Stuga ($team) as dev.stuga.remote" "$connector" "$config"
    return 0
  fi

  # Only _stugaremote, and root, can run it; neither it nor the node can change it.
  if [ "$(id -u)" -eq 0 ]; then chown -R root:_stugaremote "$work/x"; fi
  chmod 0750 "$work/x" "$work/x/frpc"
  chmod 0640 "$work/x/LICENSE" "$work/x/THIRD-PARTY-NOTICES.txt"
  rm -rf "${root:?}/connector/$connector"
  mv "$work/x" "$root/connector/$connector"
  rm -rf "$work"
  work=""
  installed=yes
}

# prune_connectors <current> <previous>: keep those two, and nothing an earlier run left.
prune_connectors() {
  local dir name
  for dir in "$root"/connector/* "$root"/connector/.install.*; do
    [ -e "$dir" ] || continue
    name="$(basename "$dir")"
    case "$name" in
      current | "$1" | "$2") ;;
      *) if [ -d "$dir" ] && [ ! -L "$dir" ]; then rm -rf "$dir"; fi ;;
    esac
  done
}

# confirm <connector sha> <config sha>: running once the same process has run for 5 of up to 15
# seconds; refused when the wrapper refused its settings (78), which also stops the job.
confirm() {
  local connector="$1" config="$2" i pid first="" since=0 code
  for i in $(seq 1 15); do
    sleep 1
    pid="$(job_pid)"
    if [ -n "$pid" ]; then
      if [ "$pid" != "$first" ]; then
        first="$pid"
        since="$i"
      fi
      if [ $((i - since)) -ge 5 ]; then
        remote_status running "the connector is running" "$connector" "$config"
        return 0
      fi
      continue
    fi
    first=""
    # `78`, or `78: EX_CONFIG`; `(never exited)` until it has.
    code="$(job_field 'last exit code' | sed -n 's/^\([0-9][0-9]*\).*$/\1/p')"
    case "$code" in
      '') ;;
      78)
        stop_job || true
        launchctl disable "system/$label" > /dev/null 2>&1 || true
        rm -f "$root/connector/.started"
        remote_status refused "the connector refused the settings it was given" "$connector" "$config"
        return 0
        ;;
      0)
        remote_status failed "the connector stopped at once: it found nothing to run" "$connector" "$config"
        return 0
        ;;
      *)
        remote_status failed "the connector exited with status $code" "$connector" "$config"
        return 0
        ;;
    esac
  done
  if [ -n "$first" ] && [ "$(job_pid)" = "$first" ]; then
    remote_status running "the connector is running" "$connector" "$config"
  else
    remote_status failed "the connector did not stay running" "$connector" "$config"
  fi
}

main "$@"
