#!/bin/bash
# Create Stuga's Postgres cluster once, with the database `stuga` owned by the role `stuga`.
#
#   init-cluster.sh --pgbin <dir> --data <pgdata> --socket <dir> [--os-user <user>]
#
# --os-user is the account that runs Postgres, the node and every stuga-node command, the one
# peer authentication maps to the role; it defaults to the user running this. Run as root for
# another user, the script runs itself as that user, because initdb refuses root. Memory
# follows the machine's size. A cluster that already exists is left alone.
set -euo pipefail

main() {
  local usage="usage: $0 --pgbin <dir> --data <pgdata> --socket <dir> [--os-user <user>]"
  local here pgbin="" data="" socket="" os_user=""
  here="$(cd "$(dirname "$0")" && pwd)"
  while [ $# -gt 0 ]; do
    case "$1" in
      --pgbin) pgbin="${2:-}"; shift 2 ;;
      --data) data="${2:-}"; shift 2 ;;
      --socket) socket="${2:-}"; shift 2 ;;
      --os-user) os_user="${2:-}"; [ -n "$os_user" ] || { echo "$usage" >&2; exit 2; }; shift 2 ;;
      *) echo "$usage" >&2; exit 2 ;;
    esac
  done
  if [ -z "$pgbin" ] || [ -z "$data" ] || [ -z "$socket" ]; then echo "$usage" >&2; exit 2; fi
  if [ -n "$os_user" ] && [ "$os_user" != "$(id -un)" ]; then
    [ "$(id -u)" -eq 0 ] || { echo "error: only root can create a cluster for $os_user" >&2; exit 2; }
    id -u "$os_user" > /dev/null 2>&1 || { echo "error: no user $os_user" >&2; exit 2; }
    exec sudo -u "$os_user" "$here/$(basename "$0")" --pgbin "$pgbin" --data "$data" --socket "$socket"
  fi
  [ -x "$pgbin/initdb" ] || { echo "error: no initdb in $pgbin" >&2; exit 2; }
  # sun_path holds 103 bytes, and Postgres appends /.s.PGSQL.<port> to the directory.
  if [ "${#socket}" -gt 88 ]; then
    echo "error: socket directory path is longer than a unix socket allows (${#socket} > 88 bytes): $socket" >&2
    exit 2
  fi
  case "$socket" in *"'"*) echo "error: the socket directory path must not contain a single quote" >&2; exit 2 ;; esac

  # A runtime carries conf/versions.env; a checkout has packaging/versions.env.
  local conf="$here/../conf" versions
  versions="$conf/versions.env"
  [ -f "$versions" ] || versions="$here/../../../versions.env"
  # shellcheck source=../../../versions.env
  . "$versions"
  local initdb_args
  read -r -a initdb_args <<< "${INITDB_ARGS:?versions.env must define INITDB_ARGS}"

  if [ -f "$data/PG_VERSION" ]; then
    echo "a cluster already exists at $data"
    exit 0
  fi
  if [ ! -d "$socket" ]; then
    mkdir -p "$socket"
    chmod 0700 "$socket"
  fi

  local shared work maintenance
  if [ "$(sysctl -n hw.memsize)" -le $((16 * 1024 * 1024 * 1024)) ]; then
    shared=256MB work=16MB maintenance=512MB
  else
    shared=512MB work=32MB maintenance=1GB
  fi

  # Built beside the target and renamed last, so a half-made cluster is never taken for one.
  local staging="$data.creating" run_dir user
  run_dir="$(printf '%s' "$socket" | sed -e 's/[\\|&]/\\&/g')"
  user="$(id -un | sed -e 's/[\\|&]/\\&/g')"
  rm -rf "$staging"
  mkdir -p "$(dirname "$data")"
  "$pgbin/initdb" -D "$staging" -U stuga --auth-local=peer --auth-host=reject "${initdb_args[@]}"
  sed -e "s|@RUN_DIR@|$run_dir|" -e "s|@SHARED_BUFFERS@|$shared|" -e "s|@WORK_MEM@|$work|" \
      -e "s|@MAINTENANCE_WORK_MEM@|$maintenance|" -e 's|@MAX_PARALLEL_MAINTENANCE_WORKERS@|2|' \
      "$conf/postgresql.conf" > "$staging/postgresql.conf"
  cp "$conf/pg_hba.conf" "$staging/pg_hba.conf"
  sed -e "s|@OS_USER@|$user|" "$conf/pg_ident.conf" > "$staging/pg_ident.conf"
  chmod 0600 "$staging/postgresql.conf" "$staging/pg_hba.conf" "$staging/pg_ident.conf"

  "$pgbin/pg_ctl" -D "$staging" -l "$staging/init.log" -w -t 60 start
  "$pgbin/createdb" -h "$socket" -U stuga stuga
  "$pgbin/pg_ctl" -D "$staging" -m fast -w stop
  rm -f "$staging/init.log"
  mv "$staging" "$data"
  echo "created a cluster at $data (shared_buffers $shared, work_mem $work, maintenance_work_mem $maintenance)"
}

# One function, called on the last line, like the launchd wrappers beside it.
# shellcheck disable=SC2317 # exit is reached only if main returns
{ main "$@"; exit; }
