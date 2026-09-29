# Changelog

Every release of Stuga, newest first, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format. The release workflow reads this file ([RELEASING.md](RELEASING.md#the-changelog)): an entry
becomes its version's release notes, and its date and whether it has a **Security** section are what
a running node learns about the version.

An entry's **Upgrade notes** section says what someone running a node has to decide or do. Without
one, the release notes say there is nothing to do. A few lines under the version heading, before
its first section, are its summary: the release notes show that and link here for the rest.

## [Unreleased]

### Added

- **Cursor, VS Code, Kiro, Goose and LM Studio** in **Settings → Your own AI**: one link opens the app
  with the node filled in, and the app signs in. Apps are now picked from one searchable list, grouped
  into chat apps, editors and coding agents, and the page remembers the last one.
- **Remote access** in **Settings → Remote access**, for a node whose packaging names an account
  service (`STUGA_REMOTE_SERVICE`): the node gets its own https address through a relay that passes
  the encrypted connection on without reading it. The node creates its key and certificate itself
  and serves the address on a second listener, so the LAN address and everyone's sessions stay as
  they are. What the node sends the service is in [docs/remote-access.md](docs/remote-access.md).

### Changed

- The setting is now called **Let AI edits apply directly** (was **Let agents apply changes at
  once**), and its chip **AI edits apply directly**: it covers the co-author as well as connected
  agents. What agents are told about it uses the same name, so they can point a person to it.
- On https, the cookie that lets a browser show images is now `__Host-stuga_media`, and images answer
  only their own origin (`Cross-Origin-Resource-Policy: same-origin`). An app served from another
  origin than the node needs `MEDIA_COOKIE_SAMESITE=none`.

### Fixed

- Cursor and Gemini CLI can sign in to a node. The node accepts a desktop app's own return address,
  such as Cursor's `cursor://`, and names itself in the sign-in answer, which Gemini CLI 0.61
  requires.
- On a document or database set to let AI edits apply directly, the co-author's and the table
  assistant's edits apply directly too, where they still waited for review change by change. The
  co-author's edits to another document set that way apply directly as well.

## [0.1.4] - 2026-09-28

- Attach any file to a document, or to a database row in a Files column.
- Start a workspace from a Notion export or an Obsidian vault.
- Reranking with TypeSafe's Jev, reading the part of a passage that matches the question.
- The co-author, Ask and the table assistant run on Pi, and Pi connects as your own AI.
- Search in 22 languages.

### Added

- Attach any file to a document: **Insert → File…**, the `/file` command, or paste or drop it. It
  shows as a link named for the file, which downloads it; exports and imports carry it.
- A **Files** column type for databases: a cell holds a row's attachments, added with + or by
  dropping files on it, each downloaded with a click. The database keeps its files and deletes them
  with it. A Notion Files & media property imports as one.
- `media_upload` stores any file, into a document or a database, and its new `start_upload` action
  hands an agent that can send the file itself a URL to PUT it to. The stdio server's
  `media_upload` takes a local `file`.
- **Create a workspace → From a file** also takes a Notion export (Markdown & CSV) or a zipped
  Obsidian vault or other folder of Markdown. Pages and notes become documents, databases keep their
  rows with typed columns, and links, `[[wikilinks]]` and images lead where they did. PDFs and
  other files a page links to come along; files nothing links to, or over the upload limit, are
  listed first, and the import goes ahead once you confirm
  ([docs/import.md](docs/import.md)). An import takes a file of up to 512 MB (was 50 MB), no longer
  held to the node's upload limit, which stays 10 MB for images and files.
- Twenty more search languages beside Korean and Arabic. **Chinese** adds jieba word segmentation
  and **Japanese** a Lindera dictionary; Czech, Danish, Dutch, Finnish, French, German, Greek,
  Hungarian, Italian, Norwegian, Polish, Portuguese, Romanian, Russian, Spanish, Swedish, Tamil and
  Turkish each add pg_search's stemmer, so a word is found in another of its forms, `chevaux` for
  `cheval`.
- **Reranking** in **Settings → This node → AI providers**: TypeSafe's Jev, directly or through
  OpenRouter, puts the most relevant passages first for Ask and agents. On the public MIRACL
  benchmark in six languages it put a relevant passage first 77% of the time, within the margin of
  Claude Opus 5.5 (81%) and Cohere Rerank 3.5 (78%), in about 0.1 s and at a hundredth of Opus's
  cost. Without it, Built-in AI reranks as before.
- The Mac menu-bar app says when Stuga has stopped, cannot reach its database or stops responding,
  and is still failing a minute later: once, in an alert with **Restart Stuga…** and **Show Logs**.
  Starting, however slowly, backing up and installing an update, from **Update now** or a downloaded
  `Stuga.pkg`, do not count.
- **Pi** in **Settings → Your own AI**: install the adapter and `@stuga/pi-package`, then sign in
  from Pi with `/mcp-auth stuga`, or use an agent key. Its runs are labelled `pi` in the review inbox.

### Changed

- The co-author, Ask and the table assistant run on Pi's agent runtime. Models Pi knows get their
  vendor's handling: Kimi K3 keeps its reasoning between tool rounds, OpenAI goes through its
  Responses API, and a model that cannot see images is told so. Reasoning models think at a low effort.
- The node runs on Node.js 26 (was 22), in the Docker image and in the Mac app.
- First-run setup no longer asks about checking for new versions: it is on, and **Settings → This
  node → About** turns it off. `POST /auth/register` no longer takes `update_check`.
- Search languages are now **Languages in your documents**, a searchable list at setup and in
  **Settings → This node → Search**, with English always on. Setup starts from English alone.
- **Search by meaning** in **Settings → This node → AI providers** and at first run is now
  **Embeddings**, the name AI services give it.
- Reranking, and reranking with Built-in AI, read the part of a long passage that best matches the
  question, up to 1,200 characters, where they read its first 1,200. A section's answer is often
  past its opening: on BRIGHT's StackOverflow questions, whose passages run to 4,000 characters, Jev
  put a right passage first for 48% of the questions whose candidates held one, instead of 31%.

### Fixed

- A browser still signed in to a node that was since wiped or reinstalled opens its setup link
  with the setup code filled in, instead of on a page that asks for it.
- With **Built-in AI** switched off, Ask's and agents' retrieval no longer sends passages to the chat
  provider to rerank them.
- Reranking with Built-in AI asks a reasoning model for no reasoning, or the least it offers, and
  leaves room for what remains. Reasoning used to crowd out the answer and leave searches unranked.
- Reranking with Built-in AI reads the scores a model writes one per line, as `[n] score` lines, or
  with a note after the list, where it used to keep the search's own order. An answer cut off at the
  token cap is still not used.
- When the AI provider fails a request because the account is out of credit, the key is refused,
  requests are limited or the provider is down, Ask, the co-author and the table assistant say so in
  plain words. Ask said only that something failed; the other two showed the provider's own message,
  which can name the account.
- The node logs why a request from Ask, the co-author or the table assistant failed, and why a
  rerank failed or could not be used: the protocol, the model, the kind of failure and the
  provider's message. It logged none of these.

## [0.1.3] - 2026-09-26

### Added

- The plugin for Claude has an icon.
- `@stuga/mcp` ships a lockfile, `npm-shrinkwrap.json`, which shows it installs no other package.

## [0.1.2] - 2026-09-26

- One AI connection reaches several workspaces: you choose which, and whether it may suggest
  changes. A plugin for Claude installs it.
- Export a workspace as one file, and start a new one from a file or a sample workspace.
- Korean and Arabic search are a node setting, and right-to-left text reads right to left.
- Version history keeps every edit, and a restore can be undone.

### Upgrade notes

- A node on 0.1.x does not upgrade to this version: its database schema starts over. Start this
  version with a new database and data directory.

### Added

- One agent connection reaches several workspaces. `search` and `retrieve` take `workspace_ids`,
  one or more workspaces or `["*"]` for every one the connection reaches, merge the results by rank,
  name each result's workspace, and list under `unavailable` any workspace they could not cover.
- Signing in an app asks which workspaces it may use, optionally including ones you join later, and
  whether it may suggest changes or only read. The consent page shows an app as verified by the host
  of its client metadata document, or as unverified.
- **Connected agents** lists each app that signed in as a connection, with Rename and Revoke, and
  `GET`, `PATCH` and `DELETE /api/me/connections` do the same. Leaving a workspace takes it out of
  your connections.
- OAuth access tokens last an hour and renew with refresh tokens that are replaced at every use; a
  sign-in ends after 90 days unused, or a year after it happened. A spent refresh token presented
  again after `REFRESH_ROTATION_GRACE_SECONDS` ends its sign-in.
  `POST /oauth/revoke` ends a sign-in. Clients may identify themselves by a client metadata
  document, advertised on a public https origin. OAuth discovery answers on each of
  `PUBLIC_ORIGIN` and `EXTRA_ORIGINS`, and a loopback redirect URI matches on any port.
- MCP tool annotations, so a client can tell reads from writes and ask before a destructive call.
- `databases_add` action `start_import` returns an upload URL for a caller that can send a file
  itself.
- The Claude Desktop extension and `stuga-mcp` sign in through the browser when they have no key.
- A plugin for Claude: the Stuga Skill and the stdio server, installed in Claude Code with
  `/plugin marketplace add stuga-dev/stuga-plugin` and `/plugin install stuga@stuga`. Each release
  publishes it from `integrations/` to stuga-dev/stuga-plugin, and the server to npm as
  `@stuga/mcp`, so any client that starts local servers can run `npx -y @stuga/mcp`.
- Search languages are a node setting: Korean and Arabic keyword search are chosen at first-run
  setup and in **Settings → This node → Search**. A change rebuilds the search indexes while the node
  runs, and search keeps answering meanwhile. `PUT /api/node/settings` takes `search: { languages }`,
  `GET` answers `search` in place of `node.search_languages`, and `POST /auth/register` takes
  `search_languages`.
- A workspace can be exported as a workspace archive, one `.stuga.zip` of Markdown, rows, images and
  a manifest, from **Settings → This workspace → General → Export**: everything you can open, with
  its comments, views and row pages. `GET /api/workspaces/:id/export` does the same for a workspace
  owner or admin. `docs/workspace-archive.md` describes the format.
- A new workspace can start from an archive: **Start with → From a file** when you create one, or
  `POST /api/workspaces/import`. Its comments keep their threads, times and authors' names. It shows
  nowhere until the import is done, and a node stopped partway deletes it when it starts again. A
  backup, the daily one or **Back up now**, waits up to three hours while a workspace is being
  imported or exported, and no new import or export starts while it waits.
- `stuga-node archive check <directory>` checks an unzipped workspace archive.
- Sample workspaces: **Start with** offers samples of real, openly licensed material, such as
  Python specs, a team handbook, market research and privacy laws in six languages. The node
  downloads the list and the chosen sample from
  [stuga-dev/samples](https://github.com/stuga-dev/samples), or from a mirror `SAMPLES_URL` names,
  and checks each download against the list. Sample agent's changes wait in **Review AI edits**.
  `GET /api/workspace-samples`, and `sample` on `POST /api/workspaces`.

### Changed

- **The MCP tools are split into reads and writes**, nineteen in all. `docs` action `search` is now
  `search`; `docs` action `create` is `docs_create`; the `markdown` writes are `markdown_append` and
  `markdown_edit`; `media` is `media_upload`; `comments` action `add` is `comments_add`; the
  `collections` changes are `collections_edit`; and the `databases` writes are `databases_add` and
  `databases_change`. `databases` action `page` only finds a row's page, and `databases_add` action
  `open_page` opens or creates it. The old names are gone.
- **Every MCP tool but `workspaces` action `list`, `search` and `retrieve` requires
  `workspace_id`.** A connection has no home workspace, and no call falls back to one.
  `workspaces` action `list` answers `{ contract: 2, workspaces, unavailable }`, each workspace with
  its role, the connection's access and its node, and no `home_workspace_id`.
- MCP search results carry no scores.
- A read-only key or connection is offered only the reading tools.
- An agent no longer acts in a workspace where its person is only a guest, on `/mcp`.
- **OAuth creates a grant, not an API key.** Its tokens work only on `/mcp`, and `GET /api/keys`
  lists keys only.
- **`stuga-mcp` forwards to the node's `/mcp`**, so its tools, instructions and checks are the
  node's. It no longer calls the REST API.
- **The Claude Desktop extension is one extension, `stuga`, for every node, and carries no key.** It
  asks for the node's address and an optional key. `GET /api/agent-bundle` serves it.
- **Your own AI** offers the **Claude** tab only when the node's public address is https as well.
- A restore leaves the search indexes to the node, which builds them when it starts.
- The setup link, invite links and share links stay in the address bar, so they can be copied from
  there. Opened signed out, an invite or share link shows sign-in at its own address instead of
  moving to `/login`.
- Right-to-left text, such as Arabic, reads right to left: in a document's paragraphs, headings,
  lists, quotes and table cells, and in titles, the outline, comments, Ask and AI answers, and the
  changes in **Review AI edits**. Code stays left to right.

### Removed

- `POST /api/agent-bundle`, and the key it minted into each download.
- `STUGA_WORKSPACE`, and the `workspace` field of the stdio server's config files.
- `SEARCH_LANGUAGES`: the search languages are a node setting.

### Fixed

- Keyword search went over up to the last thousand document saves again on every query, so a search
  over long documents took seconds.
- A document or folder an agent created stayed private to the person it acted for, whatever the
  workspace's default access, so other members could not see it until that person shared it. It now
  gets the default, like one the person creates.
- A Markdown body an agent sent with `POST /api/docs` landed at once. It is now proposed and waits
  for review, like the agent's other writes.
- Signing in with a password went to the library instead of the page that sent you to sign in, such
  as an invite link or a document.
- An edit made within five minutes of the last version, with no edit after it, never became a
  version. It now becomes one once the five minutes pass, or when someone leaves the document.
- An edit that only changed formatting, such as making text bold, never became a version.
- A version named only the people who edited in its last half minute. It now names everyone who
  edited since the version before it.
- Restoring a version lost the edits made since the last version, including ones not yet saved. The
  document as it was before the restore is now kept as a version, so a restore can be undone.
- The Versions panel called the newest version **Current** even when the document had changed since,
  and did not show new versions until it was reopened.
- A version's added and removed character counts included lines that had not changed.
- Restore and Delete showed for people who cannot use them, and the error named only the owner.
- Comparing a version with the current document did not show edits made while the comparison was
  open.
- While names loaded, the Versions panel, comments, database activity and the Share dialog showed
  people's ids, and someone who had left the workspace showed by their full id.
- Clicking at the end of a line where a collaborator's cursor sat put your cursor at the start of the
  line, so what you typed landed before their text. Double-clicking a word their cursor sat in could
  select only part of it, and clicking their cursor's flag did nothing; it now puts your cursor there.
- A backup that paused a document while someone had unsaved edits logged errors, could list a version
  the document did not keep, and lost the last edits of someone who closed the document meanwhile.
- A name such as `__init__` came back from a document's Markdown, in an export or an agent's read,
  with `init` in italics.
- A database dropped the view you had chosen when it reloaded, as it does when a proposal is applied
  or someone else changes it.

## [0.1.1] - 2026-09-24

### Fixed

- The one-step Docker install (`curl … | bash`) stopped after "Stuga is running" without printing
  the link that creates the administrator account. On a node installed with 0.1.0, `./stuga status`
  prints that link.

## [0.1.0] - 2026-09-24

The first release.
