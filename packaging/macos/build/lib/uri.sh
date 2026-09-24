# shellcheck shell=bash
# uri_path <path>: the path for a libpq URI's host= parameter, every byte but unreserved
# characters and / percent-encoded.
uri_path() {
  local hex out=""
  for hex in $(printf '%s' "$1" | od -An -v -tx1); do
    case "$hex" in
      2[d-f] | 3[0-9] | 4[1-9a-f] | 5[0-9af] | 6[1-9a-f] | 7[0-9ae]) out="$out$(printf '%b' "\\x$hex")" ;;
      *) out="$out%$(printf '%s' "$hex" | tr a-f A-F)" ;;
    esac
  done
  printf '%s' "$out"
}
