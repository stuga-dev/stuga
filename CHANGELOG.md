# Changelog

Every release of Stuga, newest first, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format. One line per change, as someone running or using a node sees it; the docs have the details.
The release workflow turns each entry into its release notes ([RELEASING.md](RELEASING.md#the-changelog)).

Releases before 0.1.7 were previews. Their notes are on their
[GitHub Releases](https://github.com/stuga-dev/stuga/releases).

## [Unreleased]

### Upgrade notes

- The node measures its embedding model when it starts: seconds on a hosted service, minutes for a large model on a CPU. Until then the search box drops nothing by distance. A search or retrieval cutoff saved before stays in force (the search one as **Custom**) until the embedding model changes; without one, Ask and agents no longer apply the default 0.9.

### Added

- **Search strictness** (Strict, Balanced, Loose or Off) sets how far a match by meaning may sit in the search box. The node measures its embedding model when it is saved and sets the distance from that model's own spread, so a level means the same for every model ([Search strictness](docs/configuration.md#search-strictness)).
- Semantic search takes an embedding model that returns fewer dimensions than the node stores, such as EmbeddingGemma 2 (768 on the default 1024), with no database change ([What is embedded](docs/rag-cross-doc-qa.md#what-is-embedded)).

### Changed

- Ask, agents' `retrieve` and the assistants' document search take the nearest passages at any distance unless a cutoff is set by hand, and reranking decides what is relevant.
- `GET /api/node/ai-settings` returns `embed.search_strictness`, `embed.cutoff`, `embed.calibration` and `strictness_default` in place of `max_distance_defaults`; `POST /api/node/ai-settings/calibrate` measures again.
- Queries and passages carry the instruction each known embedding model was trained with (EmbeddingGemma, Qwen3-Embedding, Nomic, E5, mxbai, Arctic Embed), so these models rank as their authors measured them.
- Settings suggests `embeddinggemma-2:270m` when Ollama has no embedding model yet.

## [0.1.12] - 2026-10-06

**Request changes** on an AI edit, so the agent revises from your note; one command to go back to an
earlier version on a Mac; and a security fix that keeps agents' pending changes out of database
queries.

### Upgrade notes

- Each document and database is brought forward when it first opens, keeping everything in it; an older version can't open it afterwards, so go back only with the backup taken before upgrading.

### Security

- A database query no longer reads the review ledger. Before, anyone who could read a database could select agents' pending changes from it.

### Added

- One command goes back to an earlier version on a Mac: `sudo "/Library/Application Support/Stuga/current/bin/stuga" restore <backup>` ([macOS](docs/install/macos.md#go-back-to-an-earlier-version)). **Settings → This node → Backups** shows it for each backup.
- `stuga-node list` marks backups taken before an upgrade.
- **Request changes** rejects an AI edit, or reverts one that landed, with a note for the agent that made it ([Agents](docs/agents.md#request-changes)).
- The note leads the agent's reads and proposals there until it answers it, you mark the run reviewed, or 14 days pass.
- The co-author offers **Revise now**, changing only the passages you turned down.
- The `events` tool's `mine: true` lists the decisions on an agent's own proposals.

### Changed

- Stuga on a Mac needs macOS 15 or later, the versions Apple still updates.
- Stuga on a Mac takes about 330 MB instead of 480 MB.
- An earlier release started on a later one's data changes nothing and says which backup to restore.
- `./stuga restore` going back pins the whole stack to the backup's release.

### Fixed

- Installing on a Mac takes about 20 seconds less.
- `./stuga upgrade` refuses a `compose.yml` older than the data.
- `./stuga restore` works without a node container.
- After a failed upgrade, `./stuga` offers the backup the new version took.
- `install.sh` stops at once when the node refuses its data.
- The menu bar runs the new Stuga.app after an update.
- A patch to an older release line leaves the `:<major>` image tags alone.

## [0.1.11] - 2026-10-02

### Fixed

- Search by meaning finds what you can read when many passages you can't read sit closer to the question.

## [0.1.10] - 2026-10-01

Stronger sign-in: wrong-password pauses, a costlier password hash, sessions that end at once, and
**Revoke everything**.

### Upgrade notes

- Everyone signs in again after upgrading, and apps connected over OAuth connect again.
- Over plain http, the node takes passwords only from its own network. Add public ranges that belong to it with `LOCAL_PASSWORD_NETWORKS` ([Network access](docs/network-access.md#passwords-over-plain-http)).

### Added

- **Revoke everything** in **Settings → Profile** ends every session, connected app, API key and shared link; administrators do it for others under **Account recovery**.
- Alerts say whether the node's notifications sent them.
- Changing your email or the node's notification channel is told to you and the administrators.

### Changed

- Reviewing an agent's edits, a rewritten sentence shows as one removal and one insertion.
- Wrong passwords pause sign-in for that account, longer each time; a browser that signed in before keeps working ([Privacy](docs/privacy.md#what-the-node-stores)).
- Passwords are stored with a stronger hash, upgraded at the next sign-in.
- A long passphrase needs no letter-and-number mix.
- Signing out, a password change or a reset ends a session's access at once.
- Sensitive changes ask you to confirm it's you if you signed in more than five minutes ago.
- An invite made through the API without limits admits one person for seven days.
- Slack, Discord and Teams notifications show names as written, never as links or mentions.

### Fixed

- An old browser waking up after a password change no longer signs you out of the one you just used.
- On a Mac, **Login Items** lists Stuga's background services under Stuga, not as `bash`.
- Removing a chat provider deletes its API key too.

## [0.1.8] - 2026-09-30

### Changed

- Reviewing an agent's edits, a reworded passage reads as before → after with the line it sits in, and an edit beside a deleted section is a change of its own.

### Fixed

- **Uninstall Stuga…** in the Mac's menu bar no longer stalls for two minutes.
- On a Mac with no Apple Account signed in and nothing shared, the Mac's `.local` address now works: Stuga advertises itself over Bonjour while it runs.
- On a Mac, the setup page opens once Stuga has started, and **Set Up Stuga…** no longer asks the Mac's administrators for a password.
- **Copy link** on a document copies it at the node's address, not the one the browser reached it at.

## [0.1.7] - 2026-09-30

The first release: documents, databases and search for a team, on your own machine, with AI agents
whose edits wait for review.

### Added

- Documents edited together in real time, with comments, @mentions and version history.
- Databases with views, row pages and CSV import.
- Search in 22 languages; semantic search once an AI provider or Ollama is set up.
- AI agents connect over MCP; their edits wait for a person to accept them ([docs/agents.md](docs/agents.md)).
- Built-in AI with a hosted provider or Ollama, off until an administrator turns it on.
- Import from Notion and Obsidian; export a workspace as a `.stuga.zip`.
- Invite links, groups, guests and sign-in through your own OpenID Connect provider.
- A Mac package and a Docker stack for Linux, with daily backups and **Update now**.
- Remote access, by invitation for now ([docs/remote-access.md](docs/remote-access.md)).
