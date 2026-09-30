# Platform contract

What every packaging of Stuga provides, and what the app provides back. Docker (`packaging/docker`)
and the Mac runtime (`packaging/macos`) are two implementations of this contract. The app itself
has no platform branches. Anything a platform needs beyond this contract lives in its packaging
directory.

## Pins

`packaging/versions.env` lists every pinned input: Node, pnpm, the Postgres major, pgvector,
pg_search, Postgres.app, the Debian line and the PGDG key, and for the remote-access connector the
frp commit, Go and go-licenses. Downloads are pinned by sha256.
`INITDB_ARGS` is the one cluster spec for both platforms.
`packaging/check-pins.sh` fails when `.nvmrc`, the root `package.json` (`packageManager`,
`@types/node`) or a Dockerfile `ARG` default disagrees with it. It also fails when the Postgres
major the node accepts differs.

## The app tree

`packaging/shared/build-app.sh <out> [--version V]` builds the tree both platforms run:

```
<out>/VERSION                     only with --version
<out>/RELEASED                    only when CHANGELOG.md dates that version
<out>/LICENSE, <out>/NOTICE       Stuga's license and copyright notice
<out>/TRADEMARKS.md               the terms for the name and logo, which NOTICE points to
<out>/apps/web/dist/              the built web app, with third-party-licenses.txt for the npm packages it bundles
<out>/integrations/skills/, LICENSE  the Stuga skill the agent installers hand out, and its MIT license
<out>/services/node/bin/stuga-node.js
<out>/services/node/dist/         stuga-node.mjs, the node and every npm package it runs in one ES module, with its
                                  source map, third-party-licenses.txt, the migration SQL and icon.png
<out>/services/node/node_modules/@stuga/mcp/  package.json and dist/: stuga-mcp.js, LICENSE and
                                  third-party-licenses.txt, which agent setup names and the desktop extension carries
```

The tree holds no TypeScript, tests or native code, so one build runs on any OS and architecture
the pinned Node runs on. The node finds `apps/web/dist`, `integrations/skills` and `VERSION` three
directories above `services/node/dist`, and does not start without the skill. It reads the migration
SQL from the tree at runtime.

Run the tree with the pinned Node:

```
node <out>/services/node/bin/stuga-node.js <command>
```

## Version

`<app>/VERSION` holds one line, the release version. If the file is absent, the node reports
`0.0.0-dev`, a source build. No environment variable overrides it.

`<app>/RELEASED` holds one line, the day the version was released as `YYYY-MM-DD`, taken from the
version's entry in `CHANGELOG.md`. A build of a version the changelog does not list has none.

Only a plain `1.2.3` is compared with the published releases. A node on any other version, a source
build or a CI build, never looks for a newer one.

The version appears in these places:

- **Settings → This node → About**, with the day it was released.
- The boot line, `stuga <version>, schema <n>`.
- The backup manifest: `runtime_version` is the build that took the backup, `stuga_version` the one
  that last served the data, which differ for the backup a new version takes before it upgrades.
- A Docker restore, which uses `stuga_version` to pick the image to go back to. A restore does not
  change image when that is a `0.0.0-*` build.

## Commands

| Command | |
|---|---|
| `serve` | Run the node. |
| `backup [--json]` | Back up the database and the data directory into `BACKUP_DIR`, verified, pruned to the number the node's settings keep. |
| `verify <backup> [--json]` | Check that a backup is whole and that this build can restore it. |
| `restore <backup> [--yes] [--json]` | Replace the database and the data directory. The current ones are kept beside the restored ones. |
| `list [--json]` | List backups, unfinished work, and what restores kept. |
| `reset-password <username>` | Print a password reset link. |
| `media-scan [--reclaim] [--empty-trash[=<days>]] [--grace-hours=<hours>]` | Report or reclaim media that no document references. |
| `archive check <directory> [--json]` | Check an unzipped workspace archive against format version 1, `docs/workspace-archive.md`. Exits 2 when it does not pass. |

A `<backup>` is a path, or a bare name under `BACKUP_DIR`. With `--json`, a command writes one JSON
object to stdout and writes notes and errors to stderr. Without it, `backup` prints
`Backup complete: <path>`.

Exit codes of every command but `serve`:

| Code | Meaning |
|---|---|
| 0 | Done. |
| 2 | Refused, and nothing changed. This includes configuration errors. |
| 3 | Failed, and nothing changed. |
| 4 | Failed after a change. The message says how to put it back. |

`serve` exits 0 when SIGTERM or SIGINT stopped it cleanly. It exits 1 when it cannot start, for a
configuration error too, when it loses the writer lock, and when its shutdown fails or runs out of
time.

`backup` and `restore` refuse to run while a node holds the database's writer lock. Stop the node
first and start it again afterwards. The operator commands never start a node.

## Environment

The environment holds bootstrap, network and secret settings only. Everything the Settings page
edits lives in the database.

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | required | `postgres://user:pass@host:port/db`, or a socket such as `postgres:///stuga?host=<percent-encoded socket dir>&port=<n>&user=<role>`. `PGHOST` is not needed. |
| `DATA_DIR` | required | Blobs, per-actor SQLite stores and keys. Only one node uses a given directory. |
| `BIND` | `127.0.0.1` | The listen address. |
| `PORT` | `8787` | The listen port. |
| `PUBLIC_ORIGIN` | `http://localhost:8787` | The origin people reach the node at. It is also the token issuer, the base of every minted link, and, by its host, what agents call the node until an administrator names it. |
| `EXTRA_ORIGINS` | none | Further exact origins that browsers may call from, comma-separated. |
| `TRUST_PROXY_HEADERS` | `false` | Believe `X-Forwarded-For` and `X-Real-IP` for the client address. Set it only behind a reverse proxy. |
| `TLS_CERT_DIR` | none | A directory of `<host>/fullchain.pem` and `privkey.pem`. When set, the node serves https. |
| `SAMPLES_URL` | `https://github.com/stuga-dev/samples/releases` | Where the sample workspaces come from, laid out as a GitHub release list; a mirror for a network without internet access. |
| `NODE_SIGNING_KEY` | `<DATA_DIR>/identity/signing.jwk` | The session token signing key. |
| `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_SECONDS`, `REFRESH_ROTATION_GRACE_SECONDS` | `3600`, `2592000`, `60` | Session token lifetimes. |
| `AI_EMBED_DIMS` | `1024` | The embedding width. It is fixed when the database is created. |
| `MEDIA_COOKIE_SAMESITE` | `lax` | `lax`, `strict` or `none`. |
| `WEB_DIST_DIR` | `<app>/apps/web/dist` | The web assets. |
| `PG_BIN` | `PATH` | The directory of `pg_dump` and `pg_restore`, of the server's major. |
| `BACKUP_DIR` | `backups` beside `DATA_DIR` | Where backups go. |

### Packaging hints

These are optional. The app has a neutral default for each.

| Variable | Default | Docker | macOS |
|---|---|---|---|
| `STUGA_RESTART_HINT` | `Restart the node to apply.` | `Run docker compose up -d in your Stuga directory to apply it.` | set by `render-launchd.sh` |
| `STUGA_UPGRADE_HINT` | `Upgrade on the machine that runs the node.` | `Run ./stuga upgrade in your Stuga directory: it downloads the release and installs it.` | set by `render-launchd.sh` |
| `STUGA_STDIO_ENTRY` | unset: the bundled `stuga-mcp.js` | `""`: no local path an agent outside the container can open | unset |
| `AI_OLLAMA_DEFAULT_URL` | `http://127.0.0.1:11434` | `http://host.docker.internal:11434` (compose maps the host) | unset |
| `STUGA_UPGRADE_REQUESTS`, `STUGA_UPGRADE_STATUS` | unset: the node offers no install | unset | the package's helper: `<root>/requests` and `<root>/status/upgrade.json` |
| `STUGA_REMOTE_SERVICE`, `STUGA_REMOTE_DIR` | unset: the node offers no remote access | `https://api.stuga.dev` and `/run/stuga-remote` | `https://api.stuga.dev` and `<root>/remote` |
| `STUGA_CONNECTOR_REQUEST`, `STUGA_CONNECTOR_STATUS` | unset: the administrator runs the connector | the `stuga-remote` container: `/run/stuga-remote/control/request` and `/run/stuga-remote/status/status.json` | the package's helper: `<root>/requests/remote` and `<root>/status/remote.json`; unset in the local trial |
| `STUGA_REMOTE_GID`, `STUGA_REMOTE_CONNECTOR_UID` | unset: the node checks the shared directory, and arranges nothing | `65532` and `65532` | unset |

`STUGA_RESTART_HINT` is a full sentence, shown after a change that needs a restart.
`STUGA_UPGRADE_HINT` is a full sentence too, shown to a node administrator beside a newer version.
The app never upgrades itself: the packaging does, on the machine, and the new version backs up the
data before it changes it.
`STUGA_UPGRADE_REQUESTS` and `STUGA_UPGRADE_STATUS` name an upgrade helper that runs beside the node
with more privilege than it: the node writes one line, a release version it knows is newer, as
`<requests>/upgrade`, and reads `{version, state, message, at}` back from the status file. Only
with both set does **About** offer **Update now**. The helper must install nothing but that
release's own package, verified.
`STUGA_STDIO_ENTRY` names the stdio MCP server that agent setup offers. When it is empty, agent
setup offers none.
`STUGA_REMOTE_SERVICE` and `STUGA_REMOTE_DIR` offer remote access
([docs/remote-access.md](../docs/remote-access.md)): the service the node enrolls with first, an
https origin, and the absolute path of a directory the node shares with the connector, which it
creates `0750` when missing and refuses when another user owns it or its group or others can write to it,
unless it arranges it for the connector's group (below). The
node writes the connector's settings and credential there and listens on `https.sock` in it, so
`<dir>/https.sock` must fit a unix socket path, 103 bytes. A packaging that sets them also runs the
connector, or leaves it to the administrator
([Running the connector yourself](../docs/remote-access.md#running-the-connector-yourself)). With
only one set, the node logs a warning and offers none.
`STUGA_CONNECTOR_REQUEST` and `STUGA_CONNECTOR_STATUS` say that the packaging runs the connector
([The connector](../docs/remote-access.md#the-connector)). The node writes one line to the request
file, `on <sha-256 of the connector's settings>` or `off`, whole and renamed in, and reads
`{state, message, at, connector_sha, config_sha}` back from the status file, where `state` is
`installing`, `running`, `stopped`, `refused` (not retried until an administrator asks),
`failed` (retried) or `unavailable` (no connector for this runtime). The line is a desired state:
the packaging keeps the file, compares it with what runs whenever it wakes, and restarts the
connector only when the settings or the connector changed. The node writes it at every start, when
it changes, and again, backing off, while the status disagrees. The packaging writes a fresh status,
with `at` in ISO 8601, after every pass over the request, even one that changes nothing: the node
takes a status stamped before it last changed the line, to the second, as no answer, and asks again
for `on` after an `installing` status silent for 15 minutes. The status must be a regular file of
at most 4 KiB: the node never reads it through a link, and takes anything else as no status. Both
paths are absolute; with only one set, the node logs a warning and takes it that the packaging does
not run the connector. They count only beside `STUGA_REMOTE_SERVICE` and `STUGA_REMOTE_DIR`.
`STUGA_REMOTE_GID` and `STUGA_REMOTE_CONNECTOR_UID`, numbers, say that the packaging runs the
connector as a user of its own in a group of its own
([A group of the connector's own](../docs/remote-access.md#a-group-of-the-connectors-own)). The
node then arranges the shared directory at every start instead of refusing it, putting wrong owners
and modes right: the directory the node's user's and the group's, `02750`; `control/` the same,
`0750`; `status/` the connector's user's and the group's, `0750`; and every file the node writes
there, the request included, the group's; anything else in the directory or `control/` it did not
write, it removes. A packaging that sets them points the request into
`control/` and the status into `status/`, and the node must be able to give files away, as root
can. With only one set, the node logs a warning and checks the directory as without either. They
count only beside `STUGA_REMOTE_SERVICE` and `STUGA_REMOTE_DIR`.

## Postgres

- Postgres `PG_MAJOR` only. The node refuses any other major.
- pgvector must be available, and pg_search must be available and listed in
  `shared_preload_libraries`.
- The database must use the builtin locale provider with `C.UTF-8`. Create the cluster with
  `initdb $INITDB_ARGS`, which also enables data checksums, or create the database with
  `LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' TEMPLATE template0`. The node refuses any other
  collation, because text must order and compare the same way on every node.
- The role creates the extensions and schema on first boot. `backup` and `restore` also connect to
  the `postgres` database on the same server, and `restore` creates and renames databases.

## Lifecycle

- **Health.** `GET /ready` answers 200 only while the node serves and its database answers. There
  is no other health endpoint. With `TLS_CERT_DIR` set the node answers only https, so a probe
  follows it. The node listens as soon as it holds its database, and until it serves `/ready`
  answers 503 with a `status` (`starting`, `backing_up`, `upgrading`) and every other request gets
  a 503, a browser a page that says why. A boot can back up, migrate and build search indexes first,
  so a supervisor should wait for progress rather than use a short timeout. A running node also
  answers 503 (`maintenance`) for the moment it pauses to back itself up.
- **Backups the node takes.** A node backs itself up on a schedule, daily unless changed, and before it upgrades a database
  another version served, into `BACKUP_DIR` with the pruning `backup` does. A packaging that mounts
  the data directory must mount `BACKUP_DIR` too, or those backups are lost with the container, and
  must give the node `PG_BIN`. The packaging's own upgrade needs no backup step of its own.
- **Stopping.** On SIGTERM or SIGINT the node stops its workers and closes its actors, and it
  gives up after 25 s. A supervisor must allow at least 30 s before it kills the node. Docker sets
  `stop_grace_period: 30s`, and launchd sets `ExitTimeOut` 60.
- **One writer.** One node runs per database. A second node refuses to boot while the first holds
  the writer lock.
- **Setup.** While no account exists, the node keeps its setup code in `DATA_DIR/setup-code`, one
  line such as `7KD2M-X9QPA`, and logs a link to `<PUBLIC_ORIGIN>/login?setup=<code>` at every start.
  The first account needs the code. A packaging may read the file to open that link for whoever
  installed the node, or name another with `SETUP_CODE_FILE`, which the node makes readable by its
  group: the Mac package's is readable by the Mac's administrators. The node deletes the file once it
  is claimed.
- **Identity.** The node picks its ID on the first boot and keeps it in the database, with any name
  an administrator sets, so both follow the database through a backup and restore. No platform sets
  the ID or a set name; until one is set, the name is the host of `PUBLIC_ORIGIN`.
