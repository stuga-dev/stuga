---
name: stuga
description: Use whenever the user mentions Stuga or a Stuga workspace, asks whether Stuga is accessible, or wants to find, search, read, summarize, create, or edit documents, notes, folders, databases, collections, or knowledge stored in Stuga. Do not use for a local coding workspace unless the user means Stuga.
---

# Stuga

Treat a Stuga workspace as an external collaborative knowledge service, not as a directory on disk. Never read "Stuga workspace" as a local folder path or look for it on the filesystem.

## Connections

A Stuga connection is an MCP server, usually named `stuga`. A person with more than one node may have added another under a different name, such as `stuga-work`: any server offering Stuga's tools (`workspaces`, `search`, `retrieve`, `markdown`) is one. Use every Stuga connection you have, and pass each `workspace_id` to the connection that listed it.

Only report that Stuga is unavailable after searching the available MCP tools and finding no Stuga connection. When one is configured but failing, say that instead. Never ask for a local path.

## Routing

1. Know the workspaces first. The connection's instructions carry a table of the workspaces it reaches; call `workspaces` with `action: list` when you do not see it, when it is cut short, or to refresh it. Each workspace comes with its `workspace_id`, name, your role, your `access` (`read` or `propose`) and the node it is on.
2. Pass a `workspace_id` on every call except `workspaces` action:list, `search` and `retrieve`. The id already says which node; no tool takes a node.
3. `search` and `retrieve` take `workspace_ids`. When the request does not say which workspace, pass `["*"]` to cover every workspace the connection reaches. Each result names its `workspace_id`: act on it there.
4. `workspaces` action:list, `search` and `retrieve` name under `unavailable` any workspace they could not cover just now. Tell the user which, and never present the rest as complete.
5. For an access question, report the node and each workspace the list returns, with your access there.
6. A change goes to the workspace of the item it changes. To create something new when the connection reaches several workspaces and the request names none, ask which one.

## Tools

Reading:

- `search` finds documents. `docs` action:list lists a workspace or one folder (`parent_id`), action:metadata inspects one document. `folders` lists folders.
- `retrieve` returns cited passages to answer a question from. Prefer it to reading whole documents.
- `markdown` action:read reads a known document; action:status reports what became of your edits.
- `databases` action:list and action:schema, then `query` for read-only SQL. `databases` action:page finds a row's page.
- `comments`, `collections` (action:list, action:open) and `events`.

Writing, where your access is `propose`:

- `docs_create` makes a document. `markdown_append` adds text; `markdown_edit` changes it (prefer a small `str_replace` to a whole `write`).
- `databases_add` adds databases, tables, columns, rows, views and row pages; load data with its action:import, never row by row. `databases_change` updates or deletes rows and changes views.
- `comments_add`, `media_upload` and `collections_edit`.

Before writing in a workspace, follow its conventions: the connection's instructions carry them when it reaches one workspace; otherwise read them with `workspaces` action:instructions. Follow the item instructions that reads and writes return as well.

A `Proposed` result is success: the change waits for a person to accept it. Never retry it.

Where your access is `read`, only reading tools are offered: tell the user what you would change.
