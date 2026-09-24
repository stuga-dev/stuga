# Collections

A collection is a named set of documents and folders that search, retrieval, Ask and the AI panels
can be scoped to. It answers one question, "which documents may the AI draw on for this?", and
nothing else: a collection grants no access and changes no permission. It belongs to one person, and
the agents that act for that person use and manage the same collections.

## What a collection is

| Property | Value |
|---|---|
| Owner | One person, in one workspace. An agent key's collections are the collections of the person who minted it: a collection an agent creates belongs to that person, and the person sees and manages it like one they made. |
| Members | Documents and folders. A folder member means its whole subtree as it is when a query runs. |
| Access | The person and their agent keys. Every route answers anyone else with `404`, so a collection's existence is not revealed. The audit ledger names a collection by its id, never by its name. A collection has no sharing of its own. |
| Members a caller sees | Only those it can read. Opening a collection lists them, `item_count` counts them, an add skips the rest, and a remove leaves alone members the caller cannot see. For a key confined to folders, that means members inside its folders, and such a key may rename or delete only a collection whose every member it can see: any other answers `404`. |
| Effect | Narrows a request and never widens one. The scope is strict: every document a scoped request lists, reads, searches or proposes against is inside it ([below](#the-scope-is-strict)). |
| Guests | Cannot create collections, and neither can their keys. They can search without one. |
| Ids | `col_…`, issued by the node. |

## How a scope is applied

At query time, `expandCollectionScope` (`packages/db/src/collections.ts`) turns a collection into a
list of document ids:

1. the collection's document members;
2. every document under its folder members, walking each subtree to at most 32 levels, so a corrupt
   parent pointer cannot loop;
3. of those, only documents in the caller's workspace that are not in the trash and whose
   `acl_principals` overlap the caller's principals, the same check search applies, and for a key
   confined to folders, only documents directly in those folders.

Every tool of a scoped request checks against that list, and search and retrieval still apply their
own permission, trash and hidden-from-search filters. Because the expansion runs on every request
rather than being stored:

- A document moved into a member folder is in scope on the next request. One moved out, trashed or
  unshared drops out as soon as that change commits. Nothing is re-indexed or cached.
- Losing access to a document removes it from every collection that names it without touching the
  collection, and regaining access puts it back.

A collection whose members the caller can no longer read expands to nothing, and a request scoped to
it finds nothing rather than falling back to every document. Search and retrieve replies then carry
`empty_scope: true`.

## The scope is strict

Whenever a request names a collection, the documents it expands to are the whole of what that request
reaches. Nothing outside is listed, read, searched or proposed against, and reaching for a document
outside answers a tool error rather than widening the scope.

| Surface | Inside the collection | Outside it |
|---|---|---|
| **Search** (`POST /api/search`, MCP `docs` action `search`) | Results come only from the collection. | Not returned. |
| **Retrieve** (`POST /api/retrieve`, MCP `retrieve`) | Passages come only from the collection. | Not returned. |
| **Ask** (`POST /api/ask`, `/ask`) | `search_documents` searches the collection. `list_documents` lists its documents, and only the folders that lead to them. `list_databases` lists its databases. | `read_document` answers "that document is not in the selected collection", and `query_database` "that database is not in the selected collection". |
| **Co-author** (a collection picked in the panel's **Search scope**) | `search_collection` searches the collection. `list_documents` lists its documents the person can edit. | Opening another document, and so editing it, answers "that document is not in the selected collection". A proposal into such a document is refused with the same sentence. |
| **Table assistant** (a collection picked in the panel's **Search scope**) | `search_collection` searches the collection. | Not returned. |

The document or database a panel is open on stays in reach whatever scope is picked: the scope bounds
the other documents a turn draws on. **All documents in this workspace** bounds nothing beyond the
person's permissions. **This document only** (or **This database only**) reaches no other document:
it offers no search, the co-author is offered no `list_documents`, and opening or proposing into
another document answers "this turn reaches only the open document".

A `collection_id` the caller cannot use (another person's, another workspace's, or unknown) is `404`
on REST and "collection not found" on MCP. In a panel, the turn's cross-document tools answer "that
collection is not available".

## Where it is used

| Surface | How the scope is chosen |
|---|---|
| **Ask** (`/ask`, `POST /api/ask`) | The **Search scope** selector, sent as `collection_id`. A saved thread keeps its collection, so follow-up questions stay in scope unless a request names another. |
| **Search** (`POST /api/search`) | Optional `collection_id`. |
| **Retrieve** (`POST /api/retrieve`) | Optional `collection_id`. |
| **MCP** | The `collections` tool lists, opens, creates, renames and deletes the person's collections and adds and removes their members. `retrieve` and `docs` action `search` take `collection_id` ([agents.md](agents.md#the-tools)). |
| **Co-author and table assistant** | The panel's **Search scope**: **This document only** (or **This database only**), **All documents in this workspace**, or a collection. |

## Routes

These act only on the caller's person's collections, for a person and for their agent keys alike. A
read-only key may list and open collections, and every route that changes one answers it `403`.

| Route | Body and result |
|---|---|
| `GET /api/collections` | The person's collections in the current workspace, most recently changed first, each with `item_count`. At most 200. |
| `POST /api/collections` | `{ name? }` → `201` with the collection, owned by the person. Without a name it is called "New collection". Guests: `403`. |
| `GET /api/collections/:id` | `{ collection, items }`: the members the caller can read, each with `doc_id` or `folder_id`, `title` and `added_at`. |
| `PATCH /api/collections/:id` | `{ name }`: rename. A key confined to folders gets `404` for a collection with members outside them. |
| `DELETE /api/collections/:id` | Delete the collection. Its members are untouched. A key confined to folders gets `404` for a collection with members outside them. |
| `POST /api/collections/:id/items` | `{ doc_ids?, folder_ids? }` → `201 { added, skipped }`. `added` counts new members; `skipped` counts ids the caller cannot read or that do not exist, which are not added. |
| `DELETE /api/collections/:id/items` | `{ doc_ids?, folder_ids? }` → `{ removed }`, counting members the caller can read. |

Adding checks that the caller can read each member, but permissions are checked again on every query,
which is why the expansion above filters again.

Every change is in the workspace's audit ledger as `collection.create`, `collection.rename`,
`collection.delete`, `collection.items.add` or `collection.items.remove`, with the collection's id as
the target and no name, because workspace owners and admins read the ledger and a collection is
private to its person. A change an agent makes names the agent and the person it acted for.
Collections emit no workspace events.

## What a collection is not

- **Not a folder.** It does not move or contain documents. A document can be in any number of
  collections and stays where it is.
- **Not a permission.** Being in someone's collection says nothing about who can read a document, and
  adding a document to a collection does not let the AI read what its owner cannot.
- **Not shared between people.** A person's agents work with the person's collections; two people who
  want the same scope each make their own.

How retrieval and Ask use the scope: [rag-cross-doc-qa.md](rag-cross-doc-qa.md).
