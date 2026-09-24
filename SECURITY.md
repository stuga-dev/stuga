# Security

Stuga runs on hardware you own, holds your documents, mints credentials for agents, and keeps an
audit log you should be able to trust. Reports about any of that are welcome.

## Reporting a vulnerability

**Use GitHub's private reporting:** the **Security** tab, then **Report a vulnerability**. It opens
a private thread with the maintainer, and nothing is public until an advisory is published.

If that button is not available to you, open a normal issue that says only that you have a
security report and asks where to send it. **Don't put the details in a public issue:** a report
against self-hosted software is a working exploit against every node already running it.

What helps, roughly in this order:

- the platform (Docker or macOS) and the version, which a node admin sees under
  **Settings → This node → About** and the node's log shows in its boot line,
  `stuga <version>, schema <n>`
- whether the node is reachable from beyond its own machine
- what an attacker needs to start with: nothing, an account, an agent key, or membership of a
  workspace
- the smallest thing that demonstrates it

You will get a first response within a week. If a fix is warranted, it ships in the next patch
release with the issue described in its release notes, and you are credited in the advisory unless
you would rather not be.

## What is in scope

- **The node and everything it serves:** authentication and sessions, the permission model, the
  agent SQL surface, `/mcp` and its OAuth flow, the `stuga-mcp` server, media handling, webhooks
  and other outbound requests, the audit log, and the `stuga-node` backup and restore commands.
- **The packaging:** the `stuga-node` and `stuga-postgres` container images and the Docker release
  assets (`compose.yml`, `env.example`, the `stuga` script and `install.sh`) that a release
  publishes, and the Mac package, `Stuga.pkg`, and the Stuga.app that `packaging/macos` builds, with
  their launchd jobs, the upgrade helper that runs as root, and Postgres configuration.
- **The source** in this repository.

Out of scope, because Stuga does not claim to protect against them:

- **Plain HTTP beyond the node's own machine is not confidential.** Serving a node to other devices
  without TLS is the operator's choice, and [docs/network-access.md](docs/network-access.md)
  describes what each way of reaching a node protects.
- **Data at rest is not encrypted.** Anyone who can read the node's disk can read its data.
- **Anyone who can run commands as the account that runs the node, or can control its
  containers, can do anything.** The token signing key (`DATA_DIR/identity/signing.jwk`, unless
  `NODE_SIGNING_KEY` names another file) and the generated secrets in `DATA_DIR/secrets/` are
  files that account can read. `stuga-node reset-password` is available to that person by design,
  and it grants nothing they don't already have.
- **A node administrator is fully trusted on their own node.** They configure the AI providers and
  the notification sink, so they can point the node at a server they control. That is the role,
  not an escalation.
- **Whoever controls the identity provider an administrator adds can sign in to any account linked
  to it.**

## Which versions get fixes

The most recent release only. Stuga is pre-1.0, and a published version is never rebuilt: a fix
ships as a new patch version. If you run something older, the fix is to upgrade.

A release that fixes a vulnerability has a **Security** section in [CHANGELOG.md](CHANGELOG.md). A
node that looks for new versions tells its administrators about one, in the app and through its
notification sink; a node that cannot reach the internet has to be followed from a machine that can
([docs/operations.md](docs/operations.md#learning-of-a-new-version)).

## What we will not do

We will not ask you to sign anything before reporting, and we will not treat a good-faith report
as a hostile act. Testing against a node you own, or have permission to test, is fine. Testing
against someone else's is not, and we cannot give you permission for it: every node belongs to
whoever runs it.
