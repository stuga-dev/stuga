<img src="apps/web/public/favicon.svg" width="64" height="64" alt="">

# Stuga

**AI suggests. You decide.**

Stuga is a workspace of documents and databases for teams that let AI agents write into their work.
When Claude, Codex or any other MCP client edits a document or a table, the change arrives as a
suggestion, marked up like tracked changes, and it lands only when a person accepts it. Edits people
make go straight in.

It runs on a machine you own, such as a Mac mini in the office, a Linux server or a NAS: one Node.js
process and Postgres, with no cloud in between. Everyone else uses it in a browser.

[Download for Mac](https://github.com/stuga-dev/stuga/releases/latest/download/Stuga.pkg) ·
[Install with Docker](docs/install/docker.md) · [Connect an agent](docs/agents.md) ·
[Documentation](#documentation)

## How agent edits work

- **A suggestion, not a silent write.** Each agent's editing session on a document or database is a
  *run*. It records which agent made it, whose key it used, the client and model it reported, and
  every change it proposed. You accept or reject the changes one by one, in the document itself.
  Other people never see pending agent text, and their own editing carries on as usual.
- **Waiting is the default.** A suggestion waits for a person for as long as that takes, and you are
  notified that it is there. Nothing applies it on a timer, and the agent is never blocked waiting on
  you. The owner of a document or database, or a workspace admin, can switch it to **Let agents
  apply changes at once**. Changes then land immediately and stay recorded, attributed and
  revertible.
- **One inbox.** **Review AI edits** lists every run that needs someone, across documents and
  databases, with each agent's record of accepted and rejected changes beside it.
- **Who wrote this?** An agent can ask a document who wrote which passage and whether a person has
  reviewed it, so one agent does not take another's unreviewed text as settled.
- **Narrow access, full audit.** An app that signs in reaches only the workspaces you tick, and can
  be limited to reading. A key can also be confined to folders or given an expiry. Every call an
  agent makes over MCP, reads included, is in the audit log. An event feed and signed webhooks tell
  agents and other systems what changed.

## Your data stays on your machine

Stuga sends no telemetry, and nothing reaches us. The node makes outbound requests only for features
in use on it: the AI providers a node admin configures, the notification sink and webhooks admins
set up, the identity provider when an admin adds one, images an agent adds by URL, which the node
downloads and serves itself, and the metadata document of an app that signs in with one. AI is off
until an admin turns it on, and the model can run on the same machine.

An AI app you connect sees what its model reads and writes. A hosted one, such as Claude on the web,
handles it on its vendor's servers.

One request is the node's own: once a day it asks GitHub for the list of Stuga releases, to tell its
admins when a newer one is out. The request says nothing about the node, not even its version, and
the comparison happens on the node. First-run setup asks before the first one is made, and
**Check for new versions** under **Settings → This node → About** turns it off
([docs/operations.md](docs/operations.md#learning-of-a-new-version)). On a Mac, **Update now** there
downloads the release's package from GitHub, when an administrator chooses it.

Stuga does not encrypt data at rest. Documents, the database and keys are stored in plaintext on the
node's disk, readable by anyone who can read that disk. Reaching a node from other devices, and what
each way of doing that protects, is covered in [docs/network-access.md](docs/network-access.md).

## What's in it

- **Documents people write together.** Real-time editing in the browser (Tiptap over a Yjs CRDT),
  with presence, comments, @mentions and version history, and clients that re-sync cleanly after a
  dropped connection. Markdown files import as documents.
- **Databases with real SQL.** Typed tables live beside your documents, and each database has its own
  SQLite store. Saved views filter, sort and group rows, every row can open as a page, and CSV
  imports in one step. People and agents query them with plain read-only SQL, not a lookalike filter
  language.
- **Search that follows permissions.** Keyword and semantic search are fused in one SQL statement and
  filtered by access inside the query, so results follow sharing changes immediately and never
  include a document the searcher cannot open. Chinese and Japanese are split into words by
  dictionary, not character by character.
- **AI built in, and optional.** A co-author in the editor, an assistant for tables, and **Ask**, which
  answers questions across your documents and databases with citations. Their edits go through the
  same review as any agent's. A node admin picks the provider: OpenAI, Anthropic, Gemini, DeepSeek,
  Mistral, Qwen and more, or Ollama on the same machine.
- **Sharing and sign-in.** Workspaces, folders, per-document sharing, groups and guests. People join
  by invite link and sign in with a username, or through your own OpenID Connect provider.
- **Looks after itself.** The node backs itself up every day and before every upgrade, and tells its
  admins when a new version is out.

## Who it's for

- Teams that have agents drafting plans, specs, knowledge bases or business tables, and want a person
  to approve what changes.
- People who want that work on hardware they control, including the model if they choose.
- Anyone wiring Claude Code, Codex or their own agents into documents a team shares.

Stuga is not a personal notes app. There is no native phone app and no plugin system; phones and
other computers open it in a browser.

## Install

- **A Mac with Apple silicon**, on macOS 13 or later: download
  [Stuga.pkg](https://github.com/stuga-dev/stuga/releases/latest/download/Stuga.pkg) and open it
  ([docs/install/macos.md](docs/install/macos.md)).
- **Docker**, on a Linux server or a NAS (x86-64 or arm64):
  `curl -fsSL https://github.com/stuga-dev/stuga/releases/latest/download/install.sh | bash`
  ([docs/install/docker.md](docs/install/docker.md)).

Then [docs/getting-started.md](docs/getting-started.md) walks through the first hour with a new node.

## Connect your agents

Agents reach Stuga over MCP: the node serves `/mcp`, and `stuga-mcp` is a local stdio server that
forwards to it for desktop clients. **Settings → Your own AI** in the app gives the setup for Claude
Code, Claude Desktop, Codex, Antigravity and DeepSeek Harness, the Claude app's connector on a node
with a public HTTPS address, and the URL and key any other MCP client needs. Most clients sign in
through the browser, where you choose the workspaces the app may use and whether it may only read.
A client holds one connection, called **Stuga**, that reaches every workspace you allowed, and each
call names the one it acts in. API keys, the tools and how agent work appears in the run ledger are
covered in [docs/agents.md](docs/agents.md).

## Status

Stuga is pre-1.0. Only the most recent release gets fixes ([SECURITY.md](SECURITY.md)), and
[CHANGELOG.md](CHANGELOG.md) lists every release.

## Documentation

- [docs/install/docker.md](docs/install/docker.md) and [docs/install/macos.md](docs/install/macos.md): installing on each platform.
- [docs/getting-started.md](docs/getting-started.md): the first hour with a new node.
- [docs/configuration.md](docs/configuration.md): environment variables and node settings.
- [docs/operations.md](docs/operations.md): backups, restores, learning of a new version, and upgrades.
- [docs/network-access.md](docs/network-access.md): reaching a node from other devices, and using several nodes.
- [docs/troubleshooting.md](docs/troubleshooting.md): starts from the symptom.
- [docs/agents.md](docs/agents.md): connecting agents, API keys, the MCP tools and the run ledger.
- [docs/api.md](docs/api.md): the REST API.
- [docs/architecture.md](docs/architecture.md): how the node works.
- [docs/rag-cross-doc-qa.md](docs/rag-cross-doc-qa.md): how Ask finds, reads and cites passages.
- [docs/collections.md](docs/collections.md): scoping search and Ask to a named set of documents.
- [packaging/contract.md](packaging/contract.md): what every packaging of Stuga provides.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers running Stuga from
source, the tests and the conventions, and [RELEASING.md](RELEASING.md) how a release is cut.
Contributions are accepted under a Contributor License Agreement ([CLA.md](CLA.md)); a bot asks on
your first pull request. Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes.

## License

[AGPL-3.0-only](LICENSE), except [integrations/](integrations/), which is [MIT](integrations/LICENSE);
copyright notice in [NOTICE](NOTICE). If you modify Stuga and offer it to others over a network, you
share your changes under the same terms. The name and logo are not covered by the license:
[TRADEMARKS.md](TRADEMARKS.md) says how you may use them.
