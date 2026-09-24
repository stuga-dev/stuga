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
# .env with this machine's address on the network as PUBLIC_ORIGIN, starts the stack, waits until
# the node serves, and prints the link that sets it up. Written for bash 3.2.
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
    -h | --help) sed -n '2,15p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
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

cp env.example .env
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
docker compose up -d
waited=0
until curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$port/ready" 2>/dev/null; do
  if [ "$waited" -ge 900 ]; then fail "Stuga did not start within 15 minutes. Its log: cd $dir && docker compose logs node"; fi
  sleep 3
  waited=$((waited + 3))
done
ok "Stuga is running"

code="$(docker compose exec -T node cat /data/setup-code 2>/dev/null | tr -d '[:space:]' || true)"
say ""
if [ -n "$code" ]; then
  say "Open this link to create the administrator account:"
  say ""
  say "    $origin/login?setup=$code"
  say ""
fi
[ "$local_only" = yes ] || say "Other devices on your network use $origin"
say "Commands for this node: cd $dir && ./stuga (status, backup, upgrade…)"
