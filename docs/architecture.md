# Architecture

Stuga is one Node.js process, the node, plus one Postgres database. The node serves the web app and
the API from the same origin, hosts one actor per open document and one per structured database,
runs the background job worker and a maintenance tick, signs people in, and writes the audit ledger.
Postgres holds metadata, permissions, search indexes, the audit ledger and the job queue. Document
snapshots, media, each actor's own SQLite file, keys and secrets live on disk under `DATA_DIR`.

```
┌─ node (one process) ────────────────────────────────────────────────────┐
│ front door   identity · REST · /mcp and OAuth · /ws sockets · SPA       │
│ actors       one per document: the live Yjs document, its run ledger    │
│              one per database: SQLite tables, their run ledger          │
│ jobs         indexing · notifications · events · webhooks · audit       │
│ maintenance  embedding repair · retention · trash purge · daily backup  │
└─────────────────────────────────────────────────────────────────────────┘
   Postgres 18, pgvector, pg_search           DATA_DIR
   metadata · ACLs · search · audit · jobs    snapshots · media · actor SQLite
                                              keys · secrets
```

How a platform runs the node (the `stuga-node` commands, the environment, the health check, the stop
timeout, what Postgres must provide) is defined once in
[packaging/contract.md](../packaging/contract.md). Docker and the Mac runtime are two implementations
of that contract, and the app itself has no platform branches.

## Packages

Where each directory lives is in [CONTRIBUTING.md](../CONTRIBUTING.md#repository-layout). What each
package may depend on:

| Package | Depends on | Boundary |
|---|---|---|
| `@stuga/protocol` | nothing | Wire formats, API and domain types, limits. Imported by subpath (`wire/`, `api/`, `domain/`, `databases/`, `text/`, `internal/`). |
| `@stuga/runtime` | nothing | The actor contract, the in-process actor host, sockets, SQLite storage and the filesystem blob store. `@stuga/runtime/testing` is an in-memory host. |
| `@stuga/auth` | protocol | Token signing and verification, API keys, the tokens OAuth hands agents, password hashing, ACL checks, and the client side of sign-in through an identity provider. No database access. |
| `@stuga/db` | protocol | The Postgres client, the migration runner and boot repairs, queries per domain, search, the job queue. |
| `@stuga/ai` | protocol | Provider clients, chunking, embeddings, reranking, and the agent loops of the co-author, the table assistant and Ask. |
| `@stuga/crdt-ops` | protocol | Markdown to and from Yjs, block-level edits, footnotes. Shared by the browser, the node and the document actor. |
| `@stuga/doc-actor` | runtime, crdt-ops, ai, protocol | The document actor. |
| `@stuga/database-actor` | runtime, protocol | The database actor. |
| `@stuga/agent-surface` | protocol | The agent tools: names, annotations, descriptions, input schemas, server instructions and result wording; `registerAgentTools`, which registers every tool against a surface that finds the backend for the workspace each call names; and the rank merge of results from several workspaces. |
| `@stuga/mcp` | agent-surface, protocol | The stdio MCP server, a proxy to a node's `/mcp` that signs in through the browser, built to one file. |
| `@stuga/node` | all of the above | The node. |
| `@stuga/web` | protocol, crdt-ops | The web app. |

Neither actor package depends on `@stuga/db`: an actor reaches Postgres only by calling back into
the node ([Internal calls](#internal-calls)). Libraries ship their TypeScript source and have no
build step. The node runs its source through tsx, and only the web app and the stdio MCP bundle are
built.

## The node

`services/node/src`:

| Path | Holds |
|---|---|
| `main.ts`, `cli.ts` | `serve`, and the operator commands. |
| `boot/` | The boot sequence, the Postgres preflight checks, the backup before an upgrade, shutdown. |
| `config/` | Environment parsing, secret files under `DATA_DIR/secrets`, and the stores for the values the Settings page edits. |
| `env.ts` | `NodeEnv`: the configuration and services every handler, actor and job receives. |
| `http/` | The route table, the matcher, the dispatcher, CORS, rate limits, security headers, and the serving gate that answers while the node starts or pauses. |
| `platform/` | The HTTP and WebSocket listener, static files, the rate limiter, the in-process internal API, intervals. |
| `auth/`, `authz/` | Request contexts, principals and socket tickets; the authorization predicates, document ownership and review mode. |
| `identity/` | Accounts and sessions: `/auth/*`, the JWKS, password resets, sign-in through an identity provider. |
| `api/` | REST handlers, one file per resource. |
| `documents/` | Document creation and the access checks routes share. |
| `databases/` | Database routes, agent proposals, staged imports, row pages. |
| `agents/` | Agent keys, the document propose path, agent setup, the installers, the `.mcpb` extension. |
| `governance/` | The event feed, the review inbox, webhooks. |
| `retrieval/` | Collection scope, the retrieval pipeline, the Ask tool runner. |
| `media/`, `audit/` | Media storage and serving; writing and reading the audit ledger. |
| `mcp/` | `/mcp`, and the OAuth authorization server whose grants and tokens it accepts. |
| `internal/` | The routes actors call back into. |
| `jobs/` | Job handlers and the maintenance tick. |
| `ops/` | Backup, verify, restore and list, and the backups a running node takes of itself. |
| `net/` | Address classification and outbound URL vetting. |
| `updates/` | The daily look for a newer version: the release list, the comparison, and the notice to administrators; and the request to the packaging's upgrade helper behind **Update now**. |
| `writer-lock.ts` | The Postgres advisory locks that allow one node per database and keep a node and a backup or restore apart. |

Boot runs in order: parse the environment; check the Postgres major, pg_search and the database
collation; take the writer lock; listen, answering that the node is starting; back up the database
when another version served it last; apply migrations and boot repairs; load the settings and the
signing key; create the actor namespaces, blob stores and job queue; build the routers; serve; start
the job worker and the maintenance tick, which runs every two minutes. On SIGTERM the node stops the
same pieces in reverse and gives up after 25 seconds.

## Requests

One handler takes every HTTP request, and every answer leaves through the same security-header
layer:

- `/auth/*`, `/.well-known/jwks.json` and `/.well-known/openid-configuration` go to the identity
  router, which keeps its own limit on credential attempts per source address and per account. A
  `GET` of `/auth/complete` or `/auth/first-visit` is a page of the web app instead.
- `/api`, `/mcp`, `/oauth`, `/.well-known/oauth-*`, `/ready` and `/ws` go to the app, except a `GET`
  of `/oauth/consent`, which is a page of the web app.
- Everything else is the web app: a built file, or `index.html` for a client-side route.

The app first applies the origin gate: a request whose `Origin` is not `PUBLIC_ORIGIN`, not listed
in `EXTRA_ORIGINS`, and not the local address the request itself went to (an IP address or a local
name, at `PUBLIC_ORIGIN`'s scheme) is refused before any credential is read. Clients that send no
`Origin` pass. Then `APP_ROUTES` in `http/routes.ts` is matched in table order, by method and by
exact path or anchored pattern, and the first match wins. Each route declares the credential it
needs:

- `none`: readiness, OAuth, the model list, media reads (authorized by a signed ticket cookie), and
  the signed upload URL of a staged import.
- `account`: an authenticated identity with no workspace yet, for listing and creating workspaces,
  redeeming invites and share links, a person's bookmarks to other nodes, and the apps they
  connected through OAuth.
- `mcp`: `/mcp` alone. An OAuth access token, an API key or a session token, with the workspace
  resolved on each tool call rather than for the request, and one budget per credential (600
  requests a minute) whatever workspaces its calls name. OAuth access tokens are accepted nowhere
  else.
- `workspace`: everything else.

A workspace route builds its context from the credential: a session token resolves the person and
their membership, and an API key resolves its owner's membership in the workspace the key was minted
in. Principals and role are read from Postgres on every request and cached nowhere. Next come the
per-principal budget (600 requests a minute per credential per workspace) and the refusal of any
request other than `GET` or `HEAD` from a read-only key, unless the route is marked `readOnlyKeys`:
a `POST` that only reads, or a change to the key's own Ask threads. Then come the gates the route
declares: `humanOnly`, `guestForbidden`, `workspaceAdmin`, `nodeAdmin`. What a read-only key gets
from every route is pinned in `services/node/src/http/routes-read-only.test.ts`, so a new route
fails that test until its answer is decided.
Responses carry `x-stuga-user`, `x-stuga-name` and `x-request-id`. Refusals with 403, 423 or 429 are
written to the audit ledger.

Invariants the request layer holds:

- The listener rebuilds every request URL on `PUBLIC_ORIGIN`, never on the `Host` header. Minted
  links, the origin allow-set (with `EXTRA_ORIGINS`) and the media cookie's `Secure` flag all derive
  from it. OAuth discovery is the one answer that follows `Host`, and only among `PUBLIC_ORIGIN` and
  `EXTRA_ORIGINS`: an agent that called the node at one of them is answered with that origin, and
  any other `Host` gets `PUBLIC_ORIGIN`'s.
- The web app is served by the node, same-origin with the API, and derives its API and socket
  addresses from `location`. One build works at any address.
- The listener caps request bodies at a size derived from the **Maximum upload size** setting and
  answers 413 above it. Nothing in front of the node needs to parse HTTP.
- No page the node serves may be framed, and no `Referer` leaves it. A handler that sets one of those
  headers keeps its own, stricter value, so the layer only adds. The OAuth consent screen is refused
  framing whatever its handler set.
- A browser opens a sync socket with a **socket ticket** in the URL, never an access token. A URL
  reaches logs and history, so the ticket is an HMAC bound to one document, one person in one
  workspace, a write tier and five minutes. It authenticates and does not authorize: every upgrade
  re-reads the document row and re-evaluates its ACL against principals resolved live, and the
  ticket's write tier only caps that answer. An agent opens a socket with its API key instead, which
  marks the connection as an agent's.

## Actors

An actor is a single-threaded object addressed by a stable name. `env.docs.get(docId)` returns a
handle, and `handle.fetch("http://actor/...")` delivers a request to that actor. The contract lives
in `packages/runtime/src/interfaces.ts`, and the host guarantees:

- **One entry point at a time.** `fetch`, the socket callbacks and `alarm` each run to completion
  before the next starts, so actor code may hold an invariant across an `await` without its own
  locks. Different actors run concurrently. `interceptWebSocketMessage` is the one exception: it runs
  before a frame is queued, so a cancel can reach a turn that holds the lock, and it may only signal.
- **Durable storage.** Each actor has one SQLite file under `DATA_DIR/actors/<namespace>/`, holding
  a key-value store, synchronous SQL (`storage.sql`) with savepoint-nested `transactionSync`, and its
  alarm. The host stamps the file with the version of what its namespace keeps, and refuses one that
  a newer build stamped.
- **Durable alarms.** One alarm slot per actor. A pending alarm survives eviction and restart; the
  host re-arms every alarm it finds on boot. A failed alarm handler is retried with backoff.
- **Sockets with typed session state.** An actor accepts the server half of a socket with
  `acceptWebSocket(ws, meta)`. `meta` is typed per actor and lives as long as the socket, which is
  enough because the host evicts only actors with no open sockets (after ten idle minutes) and a
  restart or a backup's pause closes every socket with 1012. Clients reconnect and re-sync; one that
  leaves while the actor waits to close has its last frames and its close handled first.
- **Heartbeat in the host.** The client sends the text frame `ping` on a timer, and the host answers
  `pong` without entering the actor, so a keepalive never waits behind the actor's lock.

**The document actor** (`@stuga/doc-actor`) holds the live Yjs document. Clients sync over one
binary socket per open document, with frames of a one-byte opcode and a payload
(`packages/protocol/src/wire/opcodes.ts`): sync steps and updates, awareness, receipts (update
acknowledgement, sync done, write rejected, document reset, document epoch, persistence degraded),
the co-author's request, response, edits and cancel, and run-ledger updates. Unknown opcodes are
ignored at both ends, so no version handshake is needed. The actor journals updates to its own
storage and flushes a snapshot to `env.snapshots` after 100 updates, 30 seconds after an unflushed
edit, and when a socket closes. It records versions with their authors and hosts the co-author turn.
It refuses raw Yjs writes from an agent's socket (`approval_required`): agent content arrives only as
proposals.

**The database actor** (`@stuga/database-actor`) holds one structured database as typed tables in
its SQLite file. Schema changes, row edits and queries all serialize through it, so a reader never
sees a half-applied change. Every mutation is written to the database's ops ledger with what it
takes to revert it, up to a size limit. Agent SQL runs read-only inside a transaction that always
rolls back, under row, value-size and time limits. The actor also enforces per-alias rate limits.

## Internal calls

Actors hold no database connection. When one needs Postgres (retrieval for the co-author, another
document's Markdown, a proposal into another document, the instructions for agents that apply to a
document, media hosting), it calls `env.internal.fetch("/internal/...")`. That is an in-process call
into the node's internal routes (`internal/routes.ts`), never mounted on the listener. The actor
forwards the principals that were resolved from a verified credential when the socket opened, and the
internal routes still apply the tenant and ACL checks, including which folder and database levels of
the instructions those principals may see.

`env.internalSecret`, generated on first boot and kept at `DATA_DIR/secrets/internal`, is the HMAC
key for socket tickets, media tickets and import upload signatures.

## Postgres

**Schema.** The numbered files in `packages/db/migrations/` are the whole schema. The runner
(`packages/db/src/schema/migrate.ts`) applies the migrations a database has not seen, in order, in
one transaction under an advisory lock, and records each with a checksum in `schema_migrations`. An
applied migration is frozen, so a schema change is a new numbered file. The node refuses a database
written by a newer build. Two things are re-asserted on every boot instead
(`schema/boot-repairs.ts`): extensions are updated to the installed binaries, and the BM25 indexes are
reconciled to `SEARCH_LANGUAGES` and rebuilt when a different pg_search version built them. The node reads the migration SQL from its source tree at runtime.

**Tenancy.** `workspace_id` is the hard tenant filter on every tenant-owned row, and foreign keys to
`workspaces` cascade on delete.

**Permissions are a flattened principal array.** Every document row carries `acl_principals` (who
may read), `acl_writers` and `acl_commenters`: the effective sets, such as `user:x`, `group:y` and
`org:<workspace>`, recomputed when the resource's own ACL or its folder changes. A group grant stays
`group:y` and is never expanded to members. The caller's principal set carries their group ids, read
on every request, so a membership change applies on that person's next request and no row is
rewritten. Authorization is a GIN-indexed overlap:

```sql
WHERE d.workspace_id = $1
  AND d.acl_principals && $2::text[]   -- the caller's principal set
```

**Hybrid search is one SQL statement** (`packages/db/src/search.ts`). The keyword leg is BM25 through
pg_search, under an ICU tokenizer: Unicode word breaks for scripts that space their words, and
dictionary breaks for those that do not. `马里亚纳海沟` indexes as 马里·亚·纳·海沟, not six
characters, and Japanese segments the same way. Korean and Arabic are split only at spaces, which
leaves a particle attached to its word; `SEARCH_LANGUAGES` adds a Korean dictionary tokenizer or
Arabic stemming as an extra field. English matches by stem with stopwords ignored, so `plan` finds
`planning`. The search box needs every non-stopword term of the query (a query of stopwords alone
matches them as written) and tolerates a one-letter typo in a title. The semantic leg is pgvector
HNSW over chunk embeddings, keeping chunks within the node's
[match cutoff](configuration.md#match-cutoffs). The two legs are fused with Reciprocal Rank Fusion in
the same statement, and the tenant, trash, hidden-from-search, ACL and key-scope filters sit inside
each leg.
Search is permission-correct and current by construction: it reads the live rows, so an ACL change
applies to the very next query.

Every snapshot flush queues an `index_doc` job. It extracts the text, splits it into sections, embeds
the sections that changed, and replaces the document's chunks. How chunks are cut and how Ask
retrieves and cites them is in [rag-cross-doc-qa.md](rag-cross-doc-qa.md). Scoping either to a saved
set of documents is in [collections.md](collections.md).

## Blobs on disk

`env.snapshots` and `env.media` are `BlobStore`s over directories under `DATA_DIR/blobs/`: get, head,
put, delete, and list by prefix with a cursor, with the content type in a sidecar. Postgres stores
keys and metadata, never the bytes. Media keys are namespaced by workspace and content hash, and a
media read is authorized by a short-lived signed ticket cookie.

## Background jobs

`env.jobs.send(message)` inserts a row into the `jobs` table. The worker in the same process leases
batches with `FOR UPDATE SKIP LOCKED`, acknowledges by deleting the row, and retries with exponential
backoff. After five attempts a job is kept as dead, with its last error, instead of retried. Delivery
is at least once, so every handler tolerates a repeat. The message kinds
(`packages/protocol/src/internal/jobs.ts`):

| Kind | Does |
|---|---|
| `index_doc` | Indexes a flushed snapshot, embeds its chunks, records a version when the actor asks. |
| `gc_check` | Deletes a deleted document's snapshots. |
| `notify` | Writes an in-app notification and, when a sink is configured, queues its `notify_deliver`. |
| `notify_deliver` | Delivers one stored notification to the configured sink; retried on its own. |
| `ai_usage` | Records token usage for the AI usage page. |
| `audit` | Appends to the audit ledger; a batch's audit rows are inserted together. |
| `run_index` | Mirrors a run into the review inbox. |
| `event` | Appends to the workspace event feed and queues one delivery per matching webhook. |
| `webhook_deliver` | Posts one signed event to one webhook. |

The maintenance tick embeds chunks left without a vector, re-embeds every workspace after the
embedding model changes, takes the daily backup when it is due, purges expired trash, import
stagings and unfinished sign-ins through the identity provider, and applies retention to revoked
keys, notifications, sessions, OAuth clients, expired OAuth tokens, closed inbox runs, the event
feed, and the ledgers whose retention the Settings page controls (audit, AI usage, Ask threads).

## Identity

The node is its own issuer. Accounts live in Postgres, tokens are signed with a key kept at
`NODE_SIGNING_KEY`, and the JWKS is served at `/.well-known/jwks.json`. Verification needs no
network, so a node without internet access still signs people in.

An administrator can add one identity provider in the node's settings, and the node is then that
provider's client. `POST /auth/oidc/start` stores the state, nonce and PKCE verifier in
`oidc_flows` and ties the flow to the browser with a short-lived HttpOnly cookie. The callback
exchanges the code, verifies the ID token once and looks the person up by `users.oidc_sub`. A known
account gets the same tokens as a password sign-in, handed to the web app through a one-time code; an
unknown one gets a ticket for the first-visit page, which creates an account with an invite or links
one by its username and password. The provider's tokens are then dropped, so refreshing a session
never reaches the provider: an outage stops only new sign-ins through it, and disabling someone there
ends none of their sessions on the node.

## More than one node

Nodes never call one another, and no node's database refers to another node's accounts. What spans
nodes happens in the client:

- **Name and ID.** `node_settings.node_name` is what the app shows in place of Stuga's own name.
  Where nodes are told apart, in the switcher and to agents, an unnamed node goes by the host of
  `PUBLIC_ORIGIN` without its port or a trailing `.local`. `node_state.node_id` is chosen on the
  first boot and never rewritten, for whatever needs a key that survives a rename.
- **Other nodes** in the workspace switcher are each person's bookmarks, rows of `user_nodes` holding
  a label and an origin, never shared and never checked to be a Stuga node. A `CHECK` keeps the origin
  a bare http or https one, and the switcher opens nothing else. Opening one navigates the whole page,
  because a session belongs to one node's origin and no page a node serves may be framed.
- **Agents** connect to each node as a separate MCP server. One search covers any of the workspaces
  a connection reaches on its node; across nodes, the client fans out and the model combines the
  answers.

## Audit

The audit ledger is append-only. Rows are queued as `audit` jobs from the places that change things:
document and folder writes, sharing, keys, connections, proposals and decisions, database mutations,
settings, and every `/mcp` tool call in a workspace, reads included. Refused requests are recorded
too. Each row records the actor, its kind (`human`, `agent` or `internal`), the human an agent acted
for, the source (`web`, `mcp`, `api-key`, `ws`, `internal` or `cron`), the action, the target and
its name at the time, and the status. The maintenance tick purges rows past the audit retention set
on the Settings page.

## The run ledger

An agent never changes a document or database directly. Each content write is a proposal to the
actor, which the node sends with the review mode it resolved from the document's `agent_mode`
(`authz/review-mode.ts`):

- **`review`**, the default: the change parks as pending hunks (or ops) in a run, one agent session
  on one document, and the reviewer is notified. Pending state lives in the actor's storage, not in
  the Yjs document, so collaborators never see unreviewed agent content, and nothing lands it except
  a person's decision.
- **`auto`**: the change applies at once, is recorded as applied without review, and can be reverted.
  The reviewer is notified. A run that still holds undecided changes parks new ones even on an `auto`
  document.

The agent gets its answer immediately either way. Its later reads are projected through its own
pending hunks, and its `status` call reports decisions. Accepted edits merge block by block through
`@stuga/crdt-ops`, so structure survives and concurrent human edits elsewhere are kept. Runs are
mirrored into Postgres through `run_index` jobs for the review inbox. The model as people and agents
meet it is in [agents.md](agents.md#what-the-run-ledger-shows).

## MCP

The tools live in one place, `@stuga/agent-surface`, and one endpoint serves them:

- **`/mcp`** is a stateless Streamable HTTP endpoint. Each request builds a server around the
  caller: who it acts for, the workspaces its credential may name, and whether it may only read, in
  which case only the reading tools are registered. A tool call acts in the workspace it names, and
  only if the credential reaches it and its person is a member there now; nothing falls back to
  another workspace. The tool then runs in-process over the same node code as the REST routes, and
  writes an audit row in that workspace. `search` and `retrieve` run once per workspace named and
  merge the answers by rank.
- **`stuga-mcp`** (`services/mcp`) is a stdio process a desktop client launches. It forwards to a
  node's `/mcp`, so its tools, wording and checks are that node's, and adds only the upload of a
  local file for an import. It sends a key when it has one, and otherwise signs in through the
  browser like any other app.

An MCP agent holds no socket and is not in the presence bar. Its work shows up in the run ledger,
and presence never affects whether an edit waits for review. Setup and the tools:
[agents.md](agents.md).

**OAuth.** The node is the authorization server for its own `/mcp`: discovery (RFC 8414, RFC 9728),
clients that register themselves (RFC 7591) or are known by a client metadata document the node
fetches through its outbound URL checks, authorization code with PKCE, rotating refresh tokens, and
revocation (RFC 7009). A consent creates or renews a grant in `oauth_grants`: one person's
authorization of one client over the workspaces they chose, with read or propose access. Its agent
keeps one identity for life, so a grant is revoked and never deleted, and runs and audit rows name
the same agent for as long as they are kept. Tokens in `oauth_tokens` are stored as hashes, belong to
one sign-in's chain, and are accepted only by `/mcp`. A token belongs to the node, not to one of its
addresses. The OAuth routes: [api.md](api.md#agents-over-oauth).

Both servers introduce themselves as `name: stuga`, `title: Stuga`, with nothing of the node in
either: a client holds one Stuga connection. Which node a call lands on is routing detail, and lives
where the model can act on it — the instructions name the node's current name and `PUBLIC_ORIGIN`,
and `workspaces` action `list` names the node of every workspace the connection reaches, so a
`workspace_id` says which node too and no tool takes a node. `/mcp` reads the node name on every
request. `stuga-mcp` passes on the node's instructions. Until it reaches the node, its own
instructions name the node by `node_label` and `origin` from the node's public `/auth/config`, asked
for at most two seconds at startup, and otherwise by `STUGA_NODE_NAME`, then the host of
`STUGA_URL`, and the origin of `STUGA_URL`.
