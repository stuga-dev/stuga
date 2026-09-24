# Contributing to Stuga

This page covers where things live, how to run and test them, and the conventions every change
follows.

## Repository layout

One pnpm monorepo, driven by turbo:

```
apps/
  web/               the web app: editor, review, databases, settings (React, Vite)
services/
  node/              the node: HTTP and WebSocket layer, actor hosting, jobs, identity,
                     /mcp and OAuth, and the stuga-node command line
  mcp/               stuga-mcp, the stdio MCP server; every tool is a REST call to a node
packages/
  agent-surface/     the MCP tool catalog, argument schemas, instructions and renderers
                     that both MCP servers register
  protocol/          shared contracts by subpath: wire/, api/, domain/, databases/, text/, internal/
  runtime/           the actor contract, the in-process actor host, SQLite and blob storage,
                     and an in-memory host for tests (@stuga/runtime/testing)
  db/                the Postgres schema (migrations/), every query, the job queue
  auth/              token signing and verification, principals, access checks
  ai/                model provider clients, embeddings and chunking, the agent turn loop
  crdt-ops/          Markdown and Yjs operations shared by the browser and the document actor
  doc-actor/         the per-document actor: live Y.Doc, runs, snapshots
  database-actor/    the per-database actor: SQLite tables, read-only SQL, runs
packaging/
  contract.md        what every packaging provides, and what the app provides back
  versions.env       every pinned input; check-pins.sh fails when another pin disagrees
  shared/            build-app.sh, which builds the app tree both platforms run
  docker/            the images, compose files, the ./stuga operator script, install.sh, dev and
                     test Postgres
  macos/             the Mac runtime: Postgres tree, launchd jobs, the package and its upgrade
                     helper, Stuga.app, dev Postgres, tests
  release/           feed.mjs: release notes and releases.json, from CHANGELOG.md
  test/              the restore drill both platforms run
integrations/        the Stuga Skill that the Codex and Antigravity installers put in place
scripts/             test-integration.sh
```

TypeScript throughout: ESM with `verbatimModuleSyntax`, and workspace imports by package name
(`@stuga/db`, `@stuga/protocol/wire/opcodes`). Libraries ship their TypeScript source and emit
nothing, so `typecheck` is their build. The node runs its source through tsx. Only the web app
(`apps/web/dist`) and the stdio MCP server (`services/mcp/dist/stuga-mcp.js`) have a build step,
and `pnpm build` runs both.

## Running from source

You need Node 22 (`.nvmrc`) and pnpm 9, which corepack provides (`corepack enable`).

```sh
pnpm install
cp services/node/.env.dev.example services/node/.env.dev
```

Start a development Postgres, in one of two ways:

- **With Docker:** `pnpm db:up` starts Stuga's Postgres image on `127.0.0.1:55433`. The example
  `.env.dev` already points at it. `pnpm db:reset` starts over with an empty database.
- **On an Apple silicon Mac, without Docker:** `packaging/macos/dev/postgres.sh start` creates a
  cluster from the pinned Mac Postgres tree under `data/dev-postgres`, listening on its socket as
  port 55433. It prints the `DATABASE_URL` to put in `services/node/.env.dev`. `stop` stops it, and
  `reset` deletes the cluster and starts a new one.

Then:

```sh
pnpm dev
```

This runs the node on port 8788, reloading on changes, and the Vite dev server on
<http://localhost:3001>, which proxies API, WebSocket and MCP requests to the node. The node keeps
its data in `data/dev-node`. **Settings → Your own AI** offers the desktop extension only once the MCP bundle
exists, so run `pnpm build` first if you need it.

To try the packaged node on Docker, `pnpm check:packaged` builds both images from your working tree
and starts them on port 8787, with its `.env` and data under `packaging/docker`. It runs as the
Compose project `stuga-check` with the volume `stuga_check_pgdata`, so it leaves a Docker install
on the same machine alone, but it cannot start while anything else holds port 8787. Stop it with
`docker compose -p stuga-check down`, and add `-v` to delete its database too.

`pnpm dev:web` runs only the Vite dev server against that node. Add
`EXTRA_ORIGINS=http://localhost:3001` to `packaging/docker/.env` and run `pnpm check:packaged`
again first: the node accepts writes only from the origins it is configured with, so without it
every write from port 3001 fails with `403 origin not allowed`.

To try sign-in through an identity provider, run the mock one, which asks who you are on a small
form: `pnpm --filter @stuga/auth exec tsx src/oidc/testing/mock-provider.ts --port 9876`. Enter the
issuer it prints and the client ID `stuga` under **Settings → This node → Access**. Like a real
provider it remembers who signed in in each browser, with a cookie of its own, and signs that
browser straight back in until it opens the mock's `/logout`; another browser starts signed out. A
sign-in that asks which account to use, after a sign-out or from **Use a different account**, shows
the form again.

On a Mac, `packaging/macos/local-trial/build.sh` builds Stuga.app from the checkout
([docs/install/macos.md](docs/install/macos.md)).

Ports in use:

| Port | |
|---|---|
| 3001 | the Vite dev server |
| 8787 | a packaged node (`pnpm check:packaged`, Stuga.app) |
| 8788 | the source node (`pnpm dev`) |
| 55433 | the development Postgres |
| 55432 | the throwaway Postgres of `pnpm test:integration` |
| 8799 | the Docker restore drill |
| 9876 | the mock identity provider |

Anything built from a checkout has no `VERSION` file and reports `0.0.0-dev`, shown as
`0.0.0-dev · built from source` under **Settings → This node → About**. Only the release workflow
stamps a version ([RELEASING.md](RELEASING.md)).

## Commands

```sh
pnpm lint               # oxlint; warnings fail
pnpm typecheck          # every package
pnpm test               # unit tests (vitest), per package
pnpm build              # the web app and the stuga-mcp bundle
pnpm test:integration   # the Postgres integration suites
pnpm test:drill         # the restore drill on Docker
```

Scope a turbo-driven command to one package with a filter: `pnpm --filter @stuga/db test`.

## Tests

- **Unit tests** are colocated `*.test.ts` files. They need no network and no database. Actor code
  tests against the in-memory host in `@stuga/runtime/testing`. That host specifies the actor
  contract, so a change to its behaviour needs matching contract tests.
- **Integration tests** (`*.integration.test.ts`) run against a real Postgres: the `@stuga/db`
  suites (migrations, the schema snapshot, queries, the job queue) and the node's backup, media
  and notification suites. Without `TEST_DATABASE_URL` they skip.
  `scripts/test-integration.sh` runs them one after another, because they share one database and
  truncate its tables.
  - Without `TEST_DATABASE_URL`, it starts a throwaway Postgres in Docker on `127.0.0.1:55432`
    and removes it afterwards.
  - With `TEST_DATABASE_URL` set, it uses that database instead. Point it at a database you can
    lose, on a server that meets [the Postgres requirements](packaging/contract.md#postgres). The
    backup suite runs `pg_dump` and `pg_restore` of the server's major from `PG_BIN`, or from
    `PATH`.
  - On an Apple silicon Mac, `packaging/macos/test/ci.sh` runs the same suites without Docker,
    against a throwaway cluster from the pinned Mac Postgres tree.
- **The restore drill** (`packaging/test/drill-content.sh`) puts one of each kind of state into a
  node, backs up, destroys the database and the data directory, restores, and checks that
  everything came back.
  - On Docker, `pnpm test:drill` builds both images and installs them in a temporary directory
    the way an operator does.
  - On a Mac, build a runtime and run the smoke test and the drill against it:

    ```sh
    packaging/macos/build/build-runtime.sh --out /tmp/stuga-macos --version 0.0.0-ci
    packaging/macos/test/smoke.sh /tmp/stuga-macos/runtime/0.0.0-ci
    packaging/macos/test/restore-drill.sh /tmp/stuga-macos/runtime/0.0.0-ci
    ```

- **Packaging checks:** `bash packaging/check-pins.sh`, and `node --test "packaging/**/*.test.mjs"`
  for the image's health check, the Mac log rotation, the launchd plists (macOS only) and the
  developer tools lookup. CI also runs shellcheck over every script in `packaging/` and `scripts/`.

CI (`.github/workflows/ci.yml`) runs all of these on every pull request and every push to `main`,
on Linux and on macOS.

## Schema changes

A released migration is never edited: nodes have already applied it. A schema change is a new file,
`0002_short_name.sql` and up, appended to `MIGRATIONS` in `packages/db/src/schema/migrate.ts`, with
contiguous numbers as the schema version. The node applies pending migrations in one transaction
when it boots, and refuses to start when an applied file has changed.

The structured databases are not Postgres: each one is SQLite inside its actor, created by
`ensureSchema` in `packages/database-actor/src/schema-ops.ts`, which has no migration mechanism of
its own.

What an actor keeps carries a version instead: `DOC_STORE_VERSION` and `DATABASE_STORE_VERSION`. The
host stamps each actor's SQLite file with its namespace's version (`PRAGMA user_version`) and refuses
a file stamped higher, so an older build never opens what a newer one wrote. A change to what a
store holds raises its version, together with the step in `claimStoreVersion`
(`packages/runtime/src/actor-host.ts`) that brings an older store forward; the host refuses an older
store rather than restamp it while no such step exists.

Then regenerate `packages/db/schema.snapshot.txt`, with `TEST_DATABASE_URL` pointing at a database
you can lose, and check that its diff holds only the change you meant. The integration suites fail
while the snapshot and the schema disagree.

```sh
pnpm --filter @stuga/db schema:snapshot
```

A statement that must hold on every boot, such as extension versions or the BM25 indexes in
`schema/search-indexes.ts`, is not a migration. It belongs in
`packages/db/src/schema/boot-repairs.ts`, which runs each time the node starts.

## The changelog

A change someone running or using a node will notice gets a line under `## [Unreleased]` in
[CHANGELOG.md](CHANGELOG.md), in the section that fits: **Added**, **Changed**, **Fixed**, **Removed**,
**Security** for a fixed vulnerability, and **Upgrade notes** for anything that person has to decide or
do. The release workflow turns the file into the release's notes and into the list running nodes read
([RELEASING.md](RELEASING.md#the-changelog)), so a **Security** section is what makes nodes tell
their administrators.

## Conventions

- **Comments** state what the code cannot: a non-obvious invariant, a constraint, or why, in one
  to three lines. No history ("used to", "previously"), incident stories, version or migration
  numbers, or restatements of the code. Test names state the behaviour they check. Docs describe
  the product as it is, in the present tense.
- **No platform branches.** App code never asks whether it runs in Docker or on a Mac. What
  differs goes in `packaging/<platform>` and reaches the app only through
  [the platform contract](packaging/contract.md): environment variables, the `VERSION` file and
  the `stuga-node` commands.
- **Web app.** The design system is Astryx: components do the layout, every value is a token, and
  `apps/web/src/styles/stylesheets.test.ts` fails the build on a colour literal in a stylesheet.
  An overflow menu (`MoreMenu`) passes `alignment="end"`, or it opens off the right edge of the
  window wherever it sits in a table row or a rail. A dialog keeps its content mounted between
  openings, so it seeds its fields from props or the server when it opens, and nothing closes it
  while a save is in flight. A Tooltip on a popover trigger throws, so a header cell explains itself
  with a native `title`. Dialog tests run in jsdom, which needs the `HTMLDialogElement` polyfill from
  `apps/web/src/library/InstructionsDialog.test.tsx`.
- **One home per setting.** Bootstrap, network and secret settings come from the environment.
  Everything the Settings page edits lives in the database. No setting is read from both.
- **Pins live in `packaging/versions.env`**, and every other copy must agree with it
  ([RELEASING.md](RELEASING.md#pins)).
- Keep every privacy or security claim in the docs mechanically true: if the code does not
  enforce it, don't write it.
- **A dependency's license must combine with AGPL-3.0**: permissive licenses (MIT, BSD, ISC,
  Apache-2.0) and the like, and nothing proprietary or EPL without a secondary license. The web
  app's and stuga-mcp's builds write `third-party-licenses.txt` for what they bundle; read it after
  adding a dependency.

## Pull requests

- Branch from `main` and name the branch for its purpose: `feat/<topic>`, `fix/<topic>`,
  `docs/<topic>`, `chore/<topic>`.
- Keep a pull request focused. A mechanical rename and a behaviour change are two pull requests.
- New behaviour comes with tests at the layer that can catch it breaking: actor logic against the
  in-memory host, SQL in the integration suites.
- Run `pnpm lint`, `pnpm typecheck` and `pnpm test` before pushing. CI runs those, the
  integration suites, the restore drills and the macOS job on every pull request.

## License and contribution terms

Stuga is licensed under the GNU AGPL-3.0-only ([LICENSE](LICENSE)), except `integrations/`, which
is MIT ([integrations/LICENSE](integrations/LICENSE)) because its skill and agent files are meant to
be copied into anyone's setup; a contribution there is MIT too. Contributions are accepted
under a Contributor License Agreement ([CLA.md](CLA.md)), signed once per contributor: a bot asks on
your first pull request and records the answer.

The CLA is a license, not an assignment, and you keep the copyright to your work. It grants the
maintainer a perpetual, worldwide, royalty-free right to use, modify, distribute and relicense your
contribution, and a patent license for anything your contribution necessarily infringes. It also
records that the work is yours to give, or that your employer has agreed. Stuga itself stays
AGPL-3.0-only. If you can't agree to that for a given change, don't submit it.
