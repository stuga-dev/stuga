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
  stdio server from an extension, and the server forwards to the node's `/mcp`.
- **Codex and Google Antigravity** dial the node's `/mcp` endpoint and work with any node the machine
  can reach. **Your own AI** gives one command per host that installs the Stuga Skill and adds the
  node; both hosts sign in through the browser, so no key is pasted.
- **Claude on the web and on mobile** add custom connectors that Anthropic's cloud dials. Those need
  the node at a public HTTPS origin, set as `PUBLIC_ORIGIN`. **Your own AI** offers the **Claude** tab
  only when `PUBLIC_ORIGIN` is https and not a loopback, private or local-network address. Ways to
  give a node a public HTTPS origin are in [network-access.md](network-access.md#https).

An app you connect sees what its model reads and writes. A hosted one, such as Claude on the web,
handles it on its vendor's servers.

## One connection, and which node a call lands on

A client holds **one** Stuga connection. Every config names it `stuga`, every client shows it as
**Stuga**, and the extension downloads as `stuga.mcpb`. No node name, host or ID appears in any of
them: a node is renamed, moved to another address, or reached at a second address, and the client's
entry never changes.

A connection reaches the workspaces its credential allows: the ones you chose when the app signed in
([Apps that sign in](#apps-that-sign-in)), or a key's ([API keys](#api-keys)). `workspaces` action
`list` is the routing table:

```json
{
  "contract": 2,
  "workspaces": [
    {
      "workspace_id": "…",
      "name": "Research",
      "role": "member",
      "access": "propose",
      "node": { "id": "…", "name": "livs-air", "origin": "http://livs-air.local:8787" }
    }
  ],
  "unavailable": []
}
```

- **Every call names its workspace.** Every tool requires `workspace_id` except `workspaces` action
  `list`, and `search` and `retrieve`, which take `workspace_ids` instead
  ([Searching several workspaces](#searching-several-workspaces)). There is no default workspace.
- **No tool takes a node.** A `workspace_id` is unique everywhere, so it already says which node.
- **An id the connection cannot use is refused with one sentence**, `workspace is not available to
  this connector`, whether it does not exist, is outside the credential's workspaces, or its person
  is no longer a member there, so a credential cannot probe which ids exist.
- **`access`** is what the connection may do there: `read`, or `propose` changes. `role` is the
  person's role in the workspace.
- **`contract`** is the version of the tools. It goes up when a change would break an agent, a skill
  or a router written against the previous one.

The server instructions open with a routing rule, then name the node and how many workspaces the
connection reaches, and carry a table of up to 20 of them. When the connection reaches exactly one
workspace, that workspace's [instructions for agents](#instructions-for-agents) follow; otherwise
they point at `workspaces` action `instructions`.

Nodes never talk to each other, so every workspace in the listing is on the node the connection is
to, and its `unavailable` is empty. An agent that works with two nodes is set up on each: the second
connection is added by hand under another name, because a client cannot hold two entries called
`stuga`. In the Claude Code command write `stuga-work` in place of `stuga`; in a pasted JSON config,
change the key; for the Codex and Antigravity installers, run the command as
`curl -fsSL '…' | STUGA_SERVER=stuga-work sh`. The installers refuse to touch an entry whose name is
already taken by another server, rather than replace it. The Claude Desktop extension is one
extension, `stuga`, whichever node it came from: installing another node's replaces it, and its
**Stuga address** setting says which node it reaches.

The shortcuts to other nodes in a person's workspace switcher are theirs alone: `/api/me/nodes`
refuses API keys, so an agent reaches another node only by being connected to it.

## Apps that sign in

A client that supports OAuth signs in through the browser: Claude Code, Codex, Antigravity, Claude
on the web, and the Claude Desktop extension or `stuga-mcp` without a key. You sign in to the node
with your password or through its identity provider, and the consent page asks two things:

- **Workspaces.** Every workspace you belong to other than as a guest is ticked. **Also workspaces I
  join later** covers every workspace you belong to, now and later. An agent never acts in a
  workspace where you are only a guest, whatever you ticked.
- **Access.** **Read and suggest changes**, or **Read only**.

The page names the app. An app that identifies itself by a metadata document the node fetched is
shown as **Verified by** that document's host; any other is an **Unverified app**, with the host it
returns to.

Each consent creates a connection: one per person per app. Signing in again as the same client (the
same `client_id`) renews it with your new answers and keeps its name and its agent, so its runs stay
under one agent. It acts as its own agent for you, and the rules for agents under
[API keys](#api-keys) apply to it.

**Connected agents**, under **Settings → Your own AI**, lists each connection as *signed in*, with
`verified by <host>` for a verified app, and a badge when it reaches fewer workspaces than you
belong to or only reads.

- **Rename** changes how its runs are attributed.
- **Revoke** ends every token it holds at once. Its next call is refused, and the app asks you to
  sign in again. A revoked connection stays in the list.
- **Leaving a workspace** takes it out of every connection that named it, and a connection left
  naming none is revoked. One made for workspaces you join later keeps following you.

An app holds an access token (`sto_…`) that lasts an hour, and renews it with a refresh token
(`str_…`) that is replaced every time it is used. A refresh token unused for 90 days lapses, and a
sign-in ends a year after it happened however often it refreshed; either way the app asks you to
sign in again. A refresh token presented again within
`REFRESH_ROTATION_GRACE_SECONDS` (60 by default) of its use is one app refreshing twice at once, and
gets a pair of its own; presented later, it ends the tokens of that sign-in, because someone else
holds a copy. The node stores only their hashes. These tokens work only
on `/mcp`; the REST API refuses them. The OAuth routes are in [api.md](api.md#agents-over-oauth).

## Claude Code

```sh
claude mcp add -s user --transport http stuga http://localhost:8787/mcp
```

Use your node's origin in place of `http://localhost:8787`; **Your own AI** fills it in. `-s user`
adds the connection once for every project. Then run `/mcp` in Claude Code, pick **stuga**, and choose
Authenticate. You sign in to your node in the browser and choose its workspaces and access, and no
key is pasted ([Apps that sign in](#apps-that-sign-in)).

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

In Claude, open Settings → Connectors → **Add custom connector** and paste the MCP endpoint
**Your own AI** shows (`<PUBLIC_ORIGIN>/mcp`). Claude asks you to sign in to Stuga, and the
connection appears under **Connected agents**.

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

Both hosts register themselves with the node and sign in like any app
([Apps that sign in](#apps-that-sign-in)). They differ in where the sign-in starts. Codex performs
OAuth while the installer runs `codex mcp add --url`; use `codex mcp login` only to sign in again
later. Antigravity has no such command — its OAuth runs inside the IDE and ends by pasting a code
back from a hosted callback — so it shows **Authenticate** beside the server until you click it once,
and reports `Unauthorized` until then.

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

Neither revokes anything: the connection lives on the node. Revoke it under **Connected agents**,
then restart the host.

## Claude Desktop

In **Your own AI**, open **Claude Desktop** and click **Add to Claude Desktop**. Double-click the
downloaded `stuga.mcpb` and click **Install**. The extension asks for:

- **Stuga address**, filled in with the node the file came from.
- **Access key**, optional. Leave it empty to sign in through the browser.

Then quit Claude completely and open it again. Closing the window leaves it running. When Claude
first starts the extension without a key, the node's consent page opens in your browser; approve it
and the tools appear.

The file carries no key, so it is safe to pass around. It is one extension for every node:
installing another node's replaces it, and changing **Stuga address** in Claude's extension settings
points it at another node.

If the tools do not appear, quit Claude fully and reopen it, then read the extension's
`mcp-server-*.log` in `~/Library/Logs/Claude/` (on Windows, `%APPDATA%\Claude\logs\`).

### Setting it up by hand

When the node's `PUBLIC_ORIGIN` is a loopback address, so the browser and the node share a machine,
**Your own AI** also offers **Set it up by hand instead**: a `claude_desktop_config.json` entry with
a key you mint there, the absolute path of the Node interpreter running the node, and the absolute
path of the node's stdio server. Paste it in Claude Desktop under Settings → Developer →
**Edit Config**. Paths are absolute because desktop clients start servers without your shell's
`PATH`. Without `STUGA_TOKEN`, the server signs in through the browser instead.

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

## The stdio server

`stuga-mcp.js`, which the Claude Desktop extension runs, forwards to the node's `/mcp`: the tools,
their wording, the instructions and every check are the node's own, whatever its version. It adds
one thing only a process on your machine can do: `databases_add` action `import` also takes `file`,
a CSV or JSONL path on that machine. The server stages the import with `start_import`, uploads the
file and commits it, and hands the agent the table's Import dialog link when the file is larger than
the node accepts.

With `STUGA_TOKEN` set, it sends that key. Without one, it signs in through the browser: it registers
itself with the node, opens the consent page (and writes its address to stderr), and takes the answer
on a one-off loopback address. The tokens are kept per node address in `~/.config/stuga/oauth.json`,
readable only by you. When the node stops accepting them, the server opens a new sign-in.

At startup it waits up to three seconds for the node, so the instructions a client keeps are the
node's. When the node has not answered by then, the server starts with instructions that say it is
still connecting, and announces the tools once the node answers. A tool call waits up to 50 seconds
for the node or the sign-in, then says what it is waiting for.

It reads these settings:

| Variable | File field | Default | |
|---|---|---|---|
| `STUGA_URL` | `url` | `http://127.0.0.1:8787` | The node's origin. |
| `STUGA_TOKEN` | `token` | none | An API key. Without one, the server signs in through the browser. |
| `STUGA_MODEL` | `model` | none | A model label, sent as `x-stuga-model` and shown beside the agent's runs. |
| `STUGA_CLIENT` | `client` | `stuga-mcp` | A client label, sent as `x-stuga-client`. It also names the connection a sign-in creates: **Claude Desktop** for `claude-desktop`, which the extension sets, and **Stuga local connector** for the default. |
| `STUGA_NODE_NAME` | `node_name` | the host of `STUGA_URL` | The node's name, for when the node cannot be asked. At startup the server asks the node's public `/auth/config` for its current name and its `PUBLIC_ORIGIN`, which win. |
| `STUGA_VERSION` | `version` | `0.0.0-dev` | The version the server reports. The extension sets the node's. |

Each setting comes from the environment first. A value left as an unfilled `${user_config.…}`
placeholder counts as unset. When the environment sets both `STUGA_URL` and `STUGA_TOKEN`, only the
node's name can still come from a file: `node_name` in `config.json` beside the server file, when
the environment has no `STUGA_NODE_NAME` and the file's `url` is `STUGA_URL`. Otherwise each missing
setting is taken from `config.json`, then from `~/.config/stuga/credentials.json`, and a file's
`token` only for the node that file names, or when it names none. Both files are JSON objects with
the field names above. The extension writes its address, client label and version to `config.json`
as well as to its launch environment, because a client does not always pass that environment to the
process it starts.

## DeepSeek Harness

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) reaches the node over
`/mcp` with a key. The `@stuga/dsh-plugin` package installs into a dsh profile and adds what a bare MCP
connection lacks: playbook skills for research, edits and databases, and a system-prompt section that
carries the workspace's instructions for agents, explains that a `Proposed` result is success and
must not be retried, and says to follow the instructions that come back with a document
([below](#instructions-for-agents)).

In **Your own AI**, open **DeepSeek Harness** and mint a key. Then, on the machine that runs dsh:

```sh
dsh plugin --profile web add @stuga/dsh-plugin
```

Put `STUGA_URL` (the node's origin) and `STUGA_API_KEY` (the key) in `$DSH_HOME/.env` or in the
environment that launches dsh, and restart `dsh web`. **Your own AI** prints both lines with the key
filled in. The harness's runs appear in the review inbox labelled `deepseek-harness`, under the key's
name.

dsh's MCP client has no browser sign-in, so the key is static and its owner reviews everything the
harness proposes. Mint one key per person rather than sharing one.

## API keys

Mint a key in **Your own AI**, or with `POST /api/keys` ([api.md](api.md#authentication)). A key
looks like `vk_<id>_<secret>`. The secret is shown once, and the node stores only its hash. An app
that signs in gets no key: its sign-in is a connection ([above](#apps-that-sign-in)).

- **A key acts for the person who minted it.** Its reach is its owner's live reach: the owner's
  principals and role are read again on every request, so a guest's key is a guest's, and a key
  whose owner has left the workspace fails on its next request. Removing a member also revokes the
  keys they minted in that workspace.
- **Where a key acts.** Over REST, in the workspace it was minted in. On `/mcp`, a key that is not
  confined to folders reaches every workspace its owner belongs to other than as a guest, at the
  owner's role in each, and `workspaces` action `list` names them. A key confined to folders reaches
  only its own workspace.
- **An agent has its own principal**, `agent:<id>`. A document an agent creates is owned by its human,
  shared with the agent as a writer, and gets the workspace's default access like one the human
  creates. What the agent writes in it waits for review, as on any new document.
- **Content only.** Agents change documents and databases through the run ledger. Renaming, moving,
  trashing and deleting items, sharing, locks, the agent-changes setting, and workspace and key
  management all refuse agents, because none of them leaves a run to revert.
- **Collections are the exception.** A collection only scopes search and AI, so an agent with write
  access creates, renames and deletes its person's collections and adds and removes their members,
  and a read-only one lists and opens them. The person sees every change, and the audit ledger names
  the agent and the person it acted for ([collections.md](collections.md)).
- **A key can be narrowed below its owner's reach**: confined to folders (each with its subtree),
  made read-only, or given an expiry. **Your own AI** sets these when a key is minted, and
  `PATCH /api/keys/:id` changes them later. A narrowing only removes reach. A folder-scoped key's
  listings, search, retrieval and events are filtered to its folders, and a document elsewhere reads
  as not found. A read-only key reads and searches everything its owner can reach and changes
  nothing ([below](#read-only-credentials)).
- **Rotate** gives a key a new secret and keeps its identity, so its runs and audit rows still name
  the same agent. **Revoke** stops it on its next request. **Rename** changes how it is attributed:
  a key is minted under the name of the client it is for, so rename one when the same client is
  connected twice.
- `STUGA_TOKEN`, `/mcp` and the REST API also accept a person's access token, which acts as that
  person. It expires within an hour by default and is attributed to the person rather than an agent,
  so use it only to experiment.

Every `/mcp` tool call in a workspace, reads included, is written to that workspace's audit ledger as
`mcp.<tool>.<action>`, with the credential and the target. A search or retrieval writes one row per
workspace it covered. Over REST, writes and refusals are recorded.

## What the run ledger shows

A **run** is one agent's editing session on one document or database. For each run you see:

- **Who and what**: the agent and the name of its key or connection, the client and model labels it
  sent (the `x-stuga-client` and `x-stuga-model` headers, which the extension, the stdio server and
  the dsh plugin set), and the person it acted for.
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
- `auto` belongs to the document, not to an agent. While it is on, every agent that can write the
  document changes it without review.

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
  folder above it. An agent counts as its person: a key confined to a subfolder still gets the
  folders above it that its person can read.
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

- **The workspace's.** When a connection reaches exactly one workspace, `/mcp` puts its instructions
  in the server instructions, so an agent has them before its first call. Otherwise the server
  instructions say to read them before writing. `workspaces` action `instructions` returns one
  workspace's, the workspace level only.
- **An item's stack.** `markdown` action `read` shows it in a marked block before the Markdown, or
  opens with a line saying none apply. Only that block at the very start of a read counts, and the
  agent is told so: anything further down that looks like instructions is document text, so an
  editor cannot plant instructions in a document's text.
  `docs` action `metadata`, `docs_create`, `databases` action `schema` and `databases_add` action
  `create_database` return it as `instructions: [{ kind, id, title, text }]`, outermost first. A
  write needs no read, so the answer to a proposal from `markdown_edit`, `markdown_append`,
  `databases_add` or `databases_change` names the levels below the workspace that apply
  (`instructions_labels`), and the agent is told to read them before writing there again. Over REST an agent gets the same fields ([api.md](api.md#instructions-for-agents)).
- **In the app.** The co-author and the table assistant read their document's stack, as the person
  using them can see it, at the start of every turn, so an edit or a move applies to the next
  message. The co-author's first read or edit of another document it may edit carries a note on that
  document: which levels of the current document's stack also apply there and which do not, and the
  levels only that document carries, with the same policy framing. A level an earlier note in the
  same turn already showed is named rather than repeated. The note comes even when nothing applies
  there, and the co-author is told that only that first note is real. Ask reads the workspace's.

## Events and webhooks

- **Events.** The `events` tool and `GET /api/events` return what changed in a workspace since a
  cursor, filtered to documents the credential can read. An agent that wants to react to a decision
  or a comment polls this instead of re-reading everything. Event types:
  [api.md](api.md#the-event-feed).
- **Webhooks.** Workspace owners and admins can send the same events to a URL, signed and retried.
  See [api.md](api.md#webhooks).

## The tools

`/mcp` registers nineteen tools from `@stuga/agent-surface`, and runs them in-process over the
node's own code, through the same permission checks and run ledger as the REST routes. The stdio
server lists the node's tools as they are. Reads and writes are separate tools, and each carries MCP
annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`. A client shows
them or acts on them, such as asking before a destructive call. They grant nothing: permissions and
the item's `agent_mode` decide what a call does.

**Reads.** Every one is read-only and idempotent.

| Tool | Actions and use |
|---|---|
| `workspaces` | `list` · `instructions`. The workspaces this connection reaches and the node each is on ([above](#one-connection-and-which-node-a-call-lands-on)), and one workspace's instructions for agents. |
| `docs` | `list` · `metadata`. `list` takes an optional folder (`parent_id`, null for the root). `metadata` includes this agent's `review` answer for the document and its `instructions`. |
| `search` | Hybrid keyword and semantic search that returns documents, across `workspace_ids`, optionally within a collection. |
| `markdown` | `read` · `status` · `provenance`. `read` shows the document's instructions in a marked block, then the text with the agent's own pending edits. `status` reports what became of its edits. |
| `comments` | A document's comments. |
| `folders` | The folders the credential can read in the workspace. |
| `events` | What changed in the workspace since `after`, optionally narrowed by `types`. Without `after` it starts from the newest event. |
| `collections` | `list` · `open`. The saved document sets of the credential's person, which `search` and `retrieve` can be scoped to. `open` lists the members the credential can read ([collections.md](collections.md)). |
| `retrieve` | The passages most relevant to a question across `workspace_ids`, with their sources, optionally within a collection ([rag-cross-doc-qa.md](rag-cross-doc-qa.md)). |
| `databases` | `list` · `schema` · `status` · `page`. `schema` returns tables, columns with their physical SQL names and `description` (what the column holds, written by the people here), saved views and the database's `instructions`. `page` returns the `doc_id` of a row's page, or null when it has none. |
| `query` | One read-only `SELECT` (SQLite dialect) against one database, with `?` parameters. At most 8 KB of SQL, 1,000 rows, 1 MB per value and five seconds of work. `WITH RECURSIVE` is refused, because a recursive query that never ends cannot be stopped. |

**Writes.** None is idempotent. *Destructive* ones may replace or remove what exists; *open-world*
ones may make the node download an image from the web.

| Tool | Actions and use | Destructive | Open-world |
|---|---|---|---|
| `docs_create` | A document with a title, optionally in a folder. Returns its `instructions`. | no | no |
| `markdown_append` | Adds text at the end of a document, or of the section under `heading`, and touches nothing else. | no | yes |
| `markdown_edit` | `write` · `str_replace` · `cited_edits`. `write` replaces the whole document, `str_replace` swaps `find` for `replace` (one occurrence, or all with `replace_all`), and `cited_edits` makes several exact edits at once with citations that become footnotes. | yes | yes |
| `comments_add` | A comment on a document. Its people are notified. | no | no |
| `media_upload` | `upload` · `upload_from_url`. Stores an image, from base64 of up to 3 MB or from a public URL the node downloads, and returns its path for Markdown. | no | yes |
| `collections_edit` | `create` · `rename` · `delete` · `add_items` · `remove_items`. `add_items` skips ids the credential cannot read and says how many. | yes | no |
| `databases_add` | `create_database` · `create_table` · `add_column` · `insert_rows` · `import` · `start_import` · `create_view` · `open_page`. `add_column` may set a column's `description`. `import` loads a whole CSV or JSONL file as one reviewable change, from its text in `content` or from an upload by `import_id`, so bulk data never passes through `insert_rows`. `start_import` returns an `upload_url` for a caller that can send the file itself, and the `import_id` to commit. `open_page` returns a row's page, a document read and edited like any other, and creates it the first time. | no | no |
| `databases_change` | `update_rows` · `delete_rows` · `update_view`. | yes | no |

Edits to a document's text and to a database are proposals. Writing `![alt](https://…)` or a `data:`
URI through `markdown_edit` or `markdown_append` downloads and stores the image, behind the node's
outbound address checks. A mention of a person reads and writes as `[@username](mention:<alias>)`;
keep it as written, and once an edit lands, a newly mentioned person who can read the document is
notified. The answer to a proposal names the instructions that apply beyond the workspace's.

When a file is too large to carry, `import` hands the agent a link to the table's Import dialog to
give the person. The stdio server also takes a local `file` ([above](#the-stdio-server)).

### Searching several workspaces

`search` and `retrieve` take `workspace_ids`: from 1 to 50 ids from `workspaces` action `list`, or
`["*"]` for every workspace the connection reaches.

- Each workspace is searched on its own, under its own permissions. Scores from different workspaces
  do not compare, so the answers are merged by rank: each workspace's first result, then each one's
  second, and so on. Scores are left out.
- Each result names its `workspace_id` and carries a `url` that opens the document.
- `collection_id` narrows a search of exactly one workspace.
- `unavailable: [{ workspace_id, reason }]` lists each workspace the call could not cover: one the
  connection cannot use, or, for `retrieve`, one where search by meaning is off. The agent is told
  to say so and never to present the rest as complete. When the only workspace named fails, its
  reason is the tool's error.

### Read-only credentials

A read-only key, or a connection given **Read only**, is offered the eleven reading tools and
nothing else. The server instructions say that it may change nothing, and to tell the user what it
would change instead. `workspaces` action `list` reports `access: "read"`. A write tool it names
anyway is unknown to it, and the node's own read-only check stands behind that. Ask over REST is a
read too, and a read-only key keeps its own Ask threads ([api.md](api.md#read-only-keys)).

Two rules hold whatever a client does:

- Raw Yjs writes from an agent's socket are refused (`approval_required`). Proposals are the only way
  an agent changes content.
- A successful proposal is recorded even while review is pending. An agent that sees no change on
  re-read is looking at its own pending edits, not a lost write. The tool results say `Proposed` and
  tell the agent not to retry.
