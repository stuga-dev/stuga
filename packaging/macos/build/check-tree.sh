#!/usr/bin/env bash
# Prove a Postgres tree is self-contained and carries the pinned versions.
#
#   packaging/macos/build/check-tree.sh <tree>
#
# Fails when:
#   - an arm64 LC_LOAD_DYLIB / LC_LOAD_WEAK_DYLIB / LC_REEXPORT_DYLIB is not /usr/lib/…,
#     /System/Library/…, or @loader_path/… resolving (every symlink followed) to an arm64
#     Mach-O inside the tree. @rpath fails too: its answer depends on who loads the library.
#   - an LC_RPATH is absolute, or a symlink dangles or leaves the tree.
#   - an extension's SQL loads a module lib/postgresql lacks, or `requires` names an
#     extension without a control file.
#   - the server major, pgvector or pg_search differ from packaging/versions.env.
#
# LC_ID_DYLIB is only counted: dyld never reads a library's own install name when loading.
# Not visible here: paths passed to dlopen() at run time (see libpq-oauth in prune.sh).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../versions.env
. "$here/../../versions.env"
# shellcheck source=lib/devtools.sh
. "$here/lib/devtools.sh"

tree="${1:-}"
[ -n "$tree" ] || { echo "usage: $0 <tree>" >&2; exit 2; }
tree="$(cd "$tree" && pwd -P)"

for required in bin/postgres bin/initdb lib/postgresql share/postgresql/extension; do
  [ -e "$tree/$required" ] || { echo "FAIL $required is missing; not a Postgres tree" >&2; exit 1; }
done
# lipo and otool are developer-tool shims; one that cannot run would read as a FAIL per file.
use_working_developer_tools
if ! lipo -archs "$tree/bin/postgres" > /dev/null || ! otool -h "$tree/bin/postgres" > /dev/null; then
  echo "error: lipo or otool cannot run (install the Command Line Tools, or accept the Xcode license)" >&2
  exit 1
fi

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

fail=0
machos=0
ids_absolute=0

is_macho() {
  [ -f "$1" ] || return 1
  case "$(head -c 4 "$1" | od -An -tx1 | tr -d ' \n')" in
    cafebabe | cffaedfe | cefaedfe | bebafeca) return 0 ;;
    *) return 1 ;;
  esac
}

has_arm64() { lipo -archs "$1" 2>/dev/null | tr ' ' '\n' | grep -qx arm64; }

# The physical path of $1 with every symlink followed, the last component included; fails
# for a dangling link or a loop. bash 3.2 has no realpath, and `pwd -P` resolves only dirs.
resolve() {
  local p="$1" dir link hops=0
  while :; do
    dir="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
    p="$dir/$(basename "$p")"
    [ -L "$p" ] || break
    link="$(readlink "$p")"
    case "$link" in /*) p="$link" ;; *) p="$dir/$link" ;; esac
    hops=$((hops + 1))
    [ "$hops" -lt 40 ] || return 1
  done
  [ -e "$p" ] || return 1
  printf '%s' "$p"
}

inside_tree() { case "$1" in "$tree"/*) return 0 ;; *) return 1 ;; esac; }

# Into files rather than process substitution, so a failing find fails the check.
find "$tree/bin" "$tree/lib" "$tree/share" -type l -print0 > "$scratch/links"
while IFS= read -r -d '' link; do
  if ! resolved="$(resolve "$link")"; then
    echo "FAIL ${link#"$tree"/}: dangling symlink"
    fail=1
  elif ! inside_tree "$resolved"; then
    echo "FAIL ${link#"$tree"/}: symlink leaves the tree ($resolved)"
    fail=1
  fi
done < "$scratch/links"

find "$tree/bin" "$tree/lib" -type f -print0 > "$scratch/files"
while IFS= read -r -d '' f; do
  is_macho "$f" || continue
  machos=$((machos + 1))
  rel="${f#"$tree"/}"

  if ! has_arm64 "$f"; then
    echo "FAIL $rel: no arm64 slice"
    fail=1
    continue
  fi

  otool -arch arm64 -l "$f" | awk '
    $1 == "cmd"  { cmd = $2 }
    $1 == "name" && (cmd == "LC_LOAD_DYLIB" || cmd == "LC_LOAD_WEAK_DYLIB" || cmd == "LC_REEXPORT_DYLIB" || cmd == "LC_ID_DYLIB") { print cmd, $2 }
    $1 == "path" && cmd == "LC_RPATH" { print cmd, $2 }
  ' > "$scratch/commands"

  while read -r cmd name; do
    case "$cmd" in
      LC_ID_DYLIB)
        case "$name" in /*) ids_absolute=$((ids_absolute + 1)) ;; esac
        ;;
      LC_RPATH)
        case "$name" in
          /*) echo "FAIL $rel: absolute LC_RPATH $name"; fail=1 ;;
        esac
        ;;
      *)
        case "$name" in
          /usr/lib/* | /System/Library/*) ;;
          @loader_path/*)
            if ! target="$(resolve "$(dirname "$f")/${name#@loader_path/}")"; then
              echo "FAIL $rel: $name does not exist in the tree"
              fail=1
            elif ! inside_tree "$target"; then
              echo "FAIL $rel: $name resolves outside the tree ($target)"
              fail=1
            elif ! is_macho "$target" || ! has_arm64 "$target"; then
              echo "FAIL $rel: $name is not a Mach-O file with an arm64 slice"
              fail=1
            fi
            ;;
          *) echo "FAIL $rel: loads $name"; fail=1 ;;
        esac
        ;;
    esac
  done < "$scratch/commands"
done < "$scratch/files"

module_exists() { is_macho "$tree/lib/postgresql/$1.dylib" || is_macho "$tree/lib/postgresql/$1"; }

controls=0
for control in "$tree"/share/postgresql/extension/*.control; do
  [ -f "$control" ] || continue
  controls=$((controls + 1))
  ext="$(basename "$control" .control)"
  # module_pathname matters only to scripts that say MODULE_PATHNAME: pldbgapi's control
  # names a module that does not exist, and its SQL names '$libdir/plugin_debugger' directly.
  module="$(sed -n "s/^[[:space:]]*module_pathname[[:space:]]*=[[:space:]]*'\\\$libdir\/\([^']*\)'.*/\1/p" "$control")"
  if [ -n "$module" ] && ! module_exists "$module" \
     && grep -qs MODULE_PATHNAME "$tree/share/postgresql/extension/$ext"--*.sql; then
    echo "FAIL extension $ext: module $module is not in lib/postgresql"
    fail=1
  fi
  # shellcheck disable=SC2016 # a literal $libdir
  { grep -hos '\$libdir/[A-Za-z0-9_.-]*' "$tree/share/postgresql/extension/$ext"--*.sql || true; } \
    | sed 's|^\$libdir/||' | sort -u > "$scratch/modules"
  while read -r module; do
    if ! module_exists "$module"; then
      echo "FAIL extension $ext: its SQL loads \$libdir/$module, which is not in lib/postgresql"
      fail=1
    fi
  done < "$scratch/modules"
  requires="$(sed -n "s/^[[:space:]]*requires[[:space:]]*=[[:space:]]*'\([^']*\)'.*/\1/p" "$control" | tr ',' ' ')"
  for dep in $requires; do
    if [ ! -f "$tree/share/postgresql/extension/$dep.control" ]; then
      echo "FAIL extension $ext: requires $dep, which has no control file"
      fail=1
    fi
  done
done

check_extension_pin() {
  local found
  found="$(sed -n "s/^[[:space:]]*default_version[[:space:]]*=[[:space:]]*'\([^']*\)'.*/\1/p" \
    "$tree/share/postgresql/extension/$1.control" 2>/dev/null || true)"
  [ "$found" = "$2" ] || { echo "FAIL extension $1 is ${found:-missing}, pinned $2"; fail=1; }
}
check_extension_pin vector "$PGVECTOR_VERSION"
check_extension_pin pg_search "$PG_SEARCH_VERSION"
major="$("$tree/bin/postgres" --version | sed -n 's/^postgres (PostgreSQL) \([0-9]*\)\..*/\1/p')"
[ "$major" = "$PG_MAJOR" ] || { echo "FAIL server major is ${major:-unknown}, pinned $PG_MAJOR"; fail=1; }

echo "checked $machos Mach-O files and $controls extension control files in $tree"
echo "LC_ID_DYLIB entries with an absolute install name (not read by dyld at load time): $ids_absolute"
if [ "$fail" -ne 0 ]; then
  echo "tree is NOT self-contained or not the pinned one" >&2
  exit 1
fi
echo "tree is self-contained: PostgreSQL $PG_MAJOR, pgvector $PGVECTOR_VERSION, pg_search $PG_SEARCH_VERSION"
