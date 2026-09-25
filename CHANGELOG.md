# Changelog

Every release of Stuga, newest first, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format. The release workflow reads this file ([RELEASING.md](RELEASING.md#the-changelog)): an entry
becomes its version's release notes, and its date and whether it has a **Security** section are what
a running node learns about the version.

An entry's **Upgrade notes** section says what someone running a node has to decide or do. Without
one, the release notes say there is nothing to do.

## [Unreleased]

### Upgrade notes

- Apps that signed in to the node through OAuth, such as Claude Code, Codex, Antigravity and Claude
  on the web, have to sign in again: the keys those sign-ins created are revoked. Each person then
  chooses the app's workspaces and access.
- Replace the Claude Desktop extension: remove the old **Stuga** extension in Claude Desktop, add
  the new one from **Settings → Your own AI**, and revoke the old extension's key under
  **Connected agents**.
- Skills, prompts and scripts that call the MCP tools by name need the new names, and a
  `workspace_id` on every call. Running the Codex or Antigravity installer again replaces the Stuga
  Skill it installed.

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
- The setup link, invite links and share links stay in the address bar, so they can be copied from
  there. Opened signed out, an invite or share link shows sign-in at its own address instead of
  moving to `/login`.

### Removed

- `POST /api/agent-bundle`, and the key it minted into each download.
- `STUGA_WORKSPACE`, and the `workspace` field of the stdio server's config files.

### Fixed

- A document or folder an agent created stayed private to the person it acted for, whatever the
  workspace's default access, so other members could not see it until that person shared it. It now
  gets the default, like one the person creates. Items made before this release keep their sharing.
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

## [0.1.1] - 2026-09-24

### Fixed

- The one-step Docker install (`curl … | bash`) stopped after "Stuga is running" without printing
  the link that creates the administrator account. On a node installed with 0.1.0, `./stuga status`
  prints that link.

## [0.1.0] - 2026-09-24

The first release.
