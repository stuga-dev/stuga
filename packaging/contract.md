# Platform contract

What every packaging of Stuga provides, and what the app provides back. Docker (`packaging/docker`)
and the Mac runtime (`packaging/macos`) are two implementations of this contract. The app itself
has no platform branches. Anything a platform needs beyond this contract lives in its packaging
directory.

## Pins

`packaging/versions.env` lists every pinned input: Node, pnpm, the Postgres major, pgvector,
pg_search, Postgres.app, the Debian line and the PGDG key. Downloads are pinned by sha256.
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
<out>/tsconfig.base.json
<out>/apps/web/dist/              the built web app, with third-party-licenses.txt for the npm packages it bundles
<out>/integrations/skills/, LICENSE  the Stuga skill the agent installers hand out, and its MIT license
<out>/services/node/bin/stuga-node.js
<out>/services/node/src/          the node's TypeScript, run through tsx
<out>/services/node/tsconfig.json the compiler options bin/stuga-node.js hands to tsx
<out>/services/node/node_modules/ production dependencies; @stuga/* packages carry src/ (db also migrations/), @stuga/mcp only dist/:
                                  stuga-mcp.js, LICENSE and third-party-licenses.txt, which the desktop extension carries
```

The tree holds no tests, dev dependencies or local `.env` files. tsx ships a native esbuild binary,
so build the tree on the OS and architecture it will run on. The node finds `apps/web/dist`,
`integrations/skills` and `VERSION` three directories above `services/node/src`, and does not start
without the skill. It reads the migration SQL from the tree at runtime.

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
| `backup [--json]` | Back up the database and the data directory into `BACKUP_DIR`, verified, pruned to `BACKUP_KEEP`. |
| `verify <backup> [--json]` | Check that a backup is whole and that this build can restore it. |
| `restore <backup> [--yes] [--json]` | Replace the database and the data directory. The current ones are kept beside the restored ones. |
| `list [--json]` | List backups, unfinished work, and what restores kept. |
| `reset-password <username>` | Print a password reset link. |
| `media-scan [--reclaim] [--empty-trash[=<days>]] [--grace-hours=<hours>]` | Report or reclaim media that no document references. |

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
| `NODE_SIGNING_KEY` | `<DATA_DIR>/identity/signing.jwk` | The session token signing key. |
| `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_SECONDS`, `REFRESH_ROTATION_GRACE_SECONDS` | `3600`, `2592000`, `60` | Session token lifetimes. |
| `AI_EMBED_DIMS` | `1024` | The embedding width. It is fixed when the database is created. |
| `SEARCH_LANGUAGES` | none | Extra BM25 analyzers: `ko`, `ar`. |
| `MEDIA_COOKIE_SAMESITE` | `lax` | `lax`, `strict` or `none`. |
| `WEB_DIST_DIR` | `<app>/apps/web/dist` | The web assets. |
| `PG_BIN` | `PATH` | The directory of `pg_dump` and `pg_restore`, of the server's major. |
| `BACKUP_DIR` | `backups` beside `DATA_DIR` | Where backups go. |
| `BACKUP_KEEP` | `7` | How many backups of the database are kept, the node's own and `backup`'s. The minimum is 1. |

### Packaging hints

These are optional. The app has a neutral default for each.

| Variable | Default | Docker | macOS |
|---|---|---|---|
| `STUGA_RESTART_HINT` | `Restart the node to apply.` | `Run docker compose up -d in your Stuga directory to apply it.` | set by `render-launchd.sh` |
| `STUGA_UPGRADE_HINT` | `Upgrade on the machine that runs the node.` | `Run ./stuga upgrade in your Stuga directory: it downloads the release and installs it.` | set by `render-launchd.sh` |
| `STUGA_STDIO_ENTRY` | unset: the bundled `stuga-mcp.js` | `""`: no local path an agent outside the container can open | unset |
| `AI_OLLAMA_DEFAULT_URL` | `http://127.0.0.1:11434` | `http://host.docker.internal:11434` (compose maps the host) | unset |
| `STUGA_UPGRADE_REQUESTS`, `STUGA_UPGRADE_STATUS` | unset: the node offers no install | unset | the package's helper: `<root>/requests` and `<root>/status/upgrade.json` |

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
- **Backups the node takes.** A node backs itself up daily, and before it upgrades a database
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
  installed the node. The node deletes the file once it is claimed.
- **Identity.** The node picks its ID on the first boot and keeps it in the database, with any name
  an administrator sets, so both follow the database through a backup and restore. No platform sets
  the ID or a set name; until one is set, the name is the host of `PUBLIC_ORIGIN`.
