#!/usr/bin/env bash
# Install Stuga with Docker Compose in one step:
#
#   curl -fsSL https://github.com/stuga-dev/stuga/releases/latest/download/install.sh | bash
#
# Options, after `bash -s --` when piped:
#   --dir <dir>        where Stuga goes (default ./stuga)
#   --version <v>      a release such as 1.2.3 (default the newest)
#   --port <n>         the port other devices use (default 8787)
#   --origin <url>     the address other devices use, when this machine's is not the right one
#   --local-only       serve this machine only
#
# Makes the directory, downloads the release's compose.yml, env.example and stuga into it, writes
# .env with this machine's address on the network as PUBLIC_ORIGIN and a random database password,
# starts the stack, waits until the node serves, and prints the link that sets it up. Written for
# bash 3.2.
set -euo pipefail

RELEASES="https://github.com/stuga-dev/stuga/releases"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

dir="$PWD/stuga" version="latest" port=8787 origin="" local_only=no
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="${2:?--dir needs a directory}"; shift 2 ;;
    --version) version="${2:?--version needs a version}"; shift 2 ;;
    --port) port="${2:?--port needs a number}"; shift 2 ;;
    --origin) origin="${2:?--origin needs an address}"; shift 2 ;;
    --local-only) local_only=yes; shift ;;
    -h | --help) sed -n '2,16p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown option $1 (see --help)" ;;
  esac
done
case "$port" in '' | *[!0-9]*) fail "--port must be a number" ;; esac
case "$version" in latest | [0-9]*.[0-9]*.[0-9]*) ;; *) fail "--version takes a release such as 1.2.3" ;; esac
if [ "$local_only" = yes ] && [ -n "$origin" ]; then fail "--origin and --local-only contradict each other"; fi

# ---- what this needs
command -v curl >/dev/null || fail "curl is needed"
command -v docker >/dev/null || fail "Docker is needed: https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || fail "Docker is installed but not running, or this user may not use it. Start Docker and run this again."
compose="$(docker compose version --short 2>/dev/null || true)"
[ -n "$compose" ] || fail "Docker Compose v2 is needed (the docker compose command)"
major="${compose%%.*}" rest="${compose#*.}" minor="${rest%%.*}"
if [ "${major//[!0-9]/}" -lt 2 ] || { [ "${major//[!0-9]/}" -eq 2 ] && [ "${minor//[!0-9]/}" -lt 24 ]; }; then
  fail "Docker Compose 2.24 or later is needed (this is $compose)"
fi
if [ -e "$dir/compose.yml" ]; then
  fail "Stuga is already installed in $dir. To upgrade it, run: $dir/stuga upgrade"
fi

# ---- the address other devices use
this_machine() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
  fi
  if [ -z "$ip" ] && command -v ipconfig >/dev/null 2>&1; then
    ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  printf '%s' "$ip"
}
if [ "$local_only" = yes ]; then
  origin="http://localhost:$port"
elif [ -z "$origin" ]; then
  ip="$(this_machine)"
  if [ -n "$ip" ]; then origin="http://$ip:$port"; else origin="http://localhost:$port"; fi
fi
origin="${origin%/}"
case "$origin" in http://* | https://*) ;; *) fail "--origin must be an http(s) address, got $origin" ;; esac

# Whether an IPv4 address is public: not private, carrier-grade NAT, loopback or link-local.
public_ipv4() {
  case "$1" in
    10.* | 127.* | 192.168.* | 169.254.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) return 1 ;;
    100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) return 1 ;;
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}
host="${origin#*://}" host="${host%%[:/]*}"
# Over plain http at a public address (a server), a password is taken only from the node's own
# network: setup goes through an SSH tunnel to this machine (docs/install/docker.md, On a server).
tunnel=no
case "$origin" in http://*) if public_ipv4 "$host"; then tunnel=yes; fi ;; esac

# ---- the release's files
if [ "$version" = latest ]; then base="$RELEASES/latest/download"; else base="$RELEASES/download/v$version"; fi
say "Installing Stuga into $dir"
mkdir -p "$dir"
cd "$dir"
for f in compose.yml env.example stuga; do
  curl -fsSL -o "$f" "$base/$f" || fail "could not download $f from $base"
done
chmod +x stuga
ok "downloaded $(sed -n 's|^    image: .*/stuga-node:||p' compose.yml | head -1)"

# Only this user reads it: it gets the database password.
(umask 077 && cp env.example .env)
{
  printf '\n# Written by install.sh\n'
  printf 'PUBLIC_ORIGIN=%s\n' "$origin"
  [ "$port" = 8787 ] || printf 'HOST_PORT=%s\n' "$port"
  if [ "$local_only" = yes ]; then
    printf 'HOST_BIND=127.0.0.1\n'
  elif [ "$origin" != "http://localhost:$port" ]; then
    printf 'EXTRA_ORIGINS=http://localhost:%s\n' "$port"
  fi
} >> .env
# Made by this user, so the bind mounts do not create them as root.
mkdir -p data/node backups
ok "wrote .env (address $origin)"

# ---- start, and wait until it serves
say "Starting Stuga (the first start downloads the images)"
# Also on a stuga_pgdata volume an earlier install left, whose password this .env does not know.
# A release from before the database had its own password has no such step.
if grep -q 'POSTGRES_PASSWORD:-' compose.yml; then
  ./stuga db-password </dev/null || fail "could not give the database a password"
fi
docker compose up -d
# A node that refuses the data here, or stops, will not serve however long this waits.
node_id="$(docker compose ps -a -q node </dev/null 2>/dev/null | head -1 || true)"
restarts="$(docker inspect -f '{{.RestartCount}}' "$node_id" 2>/dev/null || echo 0)"
waited=0
until curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$port/ready" 2>/dev/null; do
  status="$(curl -sS --max-time 5 "http://127.0.0.1:$port/ready" 2>/dev/null | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' || true)"
  if [ "$status" = refused ]; then
    why="$(docker compose logs --no-log-prefix --tail 50 node </dev/null 2>/dev/null | sed -n 's/.*refusing this database: //p' | tail -1 || true)"
    fail "Stuga refuses the data here: ${why:-a newer Stuga served it last.}
       See Roll back in docs/install/docker.md."
  fi
  state="$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$node_id" 2>/dev/null || true)"
  case "$state" in
    exited\ * | dead\ * | restarting\ *) stopped=yes ;;
    *\ *) if [ "${state#* }" -gt "$restarts" ]; then stopped=yes; else stopped=no; fi ;;
    *) stopped=no ;;
  esac
  if [ "$stopped" = yes ]; then
    docker compose logs --tail 20 node </dev/null >&2 || true
    fail "Stuga stopped while starting; the end of its log is above. All of it: cd $dir && docker compose logs node"
  fi
  if [ "$waited" -ge 900 ]; then fail "Stuga did not start within 15 minutes. Its log: cd $dir && docker compose logs node"; fi
  sleep 3
  waited=$((waited + 3))
done
ok "Stuga is running"

# </dev/null: piped from curl, this script is bash's stdin, and exec would swallow the rest of it.
code="$(docker compose exec -T node cat /data/setup-code </dev/null 2>/dev/null | tr -d '[:space:]' || true)"
say ""
if [ -n "$code" ] && [ "$tunnel" = yes ]; then
  say "Create the administrator account through an SSH tunnel: passwords over plain http work only"
  say "from this machine's own network. From your computer:"
  say ""
  say "    ssh -L $port:127.0.0.1:$port <this machine>"
  say ""
  say "then open http://localhost:$port/login?setup=$code"
  say ""
elif [ -n "$code" ]; then
  say "Open this link to create the administrator account:"
  say ""
  say "    $origin/login?setup=$code"
  say ""
fi
[ "$local_only" = yes ] || say "Other devices on your network use $origin"
say "Commands for this node: cd $dir && ./stuga (status, backup, upgrade…)"
