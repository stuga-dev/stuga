// postinstall's ensure_account and free_id, run as the package runs them (set -euo pipefail) against a
// dscl that keeps its records in a directory: a fresh Mac, a user left without its group, and both there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = readFileSync(new URL("../pkg/scripts/postinstall", import.meta.url), "utf8");
const fn = (name) => {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, "m").exec(script);
  assert.ok(m, `postinstall defines ${name}`);
  return m[0];
};

// Records are files: $DB/Users/<name>/<attribute> holds the value.
const FAKE_DSCL = `
dscl() {
  local verb="$2" path="$3" dir
  dir="$DB$path"
  case "$verb" in
    -read)
      [ -d "$dir" ] || { echo "DS Error: -14136 (eDSRecordNotFound)" >&2; return 56; }
      [ $# -ge 4 ] && { [ -f "$dir/$4" ] || return 181; echo "$4: $(cat "$dir/$4")"; }
      return 0 ;;
    -create)
      mkdir -p "$dir"
      [ $# -ge 5 ] && printf '%s' "$5" > "$dir/$4"
      return 0 ;;
    -list)
      local r
      for r in "$DB$path"/*; do [ -f "$r/$4" ] && echo "$(basename "$r") $(cat "$r/$4")"; done
      return 0 ;;
  esac
}
`;

function run(setup) {
  const db = mkdtempSync(join(tmpdir(), "stuga-dscl-"));
  try {
    const body = `set -euo pipefail\nDB="${db}"\n${FAKE_DSCL}\n${fn("free_id")}\n${fn("ensure_account")}\n${setup}\n` +
      `ensure_account _stuga "Stuga"\nensure_account _stugaremote "Stuga remote access"\n` +
      `for n in _stuga _stugaremote; do echo "$n user=$(cat "$DB/Users/$n/UniqueID") pgid=$(cat "$DB/Users/$n/PrimaryGroupID") group=$(cat "$DB/Groups/$n/PrimaryGroupID")"; done\n`;
    return execFileSync("bash", ["-c", body], { encoding: "utf8" });
  } finally {
    rmSync(db, { recursive: true, force: true });
  }
}

// A system group already at 250, as on a real Mac.
const SYSTEM = `dscl . -create /Groups/_analyticsusers PrimaryGroupID 250\n`;

test("creates both accounts on a fresh Mac, each user in its own group", () => {
  assert.equal(run(SYSTEM), "_stuga user=251 pgid=251 group=251\n_stugaremote user=252 pgid=252 group=252\n");
});

test("gives a user left without its group the group back at its old id", () => {
  const orphan = `dscl . -create /Users/_stuga UniqueID 255\ndscl . -create /Users/_stuga PrimaryGroupID 255\n`;
  assert.equal(run(SYSTEM + orphan), "_stuga user=255 pgid=255 group=255\n_stugaremote user=251 pgid=251 group=251\n");
});

test("leaves accounts that are already there alone", () => {
  const both = ["_stuga 260", "_stugaremote 261"]
    .map((s) => s.split(" "))
    .map(([n, id]) => `dscl . -create /Users/${n} UniqueID ${id}\ndscl . -create /Users/${n} PrimaryGroupID ${id}\ndscl . -create /Groups/${n} PrimaryGroupID ${id}\n`)
    .join("");
  assert.equal(run(SYSTEM + both), "_stuga user=260 pgid=260 group=260\n_stugaremote user=261 pgid=261 group=261\n");
});
