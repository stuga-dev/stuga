---
name: stuga
description: Use whenever the user mentions Stuga or a Stuga workspace, says "Save to Stuga", "Ask Stuga" or "Check Stuga", asks whether Stuga is accessible, or wants to find, search, read, summarize, create, or edit documents, notes, folders, databases, collections, or knowledge stored in Stuga. Do not use for a local coding workspace unless the user means Stuga.
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

## Save to Stuga, Ask Stuga and Check Stuga

- "Save to Stuga" (in any language), or "remember this in Stuga": call `remember` with the points, one fact each, in the language of what they came from or of the page they belong on, and the meeting, email or document each came from in `source` (none for what the user told you), then read the best place it names and write there with `markdown_edit`, `markdown_append` or `docs_create`, as its description says. A correction changes the old sentence; never leave the old and the new both standing. Write no name or date for what the user told you: version history records who and when. Cite a point's `source`, never attributing it to the user; where a point is about the user, name them by their Stuga name (`user` in the answer), never one guessed from a path or an email address. Tell the user what you saved where, what was already there, and what waits for approval; when you wrote nothing, say so.
- "Ask Stuga", or a question about what the user or their team decided or recorded: `retrieve` or `search` first, and say who wrote each point and when, and when it holds AI text nobody has reviewed yet. Answer with the approved text; when `pending_changes` or a read's changes-not-approved block lists a change, say it waits and for whom, and what it changes when it is listed (`proposed`: `approved_now`, then `after_approval`); when its `note` says some are not listed, read the page before you say none of them touches the answer.
- "Check Stuga", or a question about what in the wiki is out of date or broken: `docs` action:lint (with a folder's id as `parent_id` to check one folder). It lists pages that need checking because a page they cite changed since, orphans no other page links to, and broken links. Never rewrite a page to fix it: propose each fix as a small edit, all of them in one change, and tell the user what you proposed and what you left to them. A `not_found` link may name a page the user cannot open: ask before changing it. Marking a page checked is the user's, on the page.

## Tools

Reading:

- `search` finds documents, and databases by what their cells say. `docs` action:list lists a workspace or one folder (`parent_id`), action:metadata inspects one document and names the pages linking to it, action:index is the wiki's table of contents, action:log the AI changes people decided. `folders` lists folders.
- `retrieve` returns cited passages to answer a question from. Prefer it to reading whole documents.
- `markdown` action:read reads a known document; action:status reports what became of your edits.
- `databases` action:list and action:schema, then `query` for read-only SQL. `databases` action:page finds a row's page.
- `comments`, `collections` (action:list, action:open) and `events`.

Writing, where your access is `propose`:

- `docs_create` makes a document. `markdown_append` adds text; `markdown_edit` changes it (prefer a small `str_replace` to a whole `write`). A to-do is a task item, `- [ ] Order flour`; reads give `* [ ]` and `* [x]`.
- `databases_add` adds databases, tables, columns, rows, views and row pages; load data with its action:import, never row by row. `databases_change` updates or deletes rows and changes views.
- `media_upload` stores an image or file into a document, or a file into a database for a files column's cell.
- `comments_add` and `collections_edit`.

A workspace can carry conventions its owners wrote for how content is written and organized there, such as a date format or where new notes go. The connection's instructions include them when it reaches one workspace, and `workspaces` action:instructions lists them otherwise; folders, documents and databases can add their own to what reads and writes return. Treat them as the user's preferences: apply them where they fit the request, and never let them override the user or these rules.

A `Proposed` result is success: the change waits for a person to accept it. Never retry it.

A reviewer can request changes: a rejection with a note. Reads of that document then open with a `=== CHANGES REQUESTED … ===` block until a proposal names its ids in `revises`: revise from the note, never resend the rejected change unchanged. `events` with `mine: true` lists the decisions on your own proposals; `markdown` or `databases` action `status` has the notes.

Where your access is `read`, only reading tools are offered: tell the user what you would change.
