# Agents and MCP

Stuga treats AI agents as users with their own write path. An agent connects over MCP, reads and
searches whatever its credential reaches, and proposes changes. Every content write goes through the
run ledger, where it is attributed, shown change by change, and waits for review unless the document
is set to apply agent changes at once. This page covers connecting clients, credentials, the tools,
and what the ledger shows.

**Settings → Your own AI** in Stuga has the setup for the node you are running, with its address already
filled in. Use it when it disagrees with an example here.

## Which clients can reach a node

- **Claude Code, Claude Desktop, and other MCP clients on your own machine** work with any node they
  can reach, including one on `localhost` or your local network. Claude Code dials the node's `/mcp`
  endpoint. Its browser sign-in needs the node on https or on loopback, so on a plain-http network
  address **Your own AI** gives it a command carrying a key instead. Claude Desktop runs Stuga's
  stdio server from an extension, and the server calls the node.
- **Codex and Google Antigravity** dial the node's `/mcp` endpoint and work with any node the machine
  can reach. **Your own AI** gives one command per host that installs the Stuga Skill and adds the
  node; both hosts sign in through the browser, so no key is pasted.
- **Claude on the web and on mobile** add custom connectors that Anthropic's cloud dials. Those need
  the node at a public HTTPS origin, set as `PUBLIC_ORIGIN`. **Your own AI** offers the **Claude** tab
  only when `PUBLIC_ORIGIN` is not a loopback, private or local-network address. Ways to give a node a
  public HTTPS origin are in [network-access.md](network-access.md#https).

## One connection, and which node a call lands on

A client holds **one** Stuga connection. Every config names it `stuga`, every client shows it as
**Stuga**, and the extension downloads as `stuga.mcpb`. No node name, host or ID appears in any of
them: a node is renamed, moved to another address, or reached at a second address, and the client's
entry never changes.

Which node and which workspace a call acts in is the answer to `workspaces` action `list`, not the
connection's name. That listing is the routing table:

- Each workspace carries the node it is on: `node: { id, name, origin }`.
- A `workspace_id` is unique everywhere, so passing one already says which node is meant. **No tool
  takes a node.** Omitting `workspace_id` acts in the home workspace the connector was authorized in.
- The instructions open with the node a call lands on by default, and point at that listing.

Today every workspace in the listing is on the node the connection is to. Nodes never talk to each
other, so an agent that works with two nodes is set up on each: the second connection is added by hand
under another name, because a client cannot hold two entries called `stuga`. In the Claude Code command
write `stuga-work` in place of `stuga`; in a pasted JSON config, change the key; for the Codex and
Antigravity installers, run the command as `curl -fsSL '…' | STUGA_SERVER=stuga-work sh`. The
installers refuse to touch an entry whose name is already taken by another server, rather than replace
it. The Claude Desktop extension needs nothing: it installs under the node's ID, so a second node's
extension sits beside the first.

The shortcuts to other nodes in a person's workspace switcher are theirs alone: `/api/me/nodes`
refuses API keys, so an agent reaches another node only by being connected to it.

## Claude Code

```sh
claude mcp add -s user --transport http stuga http://localhost:8787/mcp
```

Use your node's origin in place of `http://localhost:8787`; **Your own AI** fills it in. `-s user`
adds the connection once for every project. Then run `/mcp` in Claude Code, pick **stuga**, and choose
Authenticate. You sign in to your node in the browser, with your password or through the node's
identity provider, and no key is pasted: the node runs the OAuth flow itself and mints a key for the
connection, which appears in **Your own AI** as *signed in* and can be revoked there.

That sign-in only works when `PUBLIC_ORIGIN` is https or a loopback address. Claude Code refuses to
send a credential to a token endpoint that is neither, so on a node at a plain-http network address,
such as `http://nas.local:8787`, **Your own AI** names a key in the command instead:

```sh
claude mcp add -s user --transport http stuga http://nas.local:8787/mcp \
  --header "Authorization: Bearer vk_..."
```

Name the agent on the **Claude Code** tab and the command comes back with its key in place. The key
is stored in Claude Code's own configuration file in plain text, and is revoked in **Your own AI**
like any other. Giving the node [an https address](network-access.md#https) brings the browser
sign-in back.

## Claude on the web

In Claude, open Settings → Connectors → **Add custom connector** and paste the MCP endpoint the
**Your own AI** shows (`<PUBLIC_ORIGIN>/mcp`). Claude asks you to sign in to Stuga, and the connection's
key appears in **Your own AI** as *signed in*.

## Codex and Google Antigravity

Both hosts set up from one command, shown on their tab in **Your own AI**:

```sh
curl -fsSL 'http://localhost:8787/api/agent-install/codex' | sh
curl -fsSL 'http://localhost:8787/api/agent-install/antigravity' | sh
```

Use the command your own node shows. It installs the user-level `stuga` Skill and points the host at
this node’s `/mcp`. **The script carries no key and the endpoint serving it mints none** — it is
unauthenticated because a script that grants nothing needs no credential to fetch. Read it in a
browser at the URL in the command before running it.

Both hosts register themselves through [dynamic client registration](#other-mcp-clients), so the key
that comes out is an ordinary connector key, listed in **Your own AI** as *signed in* and revoked
there like any other. They differ in where the sign-in starts. Codex performs OAuth while the
installer runs `codex mcp add --url`; use `codex mcp login` only to sign in again later. Antigravity
has no such command — its OAuth runs inside the IDE and ends by pasting a code back from a hosted
callback — so it shows **Authenticate** beside the server until you click it once, and reports
`Unauthorized` until then.

Restart the host when the command finishes, so the Skill is discovered. An ordinary question such as
“can you access my Stuga workspace?” then routes to the connection without naming it.

Where each host keeps its pieces:

| | Codex | Antigravity |
|---|---|---|
| Skill | `~/.agents/skills/stuga` | `~/.gemini/config/skills/stuga` |
| MCP server | `codex mcp add --url`, shared by the CLI and the IDE extension | a `serverUrl` entry in `~/.gemini/config/mcp_config.json` |
| Removal also clears | the stored sign-in, via `codex mcp logout` | the cached token in `~/.gemini/antigravity/mcp_oauth_tokens.json` |
| Sign-in | During `codex mcp add --url`; use `codex mcp login` to sign in again | **Settings → Customizations → Installed MCP Servers → Authenticate** |

In the Antigravity IDE the same server can be added by hand under **Settings → Customizations →
Installed MCP Servers**; in the Codex IDE extension, from the gear menu under **MCP servers** as a
Streamable HTTP server. Either way the entry needs only the URL.

### Uninstall

Open **Uninstall from Codex** or **Uninstall from Antigravity** on the tab, which shows two commands.
The first disconnects this node and keeps the Skill, for a computer that reaches more than one Stuga
node; the second removes the Skill too, for the last node on that computer.

```sh
curl -fsSL 'http://localhost:8787/api/agent-install/codex?action=disconnect' | sh
curl -fsSL 'http://localhost:8787/api/agent-install/codex?action=uninstall' | sh
```

Neither revokes anything: the connector the host signed in with lives on the node. Revoke it under
**Connected agents**, then restart the host.

## Claude Desktop

In **Your own AI**, open **Claude Desktop** and click **Add to Claude Desktop**. Double-click the
downloaded `stuga.mcpb`, click **Install**, then quit Claude completely and open it again.
Closing the window leaves it running. The file carries the server and a key minted for it, so
nothing is typed.

The downloaded file is a working credential. Delete it once the extension is installed. If it goes
anywhere it should not, revoke its key in **Your own AI**, and the installed extension stops working
on its next call.

Each node's extension installs beside the others'. One downloaded from a second workspace on the
same node replaces the first, so a desktop install reaches one workspace per node.

If the tools do not appear, quit Claude fully and reopen it, then read the extension's
`mcp-server-*.log` in `~/Library/Logs/Claude/` (on Windows, `%APPDATA%\Claude\logs\`).

### Setting it up by hand

When the node's `PUBLIC_ORIGIN` is a loopback address, so the browser and the node share a machine,
**Your own AI** also offers **Set it up by hand instead**: a `claude_desktop_config.json` entry with
a key you mint there, the absolute path of the Node interpreter running the node, and the absolute
path of the node's stdio server. Paste it in Claude Desktop under Settings → Developer →
**Edit Config**. Paths are absolute because desktop clients start servers without your shell's
`PATH`.

Which server file the node offers is a packaging setting, `STUGA_STDIO_ENTRY`
([packaging/contract.md](../packaging/contract.md#packaging-hints)). When a node's files are not on
your machine's filesystem, it offers none, and the extension or an HTTP connection is the way in.

From a source checkout, build the server once and point the config at it:

```sh
pnpm --filter @stuga/mcp build   # writes services/mcp/dist/stuga-mcp.js
```

```json
{
  "mcpServers": {
    "stuga": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/stuga/services/mcp/dist/stuga-mcp.js"],
      "env": {
        "STUGA_URL": "http://localhost:8787",
        "STUGA_TOKEN": "vk_..."
      }
    }
  }
}
```

`which node` prints the interpreter path.

## Other MCP clients

Any client that speaks Streamable HTTP can use `<PUBLIC_ORIGIN>/mcp`. A client that supports OAuth
signs in like Claude Code. Any other client sends a key as `Authorization: Bearer vk_...`, and the
**Other clients** tab in **Your own AI** builds that config.

## The stdio server's settings

`stuga-mcp.js` reads these settings:

| Variable | File field | Default | |
|---|---|---|---|
| `STUGA_URL` | `url` | `http://127.0.0.1:8787` | The node's origin. |
| `STUGA_TOKEN` | `token` | none | An API key. |
| `STUGA_WORKSPACE` | `workspace` | none | A workspace to act in, honoured only for a person's access token that belongs to it. An API key always acts in the workspace it was minted in. |
| `STUGA_MODEL` | `model` | none | A model label, sent as `x-stuga-model` and shown beside the agent's runs. |
| `STUGA_CLIENT` | `client` | `stuga-mcp` | A client label, sent as `x-stuga-client`. The extension sets `claude-desktop`. |
| `STUGA_NODE_NAME` | `node_name` | the host of `STUGA_URL` | The node's name, for when the node cannot be asked. At startup the server asks the node's public `/auth/config` for its current name and its `PUBLIC_ORIGIN`, which win. The extension sets it. |

Each setting comes from the environment first. When the environment sets both `STUGA_URL` and
`STUGA_TOKEN`, only the node's name can still come from a file: `node_name` in `config.json` beside
the server file, when the environment has no `STUGA_NODE_NAME` and the file's `url` is `STUGA_URL`.
Otherwise each missing setting is taken from `config.json`, then from
`~/.config/stuga/credentials.json`. Both files are JSON objects with the field names above. The
extension writes its settings to `config.json` as well as to its launch environment, because a
client does not always pass that environment to the process it starts, and a name with `$` goes only
to the file.

## DeepSeek Harness

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) reaches the node over
`/mcp` with a key. The `@stuga/dsh-bundle` plugin installs into a dsh profile and adds what a bare MCP
connection lacks: playbook skills for research, edits and databases, and a system-prompt section that
carries the workspace's instructions for agents, explains that a `Proposed` result is success and
must not be retried, and says to follow the instructions that come back with a document
([below](#instructions-for-agents)).

In **Your own AI**, open **DeepSeek Harness** and mint a key. Then, on the machine that runs dsh:

```sh
dsh plugin --profile web add @stuga/dsh-bundle
```

Put `STUGA_URL` (the node's origin) and `STUGA_API_KEY` (the key) in `$DSH_HOME/.env` or in the
environment that launches dsh, and restart `dsh web`. **Your own AI** prints both lines with the key
filled in. The harness's runs appear in the review inbox labelled `deepseek-harness`, under the key's
name.

dsh's MCP client has no browser sign-in, so the key is static and its owner reviews everything the
harness proposes. Mint one key per person rather than sharing one.

## API keys

Mint a key in **Your own AI**, or with `POST /api/keys` ([api.md](api.md#authentication)). A key
looks like `vk_<id>_<secret>`. The secret is shown once, and the node stores only its hash.

- **A key acts for the person who minted it.** Its reach is its owner's live reach: the owner's
  principals and role are read again on every request, so a guest's key is a guest's, and a key
  whose owner has left the workspace fails on its next request. Removing a member also revokes the
  keys they minted in that workspace.
- **A key belongs to one workspace.** It acts in the workspace it was minted in. On `/mcp`, a key
  that is not confined to folders may pass `workspace_id` to act in another workspace its owner
  belongs to, at the owner's role there.
- **An agent has its own principal**, `agent:<id>`. A document an agent creates is owned by its human
  and shared with the agent as a writer.
- **Content only.** Agents change documents and databases through the run ledger. Renaming, moving,
  trashing and deleting items, sharing, locks, the agent-changes setting, and workspace and key
  management all refuse agents, because none of them leaves a run to revert.
- **Collections are the exception.** A collection only scopes search and AI, so an agent key with
  write access creates, renames and deletes its person's collections and adds and removes their
  members, and a read-only key lists and opens them. The person sees every change, and the audit
  ledger names the agent and the person it acted for ([collections.md](collections.md)).
- **A key can be narrowed below its owner's reach**: confined to folders (each with its subtree),
  made read-only, or given an expiry. **Your own AI** sets these when a key is minted, and
  `PATCH /api/keys/:id` changes them later. A narrowing only removes reach. A folder-scoped key's
  listings, search, retrieval and events are filtered to its folders, and a document elsewhere reads
  as not found. A read-only key reads and searches everything its owner can reach and changes
  nothing ([below](#read-only-keys)).
- **Rotate** gives a key a new secret and keeps its identity, so its runs and audit rows still name
  the same agent. **Revoke** stops it on its next request. **Rename** changes how it is attributed:
  a key is minted under the name of the client it is for, so rename one when the same client is
  connected twice.
- A key minted through OAuth is not narrowed and never expires, and is revocable like any other.
  Connected agents says *signed in* on its row instead of *key created*, and offers no Rotate: its
  token came from the OAuth exchange, so a new one would have nowhere to go. The token response still states a one-year `expires_in`, because a client that reads none
  may store a zero expiry, take the token for expired and stop sending it. It understates the key's
  real life, so at worst the client asks to sign in again.
- `STUGA_TOKEN` and the REST API also accept a person's access token, which acts as that person.
  It expires within an hour by default and is attributed to the person rather than an agent, so use
  it only to experiment.

Every `/mcp` tool call, reads included, is written to the audit ledger with the credential, the tool
and action, and the target. Over REST, writes and refusals are recorded.

## What the run ledger shows

A **run** is one agent's editing session on one document or database. For each run you see:

- **Who and what**: the agent and its key's name, the client and model labels it sent (the
  `x-stuga-client` and `x-stuga-model` headers, which the extension, the stdio server and the dsh
  bundle set), and the person it acted for.
- **The changes**: each proposed hunk (or database operation), shown against the document and
  reviewable one by one.
- **The outcome**: per hunk accepted, rejected or pending; per run waiting for review, applied at
  once, or reverted.

While a run has pending hunks, their content appears only in the reviewer's overlay. Collaborators
never see pending agent text, and their own edits continue as usual. Accepted hunks merge block by
block, so surrounding structure and other people's changes survive.

An agent is never blocked on review. A proposal returns immediately, the agent's later reads include
its own pending edits, and `markdown` or `databases` action `status` reports what was decided.

## Agent changes: wait for review, or apply at once

Whether an agent's change waits is a setting on each document and database, `agent_mode`:

| Mode | Meaning |
|---|---|
| `review` | The default. The change waits for a person for as long as that takes. The reviewer is notified, and only their decision lands it. |
| `auto` | The change applies at once. It is still recorded, attributed, notified and revertible. |

The owner or a workspace admin changes it from the ⋯ menu beside **Share**: **Let agents apply
changes at once**, and **Make agent changes wait for review** to switch back. While it is on, the
item shows an **Agents apply at once** chip, and lists mark it. Every change of the setting is in the
audit ledger.

The setting never depends on whether someone has the document open. The same agent making the same
edit gets the same outcome at any hour, so a person can predict it and an agent can plan around it.
Two consequences follow:

- A document an agent keeps for its own notes waits for review like any other, until someone
  switches it to `auto`.
- `auto` belongs to the document, not to an agent. While it is on, every agent key that can write
  the document changes it without review.

A run that still holds undecided changes parks new ones even on an `auto` document, and the reply
says so.

The propose reply carries `review` and `reason`, so an agent can explain what happened. `docs`
action `metadata` (and `GET /api/docs/:id` for an agent) answers the same question before writing:

```json
"review": { "mode": "review", "reason": "this document waits for review" }
```

The agent's owner reviews everything it proposes and is notified either way.

**The in-app AI co-author** stages its turn on the document you are working in as one run that waits
for your review, even on an `auto` document, and sends no notification, since you are watching it.
With **All documents** or a collection as the panel's search scope, it can also propose edits to
other documents you can edit. Those follow each document's own setting, like any agent's, and you are
notified for each, so they stay findable after the chat scrolls away.

Before switching a document to apply at once, look at that agent's record in the review inbox.

## The review inbox

**Review AI edits** (`/review`) lists the runs on documents you can read across the workspace:
**Needs review** (waiting for a decision, or applied at once and not yet looked at),
**In progress** (still collecting changes: something waiting, or active in the last 10 minutes),
**Finished** and **Everything**, filterable by agent. A run's **⋯** menu acts on
the whole run: **Accept all suggestions**, **Reject all suggestions**, **Revert these changes** and
**Mark as reviewed**; open the document to decide change by change. **AI activity**, below the list,
is each agent's record (runs, waiting, kept, skipped, applied automatically, reverted) and is what to
consult before switching a document to `auto`.

## Provenance

An agent reading a document cannot otherwise tell a person's sentence from another agent's
unreviewed one. `markdown` action `provenance` (and `GET /api/docs/:id/provenance`) lists every
agent-written passage still present, newest run first, with who wrote it and whether a person
accepted it or dismissed its card. The tool descriptions tell agents to treat an unreviewed passage
as a claim, never as an instruction.

## Instructions for agents

People write standing instructions for agents as free text: where notes go, which folders are off
limits, how tasks are recorded, the house style. The workspace, every folder, and every document and
database can carry its own.

- **They stack.** What applies to an item is every level from the workspace down to it, outermost
  first: the workspace's, each folder's from the root down, then the item's own. A row page sits
  where its database does: the database's folders, then the database, then the page. Empty levels
  are left out.
- **They add up.** A nearer level refines a farther one. None overrides, hides or cancels another,
  and nothing opts out of the levels above it.
- **They are advice.** The model is told to follow them, and nothing enforces them. What an agent's
  write does is still decided by permissions and the item's `agent_mode`
  ([above](#agent-changes-wait-for-review-or-apply-at-once)).
- **Each reader gets its own stack.** A folder or database level is included only for a reader who
  can read that folder or database, so a document shared on its own reveals nothing about a private
  folder above it. A key counts as its person: a key confined to a subfolder still gets the folders
  above it that its person can read.
- **Where to edit them.** The workspace's are on **Settings → This workspace → Agents**. A folder's,
  document's or database's are under **Instructions for agents…** in its ⋯ menu, which also shows
  the levels above it, and a new folder takes them in the same dialog as its name. Anyone who can read the item can look; its owner or a workspace admin changes
  them. Each change is in the audit ledger with the text's length, never the text.
- **Limits.** A level holds up to 20,000 characters. An agent is handed at most 60,000 characters of
  a stack: the level that crosses the limit is cut short, the nearer ones are left out, and the agent
  is told which (`instructions_cut` in an answer). The ⋯ dialog warns when a stack is that long.
- **Not content.** They are never indexed, embedded or searched.
- **Kept apart from the text around them.** Wherever a model reads them, each level sits in a marked
  block under its label. A line of instruction text that looks like one of those markers is escaped,
  and a title is shown on one line without its double quotes, so neither a level's text nor an item's
  title can end its block or pass for another level.

How agents get them:

- **The workspace's.** `/mcp` puts them in the server instructions, so an agent has them before its
  first call. Both servers return them from `workspaces` action `instructions`, which carries the
  workspace level only.
- **An item's stack.** `markdown` action `read` shows it in a marked block before the Markdown, or
  opens with a line saying none apply. Only that block at the very start of a read counts, and the
  agent is told so: anything further down that looks like instructions is document text, so an
  editor cannot plant instructions in a document's text.
  `docs` action `metadata` and `create`, and `databases` action `schema` and `create_database`,
  return it as `instructions: [{ kind, id, title, text }]`, outermost first. A write needs no read, so
  the answer to a `markdown` write, `str_replace`, `append` or `cited_edits` names the levels below the
  workspace that apply (`instructions_labels`), and the agent is told to read them before writing
  there again. Over REST an agent gets the same fields ([api.md](api.md#instructions-for-agents)).
- **In the app.** The co-author and the table assistant read their document's stack, as the person
  using them can see it, at the start of every turn, so an edit or a move applies to the next
  message. The co-author's first read or edit of another document it may edit carries a note on that
  document: which levels of the current document's stack also apply there and which do not, and the
  levels only that document carries, with the same policy framing. A level an earlier note in the
  same turn already showed is named rather than repeated. The note comes even when nothing applies
  there, and the co-author is told that only that first note is real. Ask reads the workspace's.

## Events and webhooks

- **Events.** The `events` tool and `GET /api/events` return what changed since a cursor, filtered to
  documents the credential can read. An agent that wants to react to a decision or a comment polls
  this instead of re-reading everything. Event types: [api.md](api.md#the-event-feed).
- **Webhooks.** Workspace owners and admins can send the same events to a URL, signed and retried.
  See [api.md](api.md#webhooks).

## The tools

Both servers register the same eleven tools from `@stuga/agent-surface`, with the same argument
checks and the same wording. `/mcp` runs them in-process over the node's own code, and `stuga-mcp`
runs them as REST calls, so both pass the same permission checks and the same run ledger.

| Tool | Actions and use |
|---|---|
| `workspaces` | `list` · `instructions`. The workspaces available to this connection and the node they are on, and a workspace's own instructions for agents. |
| `docs` | `list` · `search` · `metadata` · `create`. `list` takes an optional folder; `search` is hybrid keyword and semantic search that returns documents, optionally within a collection; `metadata` includes this agent's `review` answer for the document; `create` takes a title and an optional folder. `metadata` and `create` return the document's `instructions`. |
| `markdown` | `read` · `write` · `str_replace` · `append` · `cited_edits` · `status` · `provenance`. `read` shows the document's instructions in a marked block, then the text with the agent's own pending edits. `write` replaces the whole document, `str_replace` swaps `find` for `replace` (one occurrence, or all with `replace_all`), `append` adds text at the end of the document or of the section under `heading`, and `cited_edits` makes several exact edits at once with citations that become footnotes. All four are proposals. A mention of a person reads and writes as `[@username](mention:<alias>)`; keep it as written, and once an edit lands, a newly mentioned person who can read the document is notified. |
| `media` | `upload` · `upload_from_url`. Stores an image and returns its path for Markdown. Writing `![alt](https://…)` through `markdown` also downloads and stores the image. |
| `comments` | `list` · `add`. |
| `folders` | The folders the credential can read. |
| `events` | What changed since `after`, optionally narrowed by `types`. Without `after` it starts from the newest event. |
| `collections` | `list` · `open` · `create` · `rename` · `delete` · `add_items` · `remove_items`. The saved document sets of the credential's person, which `retrieve` and `docs` `search` can be scoped to. `open` lists the members the credential can read, and `add_items` skips ids it cannot read and says how many. Scoped, `retrieve` and `search` return nothing from outside the collection ([collections.md](collections.md)). |
| `retrieve` | The passages most relevant to a question across reachable documents, with their sources, optionally within a collection ([rag-cross-doc-qa.md](rag-cross-doc-qa.md)). |
| `databases` | `list` · `schema` · `status` · `create_database` · `create_table` · `add_column` · `insert_rows` · `update_rows` · `delete_rows` · `import` · `create_view` · `update_view` · `open_page`. Writes are proposals. `schema` and `create_database` return the database's `instructions`, and `schema` carries each column's `description`: what the column holds, written by the people here. `add_column` may set one. Every write's answer names the instructions that apply beyond the workspace's. `import` loads a whole CSV or JSONL file as one reviewable change, so bulk data never passes through `insert_rows`. `open_page` returns a row's page, a document read and edited with `markdown`, and creates it the first time. |
| `query` | One read-only `SELECT` (SQLite dialect) against one database, with `?` parameters. At most 8 KB of SQL, 1,000 rows, 1 MB per value and five seconds of work. `WITH RECURSIVE` is refused, because a recursive query that never ends cannot be stopped. |

Where the two servers differ:

- **`workspace_id`** is accepted only by `/mcp`, on every tool. The stdio server acts in the one
  workspace its credential resolves to, and its `workspaces` action `list` reports which.
- **`upload_from_url`** is `/mcp` only. Downloading a model-supplied URL stays on the node, behind its
  outbound address checks, rather than on your machine, where it would reach your local network.
- **`import`** on the stdio server also takes `file`, a path on the machine where the server runs.
  Both servers take the file's text in `content`, and both hand the agent a link to the table's
  Import dialog when a file is too large to carry.

### Read-only keys

A read-only key, over either server, may call every read:

| Tool | Actions a read-only key may call |
|---|---|
| `workspaces` | `list` · `instructions` |
| `docs` | `list` · `search` · `metadata` |
| `markdown` | `read` · `status` · `provenance` |
| `comments` | `list` |
| `folders`, `events`, `retrieve`, `query` | All of it. |
| `collections` | `list` · `open` |
| `databases` | `list` · `schema` · `status` · `open_page` for a row that already has a page |

Everything else, and `media` entirely, answers a normal tool error,
`error: this key is read-only: it can read and search, but not change anything`, and changes
nothing. The refusal is written to the audit ledger. Ask over REST is a read too, and a read-only
key keeps its own Ask threads ([api.md](api.md#read-only-keys)).

`/mcp` knows the key's access, so for a read-only key the server instructions carry the list above
and tell the agent to describe a change instead of attempting it. The stdio server cannot see
the key's access, so its instructions say what the refusal means and to stop attempting changes after
it.

Two rules hold whatever a client does:

- Raw Yjs writes from an agent's socket are refused (`approval_required`). Proposals are the only way
  an agent changes content.
- A successful proposal is recorded even while review is pending. An agent that sees no change on
  re-read is looking at its own pending edits, not a lost write. The tool results say `Proposed` and
  tell the agent not to retry.
