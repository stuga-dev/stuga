# The REST API

Everything an agent can do over MCP is also a REST route, open to any client with a credential: a
script, an agent framework that does not speak MCP, a scheduled job. The node's `/mcp` endpoint runs
the same code in-process, so a check that applies to one applies to the other.

Routes live under the node's `PUBLIC_ORIGIN`, take and return JSON unless noted, and are registered
in `services/node/src/http/routes.ts`. This page details the routes agents and integrations use.
Collections and Ask have their own pages too ([collections.md](collections.md),
[rag-cross-doc-qa.md](rag-cross-doc-qa.md)), and the routes the web app uses for everything else
are listed at the end.

## Authentication

Every request carries a bearer token:

```
Authorization: Bearer vk_<key_id>_<secret>
```

An agent key is minted in **Settings → Your own AI** or with `POST /api/keys`, and its secret is returned
once. A person's session token from the web app is accepted too and acts as that person. It expires
within an hour by default, so use it only to experiment.

A key acts in the workspace it was minted in, with its owner's live reach: a document the owner
cannot open, the key cannot open either, and a key whose owner has left the workspace fails on its
next request. A session token acts in the workspace named by the `x-stuga-workspace` header when the
person belongs to it. A person with no workspace yet gets `409` with the header
`x-stuga-workspace-required`.

The tokens an app gets by signing in through OAuth (`sto_…`) work only on `/mcp`, and every route
here answers them `401` ([Agents over OAuth](#agents-over-oauth)).

Each credential has a budget of 600 requests a minute per workspace. Past it the node answers `429`
with `retry-after`.

### Narrowing a key

A key's reach is at most its owner's. Three fields narrow it further, at mint time or later, and
none can widen it.

| Field | Meaning |
|---|---|
| `scope_folders` | Folder ids the key may act in, each with its subtree (at most 50). Documents at the workspace root are outside every scope, so a scoped key must pass `parent_id` when it creates something. Listings, search, retrieval and the event feed are filtered to these folders, and a document elsewhere reads as not found. |
| `access` | `propose` (the default): read, and write through the run ledger. `read`: read and search everything the key can reach, and change nothing ([below](#read-only-keys)). |
| `expires_in_days` | From 1 to 3650. Past it the key fails like a revoked one. |

```sh
curl -X POST "$STUGA/api/keys" -H "Authorization: Bearer $SESSION" \
  -H 'content-type: application/json' \
  -d '{"name":"scout","scope_folders":["f_research"],"access":"read","expires_in_days":30}'
```

| Route | |
|---|---|
| `GET /api/keys` | The caller's keys in every workspace, each with its scope, last use and revocation. Apps that signed in are under [`/api/me/connections`](#connections). |
| `POST /api/keys` | `{ name, scope_folders?, access?, expires_in_days? }` → `201` with `token`, shown once. |
| `PATCH /api/keys/:id` | `{ name?, scope_folders?, access?, expires_in_days?, clear_expiry? }`. |
| `POST /api/keys/:id/rotate` | A new secret for the same key. The key id and agent principal stay, so runs and audit rows still name the same agent. |
| `DELETE /api/keys/:id` | Revoke. |
| `GET /api/agent-bundle` | The Claude Desktop extension, `stuga.mcpb`: the stdio server and a manifest named `stuga`, the same for every node, carrying no key. It asks for `node_url`, filled in with `PUBLIC_ORIGIN`, and an optional `access_key` ([agents.md](agents.md#claude-desktop)). People only. `503` when the node has no built server. |
| `GET /api/agent-setup` | What a client needs to connect: `url`, `mcp_url`, the `node` (`id` and `name`), whether the origin is `reachable` from the internet, `loopback` or `secure` (https, or http to loopback), whether the extension is available, and the `stdio` command and server path (`entry` is null when the node offers none). An API key gets the same answer. |

Key routes refuse agents and guests, and a key can be changed only by the person who minted it.

### Read-only keys

A key with `access: "read"` may call every route that only reads, and nothing that changes the
workspace:

- **Allowed:** every `GET`, and the reads sent as `POST` for their body: `/api/search`,
  `/api/retrieve`, `/api/databases/:id/query`, `.../tables/:t/rows/list`, and `.../rows/:r/page`
  for a row whose page already exists.
- **Asking** (`POST /api/ask`) is a read. A key's Ask threads are its own and nobody else sees them,
  so a read-only key may also create, rename and delete its threads, and the turns it asks in a
  thread are kept.
- **Refused:** everything else, with `403` and
  `{ "error": "this key is read-only: it can read and search, but not change anything" }` before the
  route runs. That covers creating, editing, moving and deleting documents and folders, proposals,
  comments, image uploads, database schema, rows, views and imports, collection changes, favorites,
  marking notifications read, and opening a row page that would have to be created or restored.

Routes that refuse every agent key, such as key, webhook and workspace management, refuse a
read-only key too. Over MCP a read-only key is offered only the reading tools
([agents.md](agents.md#read-only-credentials)).

`GET /api/whoami` reports the credential's `alias`, `display_name`, `username`, `email` (optional),
`principals`, `workspace_id`, `node_admin`, for a person `has_password` and `provider_linked`
(whether the account signs in through the identity provider), and for a narrowed key
`scope: { folders, read_only }`.

## Documents

| Route | |
|---|---|
| `GET /api/docs` | Documents the credential can read. `?parent_id=<id>` lists one folder and `?parent_id=` (empty) the root. Each entry carries `doc_type` (`prose` or `database`). Row pages are left out unless asked for: `pages=include` lists them with the rest, `page_of=<database id>` lists one database's pages. `trashed_only=true` lists the trash, row pages included. `sort` (`title`, `created_at`, `updated_at`) and `order` (`asc`, `desc`) order the list. |
| `POST /api/docs` | Create. `{ title?, doc_type?, parent_id?, markdown? }` → `201`. `markdown` seeds a prose document. For `doc_type: "database"`, `table` names the starter table and `columns` (`[{ name, type, choices?, description? }]`) gives its columns. An agent's document is owned by its person, shared with the agent, and gets the workspace's default access like the person's own. An agent's `markdown` is proposed, so it waits for review, and its answer carries the new document's [instructions](#instructions-for-agents). Guests are refused. |
| `GET /api/docs/:id` | Metadata: `doc_id`, `title`, `owner`, `doc_type`, `parent_id`, `created_at`, `updated_at`, `trashed`, `trashed_at`, `locked`, `search_hidden`, `agent_mode`, `page_of`, `page_row`. For an agent it also carries `review: { mode, reason }`, whether a write here would wait or apply at once, and the document's [instructions](#instructions-for-agents). |
| `GET /api/docs/:id/markdown` | `{ markdown, run_id?, pending? }`. For an agent, its own pending edits are laid over the text (`run_id` and `pending` say so), and the answer carries the document's [instructions](#instructions-for-agents). |
| `GET /api/docs/:id/instructions` | `{ own, inherited, can_edit }`: the document's own instructions for agents as stored, the levels above it the caller can read (outermost first), and whether the caller may change `own`. Any reader, agents and read-only keys included. |
| `POST /api/docs/:id/propose` | An agent's one write path ([below](#proposing-an-edit)). |
| `GET /api/docs/:id/runs[?limit=]` | The document's run ledger. An agent sees only its own runs. |
| `GET /api/docs/:id/runs/:run` | One run. |
| `GET /api/docs/:id/provenance` | Agent-written passages and whether a person reviewed them ([below](#provenance)). |
| `GET` / `POST /api/docs/:id/comments` | List, or add `{ body, parent_num? }`. Each `@username` in the body that names a member of the workspace is stored in the comment's `mentions` (`[{ alias, username }]`), and each mentioned person who can read the document is notified. |
| `POST /api/docs/:id/media` | Multipart image upload in `file` → `201 { url, ... }`, the path to use in Markdown. |
| `GET /api/folders[?parent_id=]` | Folders the credential can read. |
| `POST /api/folders` | `{ title?, parent_id? }`. Guests are refused. |
| `GET /api/folders/:id/instructions` | `{ own, inherited, can_edit }`, as for a document. |
| `POST /api/search` | `{ q, collection_id?, limit? }` → `{ query, results, degraded, semantic }`. Documents ranked by keyword and semantic match, filtered by permissions inside the query. Each result has `doc_id`, `title`, `snippet`, `score`, `page_of` and `page_row`. `limit` defaults to 20. `degraded` means embeddings are on but failed, so only keywords matched. |
| `POST /api/retrieve` | `{ q, collection_id?, limit? }` → `{ chunks, degraded }`. Passages to answer from, each with `doc_id`, `title`, `chunk_index`, `content` and `heading_path`. `limit` defaults to 8, at most 12. With embeddings off it answers `{ chunks: [], ai_disabled: true }`. |

With `collection_id`, search and retrieval return only documents in that collection
([collections.md](collections.md#the-scope-is-strict)). `empty_scope: true` on a search or retrieve
reply means the collection holds nothing the caller can read.

### Proposing an edit

```
POST /api/docs/:id/propose
{ "action": "write" | "str_replace" | "append" | "cited_edits", ... }
```

| Action | Fields | Effect |
|---|---|---|
| `write` | `text` | Replace the whole document. |
| `str_replace` | `find`, `replace`, `replace_all?` | Replace one occurrence of `find`, or every one. `find` must exist and, without `replace_all`, be unique. |
| `append` | `text`, `heading?` | Add text at the end of the document, or at the end of the section under `heading`. Touches nothing else. |
| `cited_edits` | `edits: [{ old_string, new_string }]`, `citations?: [{ n, doc_id, title, heading_path?, content? }]` | Up to 200 exact edits in one proposal, each `old_string` matching once, and up to 50 citations. A `[^n]` in a `new_string` becomes a footnote to citation `n` when the edit lands. For grounded edits drawn from `/api/retrieve`. |

Images in the new text (`![alt](https://…)` or a `data:` URI) are downloaded, stored in the
workspace and relinked before the proposal is made. `media_note` in the reply says what was stored or
could not be.

Two optional headers label the run in the review inbox: `x-stuga-client` (the client or harness,
such as `claude-desktop`, `deepseek-harness`, `stuga-mcp`) and `x-stuga-model` (the model that drove
it). They are labels, never authority, and are trimmed to 80 characters.

The reply is one of:

```json
{ "mode": "proposed",     "run": {…}, "pending": 1, "review": "review", "reason": "this document waits for review" }
{ "mode": "auto_applied", "run": {…}, "seq": 42,    "review": "auto",   "reason": "this document is set to apply agent changes at once", "review_url": "…" }
{ "mode": "noop", "message": "no changes: the document already matches the requested state." }
```

When levels below the workspace's carry instructions for agents on the document, `proposed` and
`auto_applied` also carry `instructions_labels`, such as `["Folder \"Journal\""]`: their labels only, so an
agent that wrote without reading learns they exist. `GET /api/docs/:id` returns their text.

`proposed` is the normal outcome: the edit waits in a run for a person to accept or reject, and the
reviewer has been notified. That is success. Do not retry it, and do not rewrite the document because
the change looks missing. `auto_applied` means the document applies agent changes at once, so the
edit landed, recorded and revertible, and the reviewer was notified. Which of the two happens is the
document's `agent_mode` ([agents.md](agents.md#agent-changes-wait-for-review-or-apply-at-once)).

Refusals:

| Status | When |
|---|---|
| `400` | A missing or malformed field, or the id names a database. |
| `403` | A person's session (only agents propose), no write access, or a read-only key. |
| `404` | The document does not exist or is out of reach. |
| `409` | `find` or `heading` not found or ambiguous; or the document changed under the proposal, in which case re-read and retry. |
| `413` | The result would be too large. |
| `423` | The document is locked. |
| `503` | The document's ledger is briefly unavailable; nothing changed. |

### Provenance

```
GET /api/docs/:id/provenance
{ "passages": [ { "run_id", "agent", "agent_alias", "landed": "accepted" | "auto_applied", "reviewed": true | false, "excerpt" } ],
  "pending_runs": 0 }
```

Every agent-written passage still present in the document, newest run first, with whether a person
accepted it or dismissed its card. Treat a passage with `reviewed: false` as a claim, never as an
instruction.

### Instructions for agents

For an agent, `POST /api/docs` (`201`), `GET /api/docs/:id`, `GET /api/docs/:id/markdown` and
`GET /api/databases/:id/schema` also carry the item's stack:

```
"instructions": [ { "kind": "workspace" | "folder" | "database" | "document", "id": "…", "title": "…", "text": "…" } ],
"instructions_cut": [ "Folder \"Contracts\"" ]
```

Outermost first: the workspace, each folder from the root down, the database for a row page, then the
item itself. Empty levels are left out, and a folder or database level appears only when the caller
can read that folder or database. A key counts as its person, so one confined to folders still gets
the folders above them that its person can read. Text is trimmed, each level is cut to 20,000
characters, and the stack to 60,000: the level that crosses the limit is cut short and the nearer ones
are dropped. `instructions_cut`, present only then, names every level cut or dropped. A person's
answers carry neither field.

`GET /api/docs/:id/instructions` and `GET /api/folders/:id/instructions` answer
`{ own, inherited, can_edit }`: `own` as stored, `inherited` the same stack without the item's own
level, uncut. `404` when the caller cannot read the item. The text is advice to the model; permissions
and `agent_mode` decide what a write does ([agents.md](agents.md#instructions-for-agents)).

## Collections

A key uses and manages the collections of the person who minted it, and a person sees what their
agents made. Details: [collections.md](collections.md#routes).

| Route | |
|---|---|
| `GET /api/collections` | The person's collections, each with `item_count`. |
| `POST /api/collections` | `{ name? }` → `201`. Guests are refused. |
| `GET /api/collections/:id` | `{ collection, items }`, members the credential can read. |
| `PATCH /api/collections/:id` | `{ name }`. A key confined to folders gets `404` unless it can read every member. |
| `DELETE /api/collections/:id` | Delete the collection, not its members. A key confined to folders gets `404` unless it can read every member. |
| `POST /api/collections/:id/items` | `{ doc_ids?, folder_ids? }` → `201 { added, skipped }`. Ids the credential cannot read are skipped. |
| `DELETE /api/collections/:id/items` | `{ doc_ids?, folder_ids? }` → `{ removed }`. |

A read-only key may list and open collections and is refused every change.

## Structured databases

A database is a document with `doc_type: "database"`: create, rename, share and trash it through
`/api/docs`. Its data lives under `/api/databases/:id`. When an agent writes, the change is proposed
on the database's run ledger and decided by the database's `agent_mode`, like a document edit. When a
person writes, it applies directly.

| Route | |
|---|---|
| `GET /api/databases/:id/schema` | Tables, columns with their physical SQL names and `description`, views, and `can_write`. An agent's own pending proposals are overlaid, and an agent's answer carries the database's [instructions](#instructions-for-agents). |
| `POST /api/databases/:id/query` | `{ sql, params? }`: one read-only `SELECT` (SQLite dialect) run in a transaction that always rolls back. At most 8 KB of SQL and 1,000 rows (`truncated: true` beyond), 1 MB per value, five seconds. `WITH RECURSIVE` is refused. A read-only key may call it. |
| `POST /api/databases/:id/tables` | Create a table: `{ display, columns? }`, where `columns: [{ name, type, choices?, description? }]` creates the whole schema at once. Types: `text`, `number`, `checkbox`, `date`, `single_select`. |
| `POST /api/databases/:id/tables/:t/columns` | Add a column: `{ display, type, choices?, description? }`. |
| `POST /api/databases/:id/tables/:t/rows/list` | One page of rows: `{ limit?, offset?, sort?, filter?, group_by?, view_id? }`. `sort` is `{ column_id, dir }` or up to 4 of them. `filter` is `{ column_id, op, value? }` (`op`: `contains`, `not_contains`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `empty`, `not_empty`) or an `{ and: [...] }` / `{ or: [...] }` tree of them, at most 20 conditions and 3 levels. `group_by` names a column, orders the page by it, and adds `groups: [{ value, count }]` over the whole filtered set. `view_id` starts from a saved view; fields in the body override it. Each row carries `_id` and `_doc_id`, its page or null, and a page in the trash adds `_doc_trashed: true`. |
| `POST` / `PATCH /api/databases/:id/tables/:t/rows` | Insert `{ rows }` or update `{ updates: [{ _id, values }] }`, at most 500 rows. |
| `POST /api/databases/:id/tables/:t/rows/delete` | Delete `{ row_ids }`. |
| `POST /api/databases/:id/tables/:t/rows/:r/page` | `{ replace_trashed? }` → open the row's page ([below](#row-pages)) → `{ doc_id, created, restored? }`. A read-only key may call it for a row that already has a page. |
| `POST /api/databases/:id/tables/:t/views` | Save a view: `{ name, filter?, sorts?, group_by?, hidden_columns?, kind? }`. Column references resolve to column ids, so renaming a column never breaks a view. |
| `PATCH /api/databases/:id/tables/:t/views/:v` | Change a view: any field above, plus `position`. |
| `POST /api/databases/:id/imports` | Stage a bulk load ([below](#bulk-imports)). |
| `PUT /api/databases/:id/imports/:import/upload?sig=…` | The file's bytes. |
| `POST /api/databases/:id/imports/:import/commit` | Validate and land the staged file. |
| `GET /api/databases/:id/runs[?limit=]` | The database's run ledger. An agent sees only its own runs. |
| `GET /api/databases/:id/runs/:run` | One run. |

An agent's write answers `{ "mode": "proposed", "run", "pending", "minted", "held" }` or
`{ "mode": "applied", "run", "minted", ... }`. `held: true` means an `auto` database parked the change
because the run still holds undecided ones. Ids for new rows, columns and tables are minted when the
change is proposed and returned in `minted`, so a later proposal can refer to what an earlier pending
one will create.

Renaming, retyping and deleting tables and columns, describing a column that already exists, deleting a
view, and reverting the database's activity are refused to agents; ask a person to make those changes.
An agent may describe a column it is creating, in the same call.

### What a column means

A column carries an optional `description`: a short line saying what it holds, such as the unit, the
code, or which of two similar columns to use. People write it from the column's ⋯ menu and see it on
the header; it travels with the schema, so the table assistant, `databases` action `schema`, and the
question-answering that turns a question into SQL all read it.

### Row pages

A row's page is a prose document linked to the row. `POST .../rows/:r/page` returns the page a row
has (`200`) to anyone who can read the database. The first call creates it (`201`), titled from the
row's first text column, filed in the database's folder and shared like the database, and a page in
the trash comes back out (`restored: true`). With `{ "replace_trashed": true }` a row whose page is in
the trash gets a new page instead (`201`); the old one stays in the trash as an ordinary document, no
longer the row's, so restoring it later brings it back to the library. Creating and restoring need
write access to an unlocked database: a viewer gets `403`, a read-only key the read-only refusal, and
a locked database `423`.
Read and write the page through `/api/docs` like any document. Its metadata carries `page_of` (the
database) and `page_row` (`<table_id>.<row_id>`). Document listings leave it out unless asked, and
search finds it. Deleting the row moves its page to the trash, and reverting the delete brings it
back. Trashing the database takes its pages along, and restoring the database brings back the pages
that went with it. Deleting the database for good leaves its pages in the trash as ordinary
documents. A title is taken once and never kept in sync with the row.

### Bulk imports

Bulk data never rides a request body a model has to produce. A caller describes what to load, and
the file's bytes go straight to the node:

1. `POST /api/databases/:id/imports` with `{ table_id, format?: "csv" | "jsonl" }` →
   `201 { import_id, upload_url, upload_path, max_bytes, expires_at, review, import_page_url }`.
   `review` is how the commit will land: `review`, `auto`, or `direct` for a person.
   `import_page_url` opens the table's Import dialog in the web app, for handing the job to a person
   when the caller cannot deliver the file.
2. `PUT` the raw bytes to `upload_url` (or `upload_path` on the origin the caller uses). The signed
   URL is the whole credential: single use, valid for an hour.
3. `POST .../imports/:import/commit` with
   `{ column_map?, on_error?: "abort" | "skip_bad_rows", max_bad_rows?, date_order?: "mdy" | "dmy", dry_run? }`.
   Every row is validated, then the file lands as one `rows.insert`: proposed for an agent, applied
   for a person. `dry_run: true` returns `rows_ready`, `rows_failed`, `errors`, `matched_columns`,
   `notes` and `guessed_date_order` and writes nothing. A `422` carries `rows_total`, `rows_failed`,
   `errors: [{ row, column, value, code, message, hint? }]` and `errors_truncated`, writes nothing,
   and keeps the staging for a corrected commit. A repeated commit answers `already_applied: true`.

## The workspace

| Route | |
|---|---|
| `GET /api/instructions` | `{ workspace_id, name, instructions }`: the workspace's own instructions for agents, the workspace level alone. Read it before writing. |
| `GET /api/events?after=&types=&limit=` | The event feed since a cursor ([below](#the-event-feed)). |
| `GET /api/users?ids=user:a,user:b` | Display names, usernames and emails for principals, at most 200 per call. |

### The event feed

```
GET /api/events?after=41&types=run.decided,comment.added&limit=100
{ "events": [ { "id": 42, "at": "…", "type": "run.decided", "doc_id": "…", "actor": "user:…", "actor_kind": "human", "payload": {…} } ],
  "cursor": 42, "latest": 42, "types": [ … ] }
```

Oldest first after the cursor, 100 by default and at most 500. An event about a document is shown only
when the credential can read that document, and a folder-scoped key sees only events in its folders.
`cursor` is where the page ended. `latest` is the newest event in the workspace, where a subscriber
with nothing to catch up on starts. Events are kept for 30 days.

| Type | When |
|---|---|
| `doc.created` | A document or database was created. |
| `doc.updated` | A document's content was saved. |
| `doc.trashed` | A document was moved to the trash. |
| `run.proposed` | An agent parked changes for review. |
| `run.applied` | An agent's changes landed without review, on an `auto` document. |
| `run.decided` | A person accepted or rejected some or all of a run. |
| `run.reverted` | A person reverted a run that had landed. |
| `comment.added` | A comment was posted. |
| `database.changed` | A database's rows or schema changed. |

### Webhooks

A workspace owner or admin can send the feed to a URL, on **Settings → This workspace → Agents** or
through these routes, which refuse agents:

| Route | |
|---|---|
| `GET /api/webhooks` | The workspace's webhooks, without their secrets. |
| `POST /api/webhooks` | `{ url, events?, folder_id? }` → `201 { webhook, secret }`. No `events` means every type. A `folder_id` limits the hook to events on documents in that folder's subtree. The secret is returned only here. |
| `PATCH /api/webhooks/:id` | `{ url?, events?, folder_id?, active? }`. |
| `DELETE /api/webhooks/:id` | Remove. |

Each delivery is:

```
POST <url>
content-type: application/json
x-stuga-event: run.decided
x-stuga-delivery: <event id>:<webhook id>
x-stuga-signature: sha256=<hex HMAC-SHA256 of the raw body, keyed by the webhook's secret>

{ "id": "42", "at": "…", "workspace_id": "…", "type": "run.decided", "doc_id": "…", "actor": "…", "actor_kind": "…", "payload": {…} }
```

Verify the signature over the exact bytes you received before trusting the body. The URL must be
public http(s), and it is checked again at every delivery; redirects are not followed. A delivery
times out after 10 seconds. A `5xx` or a network failure is retried with backoff, and a `3xx` or `4xx`
is not. After 20 failed deliveries in a row the hook is paused until someone resumes it.

## For people only

These refuse an agent key.

| Route | |
|---|---|
| `GET /api/runs?filter=attention\|open\|closed\|all&agent=&limit=` | The review inbox: runs on documents the caller can read. `attention` (the default) is runs with pending changes plus runs applied at once that nobody has looked at. `open` is runs still collecting changes (something waiting, or active in the last 10 minutes); `closed` is the rest. Page with `before_at` and `before_id` from the last run. |
| `GET /api/agents/stats` | Per agent: runs, pending, accepted, rejected, applied, reverted runs, and `acceptance_rate`. |
| `POST /api/docs/:id/runs/:run/decision` | `{ decision: "accept" \| "reject", hunk_ids? }`. Every pending hunk when `hunk_ids` is absent. The run's reviewer, the document's owner or a workspace admin decides. |
| `POST /api/docs/:id/runs/:run/revert` | Undo a run that landed. |
| `POST /api/docs/:id/runs/:run/ack` | Dismiss a run's card. |
| `POST /api/databases/:id/runs/:run/decision`, `/revert`, `/ack` | The same for a database's runs, with `op_ids` in place of `hunk_ids`. |
| `PATCH /api/docs/:id/state` | `{ locked?, search_hidden?, agent_mode?, agent_instructions? }`. The owner or a workspace admin. `agent_mode` is `review` or `auto`. `agent_instructions` is text of at most 20,000 characters, stored as given. Every field is checked before anything is written. Answers the document's summary, without the instructions. |
| `PATCH /api/workspaces/:id` | `{ name?, default_doc_access?, agent_instructions? }`. A workspace owner or admin. `agent_instructions` is checked as on a document's state. |
| `GET /api/me/nodes` | The workspace switcher's other nodes: `{ current: { name, origin }, nodes: [{ id, label, origin }] }`, the caller's bookmarks in the order they were added. It works before the caller has a workspace. |
| `POST /api/me/nodes` | `{ url, label? }` → `201` `{ node }`. `url` is an absolute http or https URL, of which only the origin is kept; an empty `label` becomes its host, and a label is at most 80 characters, with at least one visible character and no control characters, line breaks or invisible direction marks. Refusals carry a code: `400` `invalid_url`, `invalid_label`, or `own_node` for this node's own origins; `409` `already_added`, or `limit_reached` past 50. Nothing checks that the address is a Stuga node. |
| `DELETE /api/me/nodes/:id` | `204`. Someone else's bookmark is `404`. |

### The audit ledger

Workspace owners and admins read the ledger; everyone else, agents included, is refused.

| Route | |
|---|---|
| `GET /api/audit` | Newest first, 100 rows by default and at most 500. Filters: `principal` (the accountable person, including rows their agents wrote), `actor` (the exact alias that wrote the row), `action`, `target_kind`, `target_id`, `status` (`ok` or `denied`), `since`, `until`. Timestamps are ISO 8601 and anything else is `400`. Each row's `at` is when the action happened. Answers `{ events, next_before }`. |
| `GET /api/audit?…&before_at=&before_id=` | The next page, from the previous reply's `next_before`. Both or neither. `next_before` is null after a short page. |
| `GET /api/audit/facets?since=&until=` | The values in a window on four axes, `principals`, `agents`, `actions` and `statuses`, each with a count and last-seen time, and `truncated` when an axis was cut short. |
| `GET /api/audit/export?format=csv\|ndjson&…` | The ledger for the same filters, streamed. CSV has a byte-order mark and CRLF line endings. |

## Other routes

The web app also uses these. They follow the same authentication, and most refuse agents or narrow
what they may do.

| Routes | |
|---|---|
| `PATCH` / `DELETE /api/docs/:id` | Rename, move, trash or restore; delete for good. People only. Deleting takes the owner or a workspace admin. |
| `GET` / `PUT /api/docs/:id/acl`, `/api/folders/:id/acl` | Sharing. `GET` answers the effective `acl_*` arrays, the direct `own_grants`, `inherits`, the `owner`, and `parent` (`{ folder_id, title }`, the title null when the caller cannot read that folder; null at the top level). Changing it takes the owner or a workspace admin. |
| `/api/docs/:id/versions`, `/versions/:seq`, `/restore`, `/recover` | Version history. Restoring, deleting a version and recovering take the owner or a workspace admin. A restore first keeps the document it replaces as a version, so it can be undone. The listing answers `versions`, `head_seq` (the document's newest processed snapshot, ahead of every version when the latest edits recorded none; no version at or past it can be deleted) and `can_manage` (whether the caller may restore and delete; false while the document is locked). |
| `/api/docs/:id/share-links`, `POST /api/share-links/redeem` | Share links. |
| `PATCH` / `DELETE /api/docs/:id/comments/:n` | Resolve or delete a comment. |
| `POST /api/docs/:id/request-access` | Ask a document's owner for access. |
| `POST /api/folders` | Create: `{ title, parent_id?, agent_instructions? }`. The instructions are the folder's own, set in the same call, checked as on a `PATCH`. |
| `GET /api/folders/instructions?parent_id=` | `{ inherited }`: the stack a folder made there would read, the parent's own level included, or the workspace's alone at the top level. |
| `GET /api/folders/:id/ancestors`, `/contents`; `PATCH` / `DELETE /api/folders/:id` | Folder navigation and management. `PATCH` takes `{ title?, parent_id?, agent_instructions? }` from the owner or a workspace admin, with `agent_instructions` checked as on a document's state. Folder answers are summaries: `folder_id`, `parent_id`, `title`, `owner`, `created_at`, `updated_at`. |
| `GET /api/databases/:id/ops`, `POST /api/databases/:id/ops/:op/revert` | A database's activity, and reverting one change. |
| `PATCH` / `DELETE /api/databases/:id/tables/:t`, `/columns/:c`; `DELETE .../views/:v` | Schema changes and view deletion, for people. A column `PATCH` carries exactly one of `type`, `display` or `description`; a description is at most 500 characters, stored trimmed, and empty clears it. |
| `POST /api/databases/:id/ai` | The table assistant. |
| `POST /api/ask`, `/api/ask/threads…` | Ask ([rag-cross-doc-qa.md](rag-cross-doc-qa.md)). |
| `GET` / `POST /api/workspaces`, `DELETE /api/workspaces/:id`, `/api/workspaces/:id/members…`, `/invites…`, `POST /api/invites/redeem` | Workspaces, membership and invites. |
| `PUT /api/groups/:id` | `{ members }`: replace a group's members. Workspace owners and admins. |
| `GET` / `PUT /api/favorites`, `DELETE /api/favorites/:id` | Favorites. |
| `GET /api/notifications`, `/unread`; `POST /api/notifications/read` | In-app notifications, across every workspace the caller belongs to. A row about the node itself, such as `SECURITY_UPDATE_AVAILABLE`, has a null `workspace_id` and `workspace_name`; only a node administrator gets those, and never through an agent's key. |
| `GET /api/users/search?q=` | The member directory, matched on username, full name or email. |
| `PATCH /api/whoami` | `{ display_name?, email? }`: change your display name, or set or clear your email (`""` or `null`). |
| `GET /api/usage` | AI usage. Workspace owners and admins. |
| `GET /api/ws/ticket?doc=` | A socket ticket for `/ws/:docId`. |
| `GET` / `DELETE /api/media/ticket`, `GET /api/docs/:id/media/:hash` | The media cookie and image reads. |
| `GET /api/models` | The chat models people may pick; none while AI chat is off. No credential. |
| `/api/node/…` | Node administration: admins, password resets, settings including the node's name and the [identity provider](#through-the-identity-provider), AI settings, the node's audit rows, version. Node administrators. `PUT /api/node/settings` takes `node_name`, at most 80 characters with at least one visible character and no control characters, line breaks or invisible direction marks, where `""` or `null` removes it; `GET` answers `node_name`, null while the node is unnamed, `node_label`, which is the name or else the host of `PUBLIC_ORIGIN` without its port or a trailing `.local`, and the node's `node_id` among its read-only facts. `updates: { check }` on the same `PUT`, a boolean, turns the daily look for a newer version off or on, and `GET` answers it. `backups: { auto, hour }` turns the daily backup off or on and sets its hour (0–23), and `time_zone`, an IANA name or null for UTC, is the zone that hour is in; `GET` answers both. `DELETE /api/node/settings` returns the name, **Storage**, **Notifications**, **Branding**, the look for a newer version (on), the daily backup (on, at 3 in UTC) and the identity provider to their defaults. `GET /api/node/backups` answers the schedule (`auto`, `hour`, `time_zone`, `next_at`), whether a backup is `running`, the last try (`attempted_at`, `error`), the backup directory (`dir`) and `keep`, and `backups`, newest first, each `{ name, created_at, bytes, stuga_version, before_upgrade }`. `POST /api/node/backups` starts one now and answers `202`; the node pauses for it, answering `503` meanwhile, and `409` when one is already under way. `GET /api/node/version` answers `version`, `build` (`release` or `source`), `released_at` (`YYYY-MM-DD` or null), `source_url` (the code the build was made from: a release's tag, or the repository for a build from source), `schema_version`, `previous_version`, the boot times, and `update`: `comparable` (false for a build that is not a plain `1.2.3`, which never looks), `checked_at`, `error` (why the last look failed, or null), `available` (`{ version, released_at, security, notes_url }` or null, where `security` says a release after the running one fixes a vulnerability), `releases_url`, `upgrade_hint`, and `install`: `available` (true where the packaging installs a release from here, the Mac package) and `status` (the helper's last `{ version, state, message, at }`, or null). `POST /api/node/version/check` looks now and answers the same; it does not look again within a minute, with the look turned off, or from a build that is not comparable. `POST /api/node/version/install` `{ version }` asks the packaging to install the newest version the node knows of, which `version` must name, and answers the same with `202`; `409` where the packaging installs nothing from here, when the node knows of no newer version, or for any other version. |
| `GET /ready` | `{ ok: true }` while the node serves and the database answers, else `503`, with a `status` (`starting`, `backing_up`, `upgrading`, `maintenance`) while the node is not serving. No credential. |

## Agents over OAuth

`/mcp` is the MCP endpoint ([agents.md](agents.md)), a stateless Streamable HTTP server: `POST` and
`DELETE`, and `405` for `GET`. It takes an OAuth access token, an API key or a person's session
token, with a budget of 600 requests a minute per credential. Without a valid one it answers `401`
with where to start:

```
WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"
```

The node is the authorization server. `<origin>` is the one the client called when it is
`PUBLIC_ORIGIN` or in `EXTRA_ORIGINS`, and `PUBLIC_ORIGIN` otherwise; the metadata, the endpoints it
names and the consent page all use that origin ([network-access.md](network-access.md#agents-signing-in)).

| Route | |
|---|---|
| `GET /.well-known/oauth-protected-resource/mcp` | RFC 9728: `resource` (`<origin>/mcp`) and `authorization_servers`. Also answered without the `/mcp` suffix. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414: the endpoints below, the grant types `authorization_code` and `refresh_token`, PKCE `S256`, public clients only (`none`), the scope `mcp`, and `client_id_metadata_document_supported`, true only on an https origin that is not a loopback, private or local-network address. |
| `POST /oauth/register` | RFC 7591: `{ redirect_uris, client_name? }` → `201` with a `client_id`. At most 20 redirect URIs, each https or http to a loopback address. Limited per client address (`429` with `retry-after`). A registration unused for 90 days is removed. |
| `GET /oauth/authorize` | `client_id`, `redirect_uri`, `state`, `code_challenge` (`S256`) and an optional `resource` → `302` to the consent page. |
| `GET /oauth/client?client_id=` | `{ client_id, client_name, verified_host }`: what the consent page shows of a client, from the node's own records. `verified_host` is null for a client that registered itself. |
| `POST /oauth/consent` | The consent page's answer, with the person's session token; an agent's credential is refused. `{ decision: "allow" \| "deny", client_id, redirect_uri, state, code_challenge, workspaces, access }` → `{ redirect }`, back to the client with a code or `error=access_denied`. `workspaces` is a list of workspace ids the person belongs to other than as a guest, or `"all"` for every workspace they belong to, now and later. `access` is `read` or `propose`. `409` when the person has no workspace to connect, `403` when one named is not theirs to connect. A code lasts five minutes and is used once. |
| `POST /oauth/token` | Form-encoded or JSON. `grant_type=authorization_code` with `code`, `code_verifier`, `redirect_uri` and `client_id`, or `grant_type=refresh_token` with `refresh_token` and `client_id`; either may add `resource`. → `{ access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope: "mcp" }`. Errors are `{ error }` with `400`: `invalid_request`, `invalid_grant`, `invalid_target`, `unsupported_grant_type`. |
| `POST /oauth/revoke` | RFC 7009: `token`, of either kind → `200`, even for a token the node does not know. Ends every token of the sign-in it belongs to. The connection stays until it is revoked. |

- **Clients.** A client registers itself, or uses as its `client_id` the https URL of its client
  metadata document. The node fetches that document through its outbound URL checks (never a
  private address, no redirects, five seconds, 64 KB), requires its `client_id` to repeat the URL,
  fetches it again after a day, and limits the fetches per client address. A registered redirect
  URI on a loopback address matches on any port (RFC 8252).
- **Resource.** A `resource` (RFC 8707) must be the node's `/mcp` on `PUBLIC_ORIGIN` or an
  `EXTRA_ORIGINS` origin; any other is refused. A token is the node's, and works at each of them.
- **Tokens.** The access token (`sto_…`) lasts an hour. The refresh token (`str_…`) is replaced at
  every use and lapses after 90 days unused. A spent refresh token presented again ends every token of
  its sign-in. Only hashes are stored. A refresh token sent as a bearer is refused.
- **Grants.** A consent creates the person's connection to that client, or renews it with the new
  workspaces and access, keeping its id, name and agent. The connection acts as its own agent for
  the person, like a key, in the workspaces it names where the person is a member at the time of the
  call. When a person leaves a workspace or is removed from it, their connections that named it stop
  naming it, and one left naming none is revoked.

### Connections

The apps a person signed in, for that person only: these routes refuse agents, and work before the
person has a workspace.

| Route | |
|---|---|
| `GET /api/me/connections` | `{ connections: [{ grant_id, agent_id, name, client_id, verified_host, workspaces, access, created_at, last_used_at, revoked_at }] }`, newest first, revoked ones included. `workspaces` is null for every workspace, now and later. |
| `PATCH /api/me/connections/:id` | `{ name?, access? }`: rename, or narrow to `access: "read"`. Widening is a new sign-in. |
| `DELETE /api/me/connections/:id` | Revoke: every token of the connection stops at once. `404` for one that is not the caller's or already revoked. |

## Sign-in

The web app signs people in through `/auth/*`, beside `/api`. Where one of these routes takes a
credential, it is a person's session token, and an agent key gets `403` `agent_forbidden`. Refusals
are `{ "error": "<code>", "message": "<sentence>" }`. Sign-in attempts share one limit per address and
per username. A token pair is `{ access_token, refresh_token, expires_in, token_type: "Bearer" }`.

| Route | |
|---|---|
| `GET /auth/config` | No credential. `{ provider, unclaimed, node_name, node_label, origin, branding }`: `provider` is `{ label }` when the node has an identity provider, else null, `unclaimed` is true until the first account exists, `node_name` is the name an administrator gave the node, null until there is one, `node_label` is what tells the node apart (the name, else its host), `origin` is `PUBLIC_ORIGIN`, and `branding` is `{ accent_color }`. |
| `POST /auth/register` | `{ username, password, name?, invite?, setup_code?, update_check?, time_zone? }` → `201` with a token pair. The first account needs the node's `setup_code` (`403` `setup_code_required`, `setup_code_invalid`); case, spaces and dashes in it do not matter. Every account after the first needs an invite, and a `setup_code` it carries is ignored. A reserved or taken username is `409` (`username_reserved`, `username_taken`) with a free `suggestion`. `update_check: false` from the account that claims the node turns the look for a newer version off before the node has made one; from any later account it changes nothing. `time_zone`, an IANA name, becomes the node's from the account that claims it; a name the node does not know is ignored. |
| `POST /auth/login` | `{ username, password }` → a token pair. |
| `POST /auth/refresh`, `/auth/logout` | `{ refresh_token }`: renew the session, which rotates the refresh token, or end it. Ending it also cancels any link to the identity provider the account started and has not finished. |
| `POST /auth/password` | Change: `{ username, current_password, new_password }` → a new token pair, and every other session ends. Set a first password: a session token and `{ new_password }` → `204`, or `409` `password_set` when the account has one. |
| `POST /auth/reset` | `{ token, new_password }`: redeem a reset link → a token pair. |

### Through the identity provider

The node runs the authorization code flow itself. `start` sets an HttpOnly cookie that ties the
sign-in to the browser, `__Host-stuga_signin` on https and `stuga_signin` on plain http. Every later
step needs it, the callback renews it for as long as the code or ticket it hands out lasts, and a
step that signs someone in clears it. A handoff code lasts 60 seconds and a ticket 10 minutes, and
each is used once.

| Route | |
|---|---|
| `POST /auth/oidc/start` | `{ prompt?: "none" \| "select_account", return_to? }` → `{ url }`, the provider's page to open. `none` signs in only when the provider needs nothing from the person, and `select_account` has the provider ask which account to use. With a session token it links the provider to that account instead (`409` `already_linked`) and refuses `none` (`400`). `404` `no_provider`, `502` `provider_unreachable`. A `return_to` that is not a path on the node becomes `/`. |
| `GET /auth/oidc/callback` | Where the provider returns; always a redirect. A known account goes to `/auth/complete#code=…`, a first visit to `/auth/first-visit#ticket=…`, a link back to `return_to` with `provider=linked`, `taken` or `failed` in the query, and any other failure to `/login?provider=failed`. |
| `POST /auth/oidc/handoff` | `{ code }` → a token pair and `return_to`. `403` `handoff_invalid`. |
| `POST /auth/oidc/ticket` | `{ ticket }` → `{ label, preferred_username, name, email, suggestion, return_to }`. It does not use the ticket up. `403` `ticket_invalid`. |
| `POST /auth/oidc/complete` | `{ ticket, username, invite, name? }` → `201` with a token pair and `return_to`: a new account that signs in through the provider and has no password. `invite` is required (`403` `invite_required`, `invite_invalid`), the node must be claimed (`403` `setup_required`), and a username is refused as `register` does. |
| `POST /auth/oidc/link` | `{ ticket, username, password }` → a token pair and `return_to`: the provider now signs in the existing account that username and password prove. `401` `invalid_credentials`, `409` `already_linked`. |
| `POST /auth/oidc/unlink` | A session token → `204`. `409` `password_required` while the account has no password. |

Node administrators set the provider with `identity_provider` on `PUT /api/node/settings`:
`{ issuer, client_id, client_secret?, label?, scopes? }`, or `null` to remove it. An absent
`client_secret` keeps the stored one and `""` deletes it. Saving checks the issuer's discovery
document, never the client ID or secret. Saving a different `issuer` or `null`, and
`DELETE /api/node/settings`, unlink every account in the same transaction as the change, and end no
session. A sign-in the previous provider vouched for links nothing afterwards, even one under way
during the change: a link comes back `provider=failed`, and a ticket answers `403` `ticket_invalid`.
`GET /api/node/settings` answers the stored values and their defaults, whether a secret is
set (never the secret itself), the `callback_urls` to register at the provider, and
`accounts_without_password`, the linked accounts with no password, which need one to sign in again
once the provider is removed or its issuer changes.

## Errors

A route refuses with JSON, `{ "error": "<one sentence>" }`, and a status that fits: `400` malformed,
`401` missing, bad or expired credential, `403` not allowed, `404` not found or out of reach (the two
look the same on purpose), `405` wrong method, `409` conflict, `413` too large, `422` an import that
failed validation, `423` locked, `429` over budget, `502` or `503` a part of the node that could not
answer.

These answers are plain text instead:

- `413 request body too large`, from the listener before any route runs, for a body over the node's
  request size limit. That limit is a little larger than **Maximum upload size** in
  **Settings → This node → Storage**.
- `500 internal error`, from the listener, for a failure no route caught.
- Every refusal of a `/ws/:docId` upgrade, such as `401 unauthorized` or `403 origin not allowed`,
  except `429`, which is the JSON refusal above with `retry-after`.
