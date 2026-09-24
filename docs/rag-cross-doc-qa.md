# Cross-document question answering

How Stuga answers a question from many documents at once: how documents are cut into citable
passages, how passages are found, and how Ask reads and cites them.

One rule holds throughout: **an answer is grounded in retrieved passages the asker is allowed to
read, or it is "I couldn't find an answer to that in your documents."**

## Two ways to ask

Both share every piece except the top.

- **One retrieval**: `POST /api/retrieve` embeds the question, retrieves once, and returns ranked
  passages with their sources. The MCP `retrieve` tool and the `search_collection` tool of the
  co-author and the table assistant run the same retrieval.
- **The Ask loop**: `POST /api/ask` and the `/ask` page. The model writes its own searches, reads the
  documents they turn up, searches again, and answers with footnotes. A single retrieval cannot
  follow a lead ("the target was revised in the Q3 retro"); the loop can go and read the Q3 retro.
  For the same reason the loop needs no query-rewriting step: the model writes each search with the
  whole conversation in view, so "what about last year?" becomes a concrete query.

## Chunking

Documents are embedded as sections, not as one vector over a truncated whole and not as blind
fixed-size windows. `headingAwareChunk` (`packages/ai/src/retrieval/chunk.ts`) splits the Markdown on
its headings:

- each heading and the text beneath it, up to the next heading, is one chunk, and text before the
  first heading is a preamble chunk;
- every chunk records its **heading path** ("Overview > Geophysics > Internal heat"), built from the
  headings above it, which is what a citation shows;
- headings inside fenced code are ignored;
- a section longer than 12,000 characters (about 3,000 tokens) is split further on the most natural
  boundary under that size (paragraph, line, sentence, clause, word, character), with no overlap,
  and every piece keeps the section's heading path;
- small sections are never merged, because merging would put distinct headings under one shallower
  path and blur which section a citation points to;
- text with no headings at all is packed into chunks of up to 6,000 characters on the same
  boundaries, with no overlap and an empty heading path.

## What is embedded

`chunkEmbedInput` defines the exact text sent to the embedding model: the chunk's heading path before
its content, and for the first chunk the document title as well. The stored passage stays clean, since
the prefix is a topical signal for the vector, not text a reader sees. Indexing, the repair sweep and
the per-chunk hash all use this one function, so a repaired vector equals one written at indexing and
the hash covers exactly the bytes that were embedded.

## Indexing

Every snapshot flush queues an `index_doc` job. The job:

1. extracts the document as Markdown and skips the rest when the title and text are unchanged;
2. chunks it and computes each chunk's embedding input and hash;
3. reuses the stored vector of every chunk whose hash is unchanged and embeds the rest, at most 200
   per job;
4. replaces the document's `doc_chunks` rows: `chunk_index`, `content`, `heading_path`, the title on
   chunk 0, the vector and its hash.

A chunk left without a vector (embeddings off, a failed call, or past the per-job limit) keeps its
row, so keyword search still finds it. The maintenance tick embeds such chunks a few at a time and
gives up on a chunk after five failed attempts. Changing the embedding model on the **AI providers**
settings page clears every vector and re-embeds each workspace. A document hidden from search has no
chunks.

## Retrieval

`askDocs` (`packages/db/src/search.ts`) is document search without the collapse to one row per
document: it returns individual passages, so the caller can hand sections to a model and cite them.
It is one SQL statement:

- a **semantic leg**: the chunks nearest the question by cosine distance, closer than the node's
  **Retrieval cutoff** ([configuration.md](configuration.md#match-cutoffs)), read from the AI settings
  in force when the question is asked;
- a **keyword leg**: BM25 through pg_search over each chunk's heading path and text, plus the title on
  chunk 0, matching a passage on any word of the question, by English stem, with stopwords ignored;
- **Reciprocal Rank Fusion** of the two per-passage ranks into one `score`;
- the **permission check inside each leg**: a chunk survives only if its document is in the caller's
  workspace, not trashed, not hidden from search, and its `acl_principals` overlap the caller's live
  principals;
- an optional **scope**: document ids from a collection ([collections.md](collections.md)) and a
  folder-scoped key's folders, applied beside the permission check, never in place of it. A passage
  outside the scope is never returned, and an empty collection scope returns nothing.

Because the check is in the query, an ACL change applies to the next question, and a passage from a
document the asker cannot open never reaches the model.

## Reranking and the per-document cap

`retrieveAndRerank` (`services/node/src/retrieval/retrieve.ts`) is the pipeline every surface uses:
embed the question, fetch 24 candidates with `askDocs`, have the chat model score each candidate's
relevance from 0 to 10 in one call, and keep the best. Two guards live here so no surface can
skip them:

- **At most three passages per document come first.** Sections of one document cluster in embedding
  space, so an uncapped top eight is often eight sections of one document, which reads one source's
  account of itself as consensus. Further passages from the same document fill in only when there are
  not enough from others.
- **Degradation is reported.** If the question cannot be embedded, retrieval runs keyword-only and
  `degraded` is set, which Ask turns into a notice under the answer ("Search by meaning was
  unavailable…"). If the rerank call fails, passages keep their fusion order.

Tokens spent on the embedding and the rerank are recorded against the asker.

## The Ask loop

`runAskAgentTurn` (`packages/ai/src/agents/ask.ts`) is the read-only sibling of the co-author and the
table assistant: the same provider code and loop, with tools that can only look.

| Tool | What it does |
|---|---|
| `search_documents` | Retrieval as above for a query the model writes. Returns numbered, citable passages. |
| `read_document` | A window of one document's Markdown, up to 12,000 characters, read with the asker's permissions. |
| `list_documents` | Up to 50 documents and the folders at that level, optionally filtered by a title glob or confined to a folder's subtree. |
| `list_databases` | Up to 20 structured databases the asker can read, with their schemas: each table's physical SQL names and row count, each column's type, the values a single-select may hold, what each column means, and what each saved view selects. |
| `query_database` | One read-only `SELECT` against one database, through the same checks as `POST /api/databases/:id/query`. The model sees at most 200 rows. |

With a collection selected, every tool stays inside it: `search_documents` retrieves from its
documents, `list_documents` lists them and only the folders that lead to them, and `list_databases`
lists its databases. `read_document` on any other document answers the tool error "that document is
not in the selected collection", and `query_database` on any other database "that database is not in
the selected collection", so the model is told where the boundary is rather than finding a document
missing. The answer is grounded in the collection or it is the no-answer sentence.

Grounding is enforced three ways:

1. The system prompt forbids outside knowledge and requires a `[^n]` marker after every fact.
2. If the model answers before any search, read or query has returned material, the loop rejects that
   answer once and tells it to search. A second answer without material is accepted as the model's
   decision.
3. Citations the answer never references are dropped (`filterCited`), so the source list credits
   only what was used. The no-answer sentence is one constant, `DONT_KNOW`.

The loop stops on a final answer, after six rounds, when the asker stops it, or on a provider error,
and the reply says which. `POST /api/ask` answers `503` when AI chat is off on the node.

## Threads

`POST /api/ask/threads` creates a saved conversation. A question sent with `thread_id` is stored in
it and takes its history from it: the last three turns, each question and answer cut to 4,000
characters. A thread belongs to the credential that created it, in one workspace: a person's own,
or an agent key's own, which its person does not see. Asking only reads, so a read-only key may ask,
create, rename and delete its own threads, and its turns are kept. A request without a thread may
send `history` itself, the last six messages, cut the same way. A question is cut to 4,000
characters, so one request cannot run up input cost. Threads with no new question for the period set
on the **Storage** settings page are deleted.

## Surfaces

| Surface | Path | Notes |
|---|---|---|
| Ask page | `/ask`, `/ask/:threadId` | Streams the answer. The steps behind it (searches, documents read, database queries) sit collapsed under **How this answer was found**, and each database step shows the SQL it ran. The source list is the citations the answer kept. |
| REST | `POST /api/ask` | `{ question, collection_id?, thread_id?, model?, history? }`, answered as a stream of server-sent events. |
| REST | `POST /api/retrieve` | `{ q, collection_id?, limit? }` → passages with sources ([api.md](api.md#documents)). |
| MCP | `retrieve` | The same, for external agents. |
| Co-author, table assistant | `search_collection` | The panel's search, scoped to all documents or a collection. With a collection, the co-author's `list_documents`, opening another document and its proposals into other documents stay inside the collection too, and anything outside answers "that document is not in the selected collection". With **This document only**, there is no search and the co-author reaches no other document. |
| Co-author | `cited_edits` | Edits whose `[^n]` markers become footnotes to retrieved passages when the change lands. |

## Where it runs

The co-author runs inside the document actor, because its subject is one document. The Ask loop is
cross-document and needs Postgres for every tool, which an actor does not have, so it runs in the
node's request handler and streams over server-sent events, as the table assistant does.

`services/node/src/retrieval/ask-runner.ts` builds the tools the loop calls:

- **The node runs the tools, not the model and not an actor.** Each tool works on the request's own
  context: `search_documents` calls `retrieveAndRerank`, `read_document` reads through the same
  projection agents get, and `query_database` goes through the database actor's read-only SQL.
- **The boundary is the one `askDocs` already enforces.** Permissions are applied in SQL against the
  asker's own principals, so the model cannot widen its reach by choosing a different query, document
  id or collection. A collection only narrows, and so do a scoped key's folders.
- **A collection is strict.** The runner holds the collection's expanded document ids for the whole
  turn and checks every read, listing and query against them before touching the document.
- **Degradation carries through.** The runner remembers whether any search ran without its semantic
  leg, and the answer says so.

## Limits

- A question is answered from one node's documents.
- The per-document cap, the 24 candidates and the round limit are fixed in code, not configuration.
  The retrieval cutoff is a setting because it depends on the embedding model.
- Ask does not write. Turning an answer into an edit is the co-author's job, through the run ledger,
  with `cited_edits` carrying the sources along.
