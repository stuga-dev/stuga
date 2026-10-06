<img src="apps/web/public/favicon.svg" width="64" height="64" alt="">

# Stuga

**AI suggests. You decide.**

Self-hosted documents and databases where edits from Claude Code, Codex or any MCP client arrive as
tracked changes and, by default, land only when a person accepts them. Use it on your own or with
your team.

[Download for Mac](https://github.com/stuga-dev/stuga/releases/latest/download/Stuga.pkg) (Apple silicon,
macOS 15+) · [Install with Docker](docs/install/docker.md)

Install, then [create your account and workspace](https://stuga.dev/docs/install/create-your-account-and-first-workspace)
and [connect an agent](docs/agents.md). Help for people using Stuga: [stuga.dev/docs](https://stuga.dev/docs).

![Claude Code's edits to a document arriving as tracked changes, accepted and rejected one by one](docs/images/review-demo.gif)

## How agent edits work

- **Review by default.** An agent's changes wait for a person, who is notified and accepts or
  rejects each one in the document or table. Nothing lands on a timer.
- **Nobody is blocked.** Collaborators never see pending agent text and keep editing. The agent
  carries on, and its later reads include its own pending edits.
- **Or apply at once.** The owner of a document or database, or a workspace admin, can choose
  **Let AI edits apply directly**. Changes then land at once, recorded, attributed and revertible.
- **A run per session.** Each run records the agent, the person it acts for, the client and model it
  reported, and every change. **Review AI edits** lists the runs that need someone.
- **Who wrote this?** An agent can ask a document which passages agents wrote and whether a person
  accepted them.
- **Instructions that stack.** The workspace, folders, documents and databases can each carry
  instructions for agents. They advise the model; permissions and review decide what a write does.

![Claude Code's changes to a table waiting as proposals, then accepted](docs/images/database-demo.gif)

## What's in it

- **Documents written together.** Real-time editing (Tiptap over a Yjs CRDT) with presence,
  comments, @mentions and version history.
- **Databases with SQL.** Typed tables beside your documents, each database its own SQLite file,
  with saved views, row pages and CSV import. Agents, Ask and the REST API run read-only SQL on them.
- **Search that follows permissions.** Keyword (BM25, pg_search) and semantic (pgvector) search in
  one SQL statement, with access checked inside it. Chinese and Japanese are split into words.
- **Built-in AI, off until set up.** A co-author and a table assistant, whose edits are reviewed like
  an agent's, and **Ask**, which cites sources. OpenAI, Anthropic, Gemini, DeepSeek and more, or Ollama.
- **Sharing and sign-in.** Workspaces, folders, per-document sharing, groups and guests. People join
  by invite link and sign in with a password or your OpenID Connect provider.
- **Import and export.** A Notion export, or a zipped Obsidian vault or folder of Markdown, becomes a
  workspace; a workspace exports as one `.stuga.zip` of Markdown, JSON Lines and its files.

![The built-in co-author's edits arriving as suggestions, accepted and rejected one by one](docs/images/coauthor-demo.gif)

## Connect your agents

Agents connect over MCP. **Settings → Your AI agents** gives the setup for Claude Code,
Claude Desktop, Codex, Antigravity, Cursor, VS Code, Kiro, Goose, LM Studio, DeepSeek Harness and Pi,
with your node's address filled in, and the URL any other MCP client needs
([docs/agents.md](docs/agents.md)). Each agent brings its own model, so the node needs no AI key.

- **Scoped sign-in.** Most clients sign in through the browser, where you tick the workspaces an app
  may use and choose **Read only** or **Read and suggest changes**. **Revoke** ends its access.
- **Narrow keys.** A client without sign-in uses an API key, which can be confined to folders, made
  read-only or given an expiry.
- **Content only.** Agents change documents and databases. Renaming, moving, deleting, sharing and
  the review setting stay with people.
- **Full audit.** Every MCP call, reads included, is in the workspace's audit log. An event feed
  and signed webhooks report what changed.

## Your data

Stuga sends no telemetry, and nothing reaches us unless a node admin turns on
[remote access](docs/remote-access.md). The node makes outbound requests only for features in use,
such as an AI provider, and asks GitHub once a day for the list of releases unless a node admin
turns that off. [docs/privacy.md](docs/privacy.md) lists what the node sends and stores.

## Install

- **A Mac with Apple silicon**, on macOS 15 or later: open
  [Stuga.pkg](https://github.com/stuga-dev/stuga/releases/latest/download/Stuga.pkg). It carries its
  own Postgres and Node.js ([docs/install/macos.md](docs/install/macos.md)).
- **Docker** on x86-64 or arm64, such as a Linux server or a NAS: `install.sh` starts Postgres
  and the node with Compose ([docs/install/docker.md](docs/install/docker.md)):

  ```sh
  curl -fsSL https://github.com/stuga-dev/stuga/releases/latest/download/install.sh | bash
  ```

A node is one Node.js process and Postgres with pgvector and pg_search; people open it in a browser.
It backs itself up every day by default and before every upgrade
([docs/operations.md](docs/operations.md)). [docs/getting-started.md](docs/getting-started.md) walks
through the first hour.

## Questions and feedback

Ask a question or share an idea in [Discussions](https://github.com/stuga-dev/stuga/discussions);
report a bug as an [issue](https://github.com/stuga-dev/stuga/issues/new?template=bug.md).

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
