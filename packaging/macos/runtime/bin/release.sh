# shellcheck shell=bash
# Which Stuga packages root trusts, sourced by helper.sh, bin/stuga and build-pkg.sh: a release's
# number, where its package comes from, and the checks it passes before `installer` sees it. Policy
# (which version may be installed) stays with each caller. Functions and two settings only: no `set`,
# no trap, no output.
#
# STUGA_TEAM_ID and STUGA_RELEASES_URL are for tests; packaging/shared/connector and the signing
# action read the team from this file.

team="${STUGA_TEAM_ID:-8W9F4LY7AP}"
releases="${STUGA_RELEASES_URL:-https://github.com/stuga-dev/stuga/releases/download}"

# is_release <v>: a plain release such as 1.2.3, numbers without leading zeros. Anything else, a
# build from source included, has no package and no order.
is_release() {
  local re='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
  [[ "$1" =~ $re ]]
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

# package_url <v>: where release v's package is published.
package_url() { printf '%s/v%s/Stuga-%s.pkg\n' "$releases" "$1" "$1"; }

# package_workdir <prefix>: a new directory only its creator can enter, for a package and its checks.
package_workdir() {
  local dir
  dir="$(mktemp -d "/private/var/tmp/$1.XXXXXX")" || return 1
  chmod 0700 "$dir" || return 1
  printf '%s\n' "$dir"
}

# fetch_package <v> <out>: release v's package, downloaded to out.
fetch_package() {
  is_release "$1" || return 1
  curl -fsSL --max-time 1800 -o "$2" "$(package_url "$1")"
}

# check_package <pkg> <v>: the package is release v's, notarized and signed by Stuga's team, in a
# directory nobody but root can change before `installer` reads it. Else 1, with package_problem
# saying why. Run as root, it requires the directory to be root's 0700 one.
# shellcheck disable=SC2034 # package_problem is the caller's to read
check_package() {
  local pkg="$1" wanted="$2" dir verdict shipped
  package_problem=""
  dir="$(dirname "$pkg")"
  if [ "$(id -u)" -eq 0 ] && [ "$(stat -f '%u %Lp' "$dir" 2> /dev/null)" != "0 700" ]; then
    package_problem="the package is not in a directory only root can write"
    return 1
  fi
  if ! verdict="$(spctl --assess --type install -vv "$pkg" 2>&1)" ||
    ! printf '%s\n' "$verdict" | grep -q '^source=Notarized Developer ID$' ||
    ! printf '%s\n' "$verdict" | grep -Eq "^origin=Developer ID Installer: .* \\($team\\)$"; then
    package_problem="the package is not notarized and signed by Stuga ($team)"
    return 1
  fi
  shipped="$(cd "$dir" && xar -xf "$pkg" Distribution && sed -n 's/.*<product[^>]* version="\([0-9.]*\)".*/\1/p' Distribution | head -1)" || shipped=""
  if [ "$shipped" != "$wanted" ]; then
    package_problem="the package is Stuga ${shipped:-of no version}, not $wanted"
    return 1
  fi
}
