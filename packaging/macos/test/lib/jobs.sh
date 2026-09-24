# shellcheck shell=bash disable=SC2154
# A built runtime's launchd jobs, run without launchd: each job's ProgramArguments with only its
# plist's environment and launchd's PATH. The sourcing script sets, before calling these:
#   runtime   the runtime directory
#   work      a scratch directory, the jobs' HOME

LAUNCHD_PATH=/usr/bin:/bin:/usr/sbin:/sbin

# plist_values <plist> <key>: the key's dictionary as KEY=value, or its array, NUL-separated.
plist_values() {
  # shellcheck disable=SC2016 # JavaScript, not shell
  plutil -convert json -o - "$1" | "$runtime/node/bin/node" -e '
    const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"))[process.argv[1]] ?? {};
    const items = Array.isArray(value) ? value : Object.entries(value).map(([k, v]) => `${k}=${v}`);
    process.stdout.write(items.map((item) => `${item}\0`).join(""));
  ' "$2"
}

# job_env <plist>: fills `job` with env -i, launchd's PATH, the plist's environment and its program.
job_env() {
  local item
  job=(env -i PATH="$LAUNCHD_PATH" HOME="$work")
  while IFS= read -r -d '' item; do job+=("$item"); done < <(plist_values "$1" EnvironmentVariables)
  while IFS= read -r -d '' item; do job+=("$item"); done < <(plist_values "$1" ProgramArguments)
}

# cli_env <node plist>: fills `cli` with the node job's environment and stuga-node, as an operator
# command on that machine runs it.
cli_env() {
  local item
  cli=(env -i PATH="$LAUNCHD_PATH" HOME="$work")
  while IFS= read -r -d '' item; do cli+=("$item"); done < <(plist_values "$1" EnvironmentVariables)
  cli+=("$runtime/node/bin/node" "$runtime/app/services/node/bin/stuga-node.js")
}

# free_port: a TCP port nothing listens on right now.
free_port() {
  "$runtime/node/bin/node" -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })'
}
