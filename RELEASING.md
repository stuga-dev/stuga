# Releasing Stuga

For maintainers. Pushing a version tag is the only thing that publishes a release. Merging to
`main` publishes nothing.

## Versions

The tag names the version: `v1.2.3` releases `1.2.3`. The `0.0.1` in every `package.json` is a
placeholder that nothing reads, so don't bump it.

The release workflow stamps the version into both platforms' builds:

- **Docker:** the node image is built with `STUGA_VERSION=1.2.3`, so
  `packaging/shared/build-app.sh --version 1.2.3` writes `/app/VERSION`. Both images are pushed
  as `:1.2.3`. `packaging/docker/package.sh` pins the release's `compose.yml` to them.
- **macOS:** `packaging/macos/pkg/build-pkg.sh --version 1.2.3` builds `runtime/1.2.3` (with
  `build-runtime.sh`), whose app tree carries `VERSION`, and stamps the version into Stuga.app and
  the package, which a Mac node's upgrade helper checks before it installs one.

The node reads `VERSION` at its app root. It reports that version in its boot line, in every backup
manifest, and under **Settings → This node → About**. A build without the file reports `0.0.0-dev`
([packaging/contract.md](packaging/contract.md#version)).

A version is a plain `1.2.3`. There are no pre-releases: the workflow refuses a tag such as
`v1.2.3-rc.1`, and a running node compares itself only with plain versions.

## The changelog

[CHANGELOG.md](CHANGELOG.md) is what a release says about itself, and the release workflow reads it
with `packaging/release/feed.mjs`:

- The version's entry becomes its GitHub Release notes. An **Upgrade notes** section leads them. It
  says what someone running a node has to decide or do; without one the notes say there is nothing
  to do. Build and development changes don't belong in it.
- The entry's date is written into the build as `RELEASED`, beside `VERSION`, and
  **Settings → This node → About** shows it.
- Every entry goes into `releases.json`, a Release asset. A running node reads the newest Release's
  copy once a day to learn that it is behind
  ([docs/operations.md](docs/operations.md#learning-of-a-new-version)). An entry with a
  **Security** section is a security release: the node tells its administrators about one, and
  only marks **About** for any other.

Released nodes read `releases.json` as it is today, `{"releases": [{"version", "date",
"security"}]}`. Add fields to it, and never change what these three mean.

## Before tagging

Check that CI is green on the commit you are tagging.

Turn `## [Unreleased]` in CHANGELOG.md into the version's entry, `## [1.2.3] - 2026-01-31`, and put
an empty `## [Unreleased]` above it. Give it a **Security** section if it fixes a vulnerability, and
an **Upgrade notes** section if the version needs a decision or an action from someone running a
node. `node packaging/release/feed.mjs check 1.2.3` passes once the entry is the newest one, and
`node packaging/release/feed.mjs notes 1.2.3` prints the notes the Release will carry.

## Tagging

```sh
git tag -a v1.2.3 -m v1.2.3
git push origin v1.2.3
```

## The release gate

`.github/workflows/release.yml` publishes a Release only after the Docker artifact and the Mac
runtime have both been built at the tag's version and booted.

| Job | Runs after | Checks |
|---|---|---|
| `changelog` | | The tag's version is the newest entry in CHANGELOG.md. Writes `releases.json` and the Release notes from it. |
| `verify` | | All of CI (`ci.yml`): lint, typecheck, unit tests, the packaging checks, the integration suites, the Docker restore drill and the backup suite inside the node image, and the macOS job (integration suites on the Mac Postgres tree, a runtime build, its smoke test and restore drill). |
| `docker-images` | `verify`, `changelog` | Refuses a version whose images already exist. Builds `stuga-node` and `stuga-postgres` for `linux/amd64` and `linux/arm64` with the build arguments in `packaging/versions.env`, and pushes only the exact version tag, with provenance and an SBOM. |
| `docker-package` | `docker-images` | Lays out the Docker release assets with `package.sh` (`compose.yml` pinned to the version, `env.example`, `stuga`), checks that `compose.yml` names both images at the version, and checks that both architectures were published. |
| `docker-smoke` | `docker-package` | On an amd64 and an arm64 runner, boots the stamped `compose.yml` against the published images. Checks that `/ready` answers, `/` serves the web app, the image's `/app/VERSION` is the version, and the boot line names it. |
| `macos-pkg` | `verify`, `changelog` | On macOS, builds `Stuga-<version>.pkg` with `packaging/macos/pkg/build-pkg.sh`: the runtime at the version, Stuga.app and the install scripts, every binary signed with the Developer ID Application identity (Node with only `allow-jit`), the package signed with the Developer ID Installer identity, notarized and stapled. Then boots the runtime the package carries with `packaging/macos/test/smoke.sh`, which checks `/ready`, the web app, the boot line, a clean stop, `backup` and `verify`, and a clean Postgres shutdown. Needs the secrets `MACOS_CERTS_P12` (one p12 with both identities, base64, of the team the upgrade helper trusts: `STUGA_TEAM_ID` in `packaging/macos/runtime/bin/helper.sh`), `MACOS_CERTS_PASSWORD`, and an App Store Connect API key for notarytool: `NOTARY_KEY` (the .p8, base64), `NOTARY_KEY_ID`, `NOTARY_ISSUER`. |
| `promote` | `docker-smoke`, `macos-pkg` | Points the `:1.2` and `:1` image tags at the digests the smoke test booted, and reads them back to confirm. `latest` is never published. |
| `release` | `docker-smoke`, `macos-pkg`, `promote` | Creates the GitHub Release, with the notes from the changelog and `compose.yml`, `env.example`, `stuga`, `install.sh`, `releases.json`, `Stuga-<version>.pkg` and the same package as `Stuga.pkg`, which `releases/latest/download/` always names. A Mac node's **Update now** downloads the versioned name. |
| `npm` | `release` | Builds `services/mcp` stamped with the version and publishes `services/mcp/dist` as `@stuga/mcp` through npm trusted publishing, from the `release` environment, unless npm has the version already. The package's provenance names this run. |
| `plugin` | `npm` | For the newest version only, and once npm serves `@stuga/mcp` at it: stamps `integrations/` with the version and the `@stuga/mcp@<version>` pin (`packaging/release/plugin.mjs`), and pushes it to [stuga-dev/stuga-plugin](https://github.com/stuga-dev/stuga-plugin) as one commit and the tag `v<version>`, as the Stuga Release app. Anthropic's plugin directory and every marketplace read that repository. Needs `STUGA_RELEASE_APP_CLIENT_ID` (a variable) and `STUGA_RELEASE_APP_KEY` (a secret) in the `release` environment, of an app installed on stuga-plugin alone. |

A pushed tag is never deleted or reused. You can re-run a job that failed for a transient reason.
A failure that needs a code change is fixed in the next patch version. Once `docker-images` has
pushed, that version's images exist with no Release or floating tag pointing at them, and
`docker-images` refuses to build the version again.

## After the release

In an empty directory, follow [docs/install/docker.md](docs/install/docker.md) exactly as written and
reach `/ready`. On a Mac, check out the tag, follow [docs/install/macos.md](docs/install/macos.md),
and reach `/ready`. The workflow does not test the instructions themselves.

Each commit the `plugin` job pushes is a new version of the listing in Anthropic's plugin
directory, which follows stuga-plugin's `main`. The directory scans it and, because it runs a pinned
npx package, holds it for review: open the plugin at
[claude.ai/directory/manage](https://claude.ai/directory/manage) and select **Publish** on the new
version, and an Anthropic reviewer publishes it. Until then the listing serves the previous version.

npm accepts trusted publishing only for a package that already exists, so the first release's `npm`
job fails. Publish that version by hand from the tag (`STUGA_VERSION=<version> pnpm --filter
@stuga/mcp build`, then `npm publish` in `services/mcp/dist`), set the package's trusted publisher
on npmjs.com to this repository, `release.yml`, environment `release`, require two-factor
authentication to publish it (`npm access set mfa=publish @stuga/mcp`), and re-run the failed jobs:
`npm` finds the version published and `plugin` runs.

stuga-plugin's rulesets let only the Stuga Release app create or update `main` and create `v*` tags,
and nobody move or delete them. A bad plugin version is superseded by the next patch release, like
any other. The app ([github.com/apps/stuga-release](https://github.com/apps/stuga-release), owned by
the stuga-dev organization) has only contents: write and is installed on stuga-plugin alone. To
rotate its key, generate a new private key on the app's settings page, replace
`STUGA_RELEASE_APP_KEY` in the `release` environment, and delete the old key there.

## Yanking

A published version is never rebuilt or deleted, and the next patch version supersedes a bad
release. To retract one, mark its Release `[YANKED]` with a one-line reason, and name the version
to use instead in its notes. Don't delete image manifests: every tag on the same digest goes with
them, including `:1.2` and `:1`.

Then set the Release before it as the latest (`gh release edit v<previous> --latest`). That is what
`releases/latest/download/` follows, so new installs get the previous version's files, and running
nodes read the previous `releases.json`, which does not list the retracted version. Mark the entry
`## [1.2.3] - 2026-01-31 [YANKED]` in CHANGELOG.md too, so the next release's list leaves it out.

## Pins

`packaging/versions.env` holds every pinned input ([packaging/contract.md](packaging/contract.md#pins)).
Bump a version and its checksums together, then run `bash packaging/check-pins.sh`, which names
every other file that must follow. Release a pin bump on its own: pgvector and pg_search own index
formats, and every per-actor store runs on Node's `node:sqlite`.

A Postgres.app bump can change which libraries and extensions the Mac runtime carries. Compare
`postgres/lib` of a runtime built with it against the list in
`packaging/macos/runtime/THIRD-PARTY-NOTICES.txt.in`, and add the license of anything new.
