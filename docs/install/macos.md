# Install on macOS

Stuga runs on a Mac with Apple silicon, on macOS 13 or later. There are two ways to install it:

- **The package**, for running Stuga: download it, open it, and your browser opens the setup page.
- **A build from a checkout** of this repository, for working on Stuga itself
  ([below](#build-from-a-checkout)).

## Install the package

Download [Stuga.pkg](https://github.com/stuga-dev/stuga/releases/latest/download/Stuga.pkg) and open
it. The installer asks for an administrator's password. When it finishes, your browser opens
Stuga's setup page with the node's setup code filled in, and the Stuga mark appears in the menu bar.
Continue with [Getting started](../getting-started.md).

Stuga then runs as two system services, its Postgres and its node, under the hidden account
`_stuga`. They start when the Mac starts, before anyone logs in, so a Mac mini with no screen serves
your team after a power cut. With FileVault on, a Mac waits for someone to unlock its disk after a
power cut before anything starts; `sudo fdesetup authrestart` restarts it without that, once.

The package is signed by Stuga's developer and notarized by Apple, and nothing is compiled on your
Mac: it carries its own Postgres (Postgres.app's build with pgvector, plus ParadeDB's pg_search) and
its own Node.js. pg_search's macOS build is published by ParadeDB and not tested by them; Stuga runs
its Postgres test suites against this exact build before every release.

### The menu bar

| Item | |
|---|---|
| The status line | `Running at <address>`, `Ready to set up at <address>`, `Starting…`, or `Stuga is not answering`. |
| **Open Stuga** | Opens the node in your browser. While nobody has claimed it, **Set Up Stuga…** reads the setup code, which needs an administrator's password, and opens the setup page. |
| **Copy Address** | Copies the address other devices use. While nobody has claimed the node it is **Copy Setup Link**, which copies the setup page's link with the code in it, for setting up from another browser. |
| **Show Address as QR Code…** | Shows that address for a phone's camera; while nobody has claimed the node, **Show Setup Link as QR Code…** shows the setup link instead. |
| **Show Logs** | Opens `/Library/Logs/Stuga`. |
| **Restart Stuga…** | Restarts Postgres and the node, after an administrator's password. |
| **Uninstall Stuga…** | Removes Stuga, keeping or deleting its data. |
| **Quit Menu** | Quits the menu only. Stuga keeps running. |

Double-clicking Stuga in Applications opens the node too.

### Network

The node listens on every address of the Mac, and its address (`PUBLIC_ORIGIN`) is
`http://<the Mac's local host name>.local:8787`, which invite links carry. A device that cannot
resolve `.local` names opens the node by the Mac's IP address instead. If the macOS firewall asks
whether `node` may accept incoming connections, allow it. Only whoever has the setup code can claim
the node, so it is safe on the network from its first start. Plain http on a network is not
encrypted; [Network access](../network-access.md) explains what each way of reaching the node
protects.

### Updates and backups

**Settings → This node → About** names a newer version once the node knows of one, and **Update
now** installs it: the Mac downloads that release's package, checks that Apple notarized it and that
Stuga's developer signed it, and installs it. Opening a newer `Stuga.pkg` yourself does the same.
Either way the new version backs up the data before it changes anything.

The node backs itself up every day at 03:00, into `/Library/Application Support/Stuga/data/backups`,
keeping the newest seven ([Operations](../operations.md#the-nodes-own-backups)). Time Machine, when
it is on, keeps copies of those; the live database is excluded from Time Machine on purpose.

### Where things live

| Path | Holds |
|---|---|
| `/Applications/Stuga.app` | The menu-bar app. |
| `/Library/Application Support/Stuga/runtime/<version>/` | The runtime: Postgres, Node.js, Stuga, and the scripts launchd runs. `THIRD-PARTY-NOTICES.txt` there lists the licenses of what it redistributes. `current` points at the one in use; the one before it is kept. |
| `/Library/Application Support/Stuga/data/` | The Postgres cluster (`pgdata`), the node's data directory (`node`, `DATA_DIR`) and the backups (`backups`), owned by `_stuga`. |
| `/Library/LaunchDaemons/dev.stuga.{postgres,node,helper}.plist` | The services' definitions. `helper` installs a newer package when the node asks. |
| `/Library/Logs/Stuga/` | The node's log, one file per weekday, and the services' own. |

To set another environment variable from [Configuration](../configuration.md), add it to
`/Library/LaunchDaemons/dev.stuga.node.plist` and reload the node:

```sh
sudo plutil -replace EnvironmentVariables.MEDIA_COOKIE_SAMESITE -string strict /Library/LaunchDaemons/dev.stuga.node.plist
sudo launchctl bootout system/dev.stuga.node
sudo launchctl bootstrap system /Library/LaunchDaemons/dev.stuga.node.plist
```

An upgrade keeps the variables you added. The ones the package sets itself go back to its values,
except `PUBLIC_ORIGIN`, which it keeps.

### stuga-node commands

The operator commands in [Operations](../operations.md) run as `_stuga`, with the node's
environment. This shell function reads it from the node's definition. Add it to `~/.zshrc`:

```sh
stuga-node() (
  plist=/Library/LaunchDaemons/dev.stuga.node.plist
  root="/Library/Application Support/Stuga"
  vars=()
  for key in $(plutil -extract EnvironmentVariables raw -o - "$plist"); do
    vars+=("$key=$(plutil -extract "EnvironmentVariables.$key" raw -o - "$plist")")
  done
  cd "$root/data" && sudo -u _stuga env "${vars[@]}" "$root/current/node/bin/node" "$root/current/app/services/node/bin/stuga-node.js" "$@"
)
```

`reset-password`, `media-scan`, `verify` and `list` run beside a running node. `restore` needs the
node stopped, and Postgres running:

```sh
sudo launchctl bootout system/dev.stuga.node
stuga-node restore <backup>
sudo launchctl bootstrap system /Library/LaunchDaemons/dev.stuga.node.plist
```

### Uninstall

Choose **Uninstall Stuga…** in the menu, or:

```sh
sudo "/Library/Application Support/Stuga/current/bin/uninstall.sh"                 # keeps the data
sudo "/Library/Application Support/Stuga/current/bin/uninstall.sh" --delete-data   # and deletes it
```

Kept data is used again by the next install.

## Build from a checkout

Stuga.app, built from a checkout, is a menu-bar app that runs Stuga's Postgres and node as your own
user, under launchd, from that checkout. It is how Stuga is worked on. You build it with
`packaging/macos/local-trial/build.sh`, which downloads the same pinned Postgres and Node.js as the
package.

### Requirements

- A Mac with Apple silicon, on macOS 13 or later.
- The Xcode Command Line Tools, for `git` and `swiftc`: `xcode-select --install`.
- Node.js 26 and pnpm 12, to build the web app.
- Internet access during the build. The Postgres and Node.js downloads are checked against the
  checksums pinned in `packaging/versions.env`.

### Build and start

```sh
git clone https://github.com/stuga-dev/stuga.git
cd stuga
packaging/macos/local-trial/build.sh
open ~/Applications/Stuga.app
```

The first time it opens, Stuga.app creates the database cluster, starts Postgres and the node, waits
until the node serves, and opens the setup page in your browser with the node's setup code filled
in, so only you can claim it. The Stuga mark in the menu bar is dimmed until Stuga is running.
Continue with [Getting started](../getting-started.md).

Stuga.app runs the node from the checkout it was built from, so keep the checkout where it is.
Switching branches or rebuilding the web app in it changes what Stuga runs.

`build.sh` takes these flags:

| Flag | |
|---|---|
| `--port <n>` | The node's port. Default `8787`. |
| `--origin <url>` | The address other devices use, such as `http://192.168.1.50:8787`. By default the address follows the Mac's local host name. |
| `--local-only` | Serve this Mac only. |
| `--app-dir <dir>` | Where Stuga.app goes. Default `~/Applications`. |
| `--identity <name>` | Sign the Postgres tree and the app with this code-signing identity, which turns on library validation. Without it the app is signed ad hoc. |
| `--postgres-tree <dir>` | Copy this Postgres tree instead of the pinned one. |
| `--skip-web-build` | Use the checkout's web app and MCP server builds as they are. |
| `--uninstall` | Remove the app and the runtime, and keep the data. |

The flags are not remembered. Pass the same ones every time you rebuild.

### Network

By default the node listens on every IPv4 interface (`BIND=0.0.0.0`), and its address
(`PUBLIC_ORIGIN`) is `http://<local host name>.local:8787`. Stuga.app works the address out again at
every start, so renaming the Mac moves it, everyone signs in again, and a node you have not named
takes the new name. On the Mac itself,
`http://127.0.0.1:8787` works too: it needs no network, and the browser treats it as a secure
context. Postgres listens only on a socket inside the data folder.

- If the macOS firewall asks whether `node` may accept incoming connections, allow it, or other
  devices get no answer.
- A device that cannot resolve `.local` names opens the node by the Mac's IP address. For invite
  links to carry that address, rebuild with `--origin http://<the Mac's IP address>:8787`, and
  reserve that address on your router.
- With `--local-only`, the node listens on `127.0.0.1` only and its address is
  `http://127.0.0.1:8787`.
- The node does not answer over IPv6. To accept IPv6 as well as IPv4, set `BIND` to `::` in the
  node's job definition (see [Other environment variables](#other-environment-variables)). A
  rebuild sets it back.

Plain http on a network is not encrypted. [Network access](../network-access.md) explains what each
way of reaching the node protects, and how to put HTTPS in front of it.

### The menu bar

| Item | |
|---|---|
| The status line | `Running at <address>`, `Starting…`, `Stuga is stopped`, or `Could not start:` with the reason. |
| **Open Stuga** | Opens the node's address in your browser, or its setup page while nobody has claimed it. |
| **Copy Address** | Copies the address other devices use, or the setup link (**Copy Setup Link**) while nobody has claimed the node. It is absent with `--local-only`. |
| **Stop** / **Start** | Stops or starts Postgres and the node. |
| **Show Logs** | Opens the logs folder. |
| **Show Data Folder** | Opens the data folder. |
| **Quit Stuga** | Stops the node and Postgres, then quits. |

Stuga runs only while Stuga.app is open. It does not start at login.

### Where things live

| Path | Holds |
|---|---|
| `~/Applications/Stuga.app` | The menu-bar app. |
| `~/Library/Application Support/Stuga Local/runtime/local-<commit>/` | The runtime: Postgres, Node.js, a link to the checkout, and the launchd wrappers. `current` points at it. |
| `~/Library/Application Support/Stuga Local/launchd/` | The Postgres and node job definitions. |
| `~/Library/Application Support/Stuga Local/data/pgdata/` | The Postgres cluster. Its server log is `pgdata/log/postgresql-<Day>.log`, one file per UTC weekday. |
| `~/Library/Application Support/Stuga Local/data/node/` | The node's data directory (`DATA_DIR`). |
| `~/Library/Application Support/Stuga Local/data/backups/` | Backups (`BACKUP_DIR`): the node's daily ones, the one it takes before an upgrade, and yours. Time Machine, when it is on, keeps copies of them. |
| `~/Library/Application Support/Stuga Local/cache/` | Downloads, and the assembled Postgres tree. |
| `~/Library/Logs/Stuga Local/` | `node-<Day>.log` is the node's log, one file per UTC weekday, each overwritten a week later. `node-wrapper.log`, `postgres.log` and `init-cluster.log` hold what happens before the node and Postgres start logging. |

### Other environment variables

The build flags set the node's address and port. To set any other variable from
[Configuration](../configuration.md), add it to the node's job definition, then choose **Stop** and
**Start** in the menu bar:

```sh
plutil -replace EnvironmentVariables.MEDIA_COOKIE_SAMESITE -string strict \
  "$HOME/Library/Application Support/Stuga Local/launchd/dev.stuga.local.node.plist"
```

A rebuild writes that file again. It keeps the variables you added, and prints a `kept` line for
each. It writes the variables the build sets itself from its flags and paths again, whatever the
file said, and prints a `replaced` line for each one whose value it changes: `PUBLIC_ORIGIN`,
`EXTRA_ORIGINS`, `BIND`, `PORT`, `DATA_DIR`, `DATABASE_URL`, `PG_BIN`, `NODE_ENV`, `STUGA_ROOT`,
`STUGA_LOG_DIR` and `STUGA_RESTART_HINT`. `--uninstall` removes the file.

### stuga-node commands

The operator commands are the node's own `stuga-node` commands, described in
[Operations](../operations.md). They need the node's environment. This shell function reads it from
the node's job definition. Add it to `~/.zshrc`:

```sh
stuga-node() (
  root="$HOME/Library/Application Support/Stuga Local"
  plist="$root/launchd/dev.stuga.local.node.plist"
  for key in $(plutil -extract EnvironmentVariables raw -o - "$plist"); do
    export "$key=$(plutil -extract "EnvironmentVariables.$key" raw -o - "$plist")"
  done
  cd "$root/data" && "$root/current/node/bin/node" "$root/current/app/services/node/bin/stuga-node.js" "$@"
)
```

`reset-password`, `media-scan`, `verify` and `list` run beside a running node. `backup` and
`restore` refuse while the node runs, so stop the node alone, leaving Postgres running:

```sh
launchctl bootout "gui/$(id -u)/dev.stuga.local.node"
stuga-node backup
```

Then choose **Start** in the menu bar. If `backup` still reports that the node is running, it has
not finished stopping. Run it again a few seconds later.

A restore keeps what it replaced. Once you are satisfied, remove both copies. `stuga-node list`
names them:

```sh
root="$HOME/Library/Application Support/Stuga Local"
"$root/current/postgres/bin/psql" -h "$root/data/run" -U stuga -d postgres \
  -c 'DROP DATABASE "stuga_replaced_<stamp>"'
rm -rf "$root/data/node.replaced-<stamp>"
```

### Update

A Stuga.app built from a checkout carries no release version, so it never looks for a newer one and
**Settings → This node → About** calls it built from source
([Operations](../operations.md#learning-of-a-new-version)). Follow the repository's releases instead.

Take a backup, then update the checkout and rebuild with the flags you used before:

```sh
git pull
packaging/macos/local-trial/build.sh
open ~/Applications/Stuga.app
```

`build.sh` quits Stuga.app and stops Postgres and the node before it replaces the runtime. The node
migrates the database when it next starts.

To go back to an earlier version, stop the node and restore the backup you took before updating,
and do not start the node again. Then check out the earlier commit, rebuild, and open Stuga.app.

### Uninstall

```sh
packaging/macos/local-trial/build.sh --uninstall
```

This quits Stuga.app, stops both services, and removes the app, the runtime, the job definitions and
the cache. If you built with `--app-dir`, pass it here too. Your data stays in
`~/Library/Application Support/Stuga Local/data`. To remove everything, delete
`~/Library/Application Support/Stuga Local` and `~/Library/Logs/Stuga Local`.
