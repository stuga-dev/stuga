# Agents and MCP

Stuga treats AI agents as users with their own write path. An agent connects over MCP, reads and
searches whatever its credential reaches, and proposes changes. Every content write goes through the
run ledger, where it is attributed, shown change by change, and waits for review unless the document
is set to let AI edits apply directly. This page covers connecting clients, credentials, the tools,
and what the ledger shows.

**Settings → Your AI agents** in Stuga has the setup for the node you are running, with its address already
filled in: pick the app under **App**. Use it when it disagrees with an example here.

## Which clients can reach a node

- **Claude Code, Claude Desktop, and other MCP clients on your own machine** work with any node they
  can reach, including one on `localhost` or your local network. Claude Code dials the node's `/mcp`
  endpoint. Its browser sign-in needs the node on https or on loopback, so on a plain-http network
  address **Your AI agents** gives it a command carrying a key instead. Claude Desktop runs Stuga's
  stdio server from an extension, and the server forwards to the node's `/mcp`. The
  [Stuga plugin](#the-stuga-plugin) runs the same server in Claude Code and in Cowork, and signs in
  through the browser at any address.
- **Codex and Google Antigravity** dial the node's `/mcp` endpoint and work with any node the machine
  can reach. **Your AI agents** gives one command per host that installs the Stuga Skill and adds the
  node; both hosts sign in through the browser, so no key is pasted.
- **Pi** dials the node's `/mcp` endpoint through pi-mcp-adapter and works with any node the machine
  can reach. It signs in through the browser, or takes a key ([Pi](#pi)).
- **Cursor, VS Code, Kiro, Goose and LM Studio** dial the node's `/mcp` endpoint and work with any node
  the machine can reach. **Your AI agents** gives each a link that adds the node
  ([Apps that install from a link](#apps-that-install-from-a-link)).
- **Claude on the web and on mobile** add custom connectors that Anthropic's cloud dials. Those need
  the node at a public HTTPS origin: `PUBLIC_ORIGIN`, or its [remote address](remote-access.md).
  **Your AI agents** offers **Claude** while remote access is on, with the remote address's `/mcp`, and
  otherwise only when `PUBLIC_ORIGIN` is https and not a loopback, private or local-network address.
  Ways to give a node a public HTTPS origin are in [network-access.md](network-access.md#https).

Apps on your own machine get the address the page is open at: `PUBLIC_ORIGIN` anywhere on the
network, so they never go round by the relay, and the remote address when the page was opened there.

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

A client that supports OAuth signs in through the browser: Claude Code, Codex, Antigravity, Cursor,
VS Code, Kiro, Goose, LM Studio, Pi, Claude on the web, and the Claude Desktop extension or
`stuga-mcp` without a key. You sign in to the node with your password or through its identity
provider, and the consent page asks two things:

- **Workspaces.** Every workspace you belong to other than as a guest is ticked. **Also workspaces I
  join later** covers every workspace you belong to, now and later. An agent never acts in a
  workspace where you are only a guest, whatever you ticked.
- **Access.** **Read and suggest changes**, or **Read only**.

At the [remote address](remote-access.md), allowing an app takes a sign-in from the last five
minutes, or confirming it is you (with a passkey there, if you have one), as an API key does, and
you are notified that the app is connected.

The page names the app. An app that identifies itself by a metadata document the node fetched is
shown as **Verified by** that document's host; any other is an **Unverified app**, a warning callout
naming the host it returns to, or "an app on this computer" for a loopback address.

Each consent creates a connection: one per person per app. Signing in again as the same client (the
same `client_id`) renews it with your new answers and keeps its name and its agent, so its runs stay
under one agent. It acts as its own agent for you, and the rules for agents under
[API keys](#api-keys) apply to it.

**Connected agents**, under **Settings → Your AI agents**, lists each connection as *signed in*, with
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
on `/mcp`; the REST API refuses them. They also work only at the address where you consented: with
remote access on, connect apps to the remote address, which works on your network too. The OAuth
routes are in [api.md](api.md#agents-over-oauth).

## Claude Code

```sh
claude mcp add -s user --transport http stuga http://localhost:8787/mcp
```

Use your node's origin in place of `http://localhost:8787`; **Your AI agents** fills it in. `-s user`
adds the connection once for every project. Then run `/mcp` in Claude Code, pick **stuga**, and choose
Authenticate. You sign in to your node in the browser and choose its workspaces and access, and no
key is pasted ([Apps that sign in](#apps-that-sign-in)).

That sign-in only works when `PUBLIC_ORIGIN` is https or a loopback address. Claude Code refuses to
send a credential to a token endpoint that is neither, so on a node at a plain-http network address,
such as `http://nas.local:8787`, **Your AI agents** names a key in the command instead:

```sh
claude mcp add -s user --transport http stuga http://nas.local:8787/mcp \
  --header "Authorization: Bearer vk_..."
```

Name the agent under **Claude Code** and the command comes back with its key in place. The key
is stored in Claude Code's own configuration file in plain text, and is revoked in **Your AI agents**
like any other. Giving the node [an https address](network-access.md#https) brings the browser
sign-in back.

### The Stuga plugin

The plugin carries the Stuga Skill and runs the [stdio server](#the-stdio-server) with `npx`, so it
needs Node.js 18 or newer. Each release publishes it from [integrations/](../integrations/) to
[stuga-dev/stuga-plugin](https://github.com/stuga-dev/stuga-plugin), pinned to that release's
`@stuga/mcp`:

```
/plugin marketplace add stuga-dev/stuga-plugin
/plugin install stuga@stuga
```

Claude Code asks for **Stuga address**; keep `http://127.0.0.1:8787` when the node runs on the same
computer. From a shell, `claude plugin install stuga@stuga --config node_url=http://nas.local:8787`
sets it instead. The first time Claude uses a tool, the node's consent page opens in your browser,
whatever the node's address, and the connection is listed as **Claude**. Its tools are named
`mcp__plugin_stuga_stuga__<tool>`.

Each new, cleared or compacted session starts with an index of the wiki pages Claude can read:
their ids, titles, folders and dates, team pages first and your own [My notes](#my-notes) after
them, in at most 9,000 characters. Your newest notes keep their place however many team pages there
are, and the index says how many notes you have. A resumed session gets none. The plugin's hook asks the node's
[`GET /api/agent/session-index`](api.md#the-session-index) with the connection's own sign-in,
refreshing it when it has expired, and the session starts without the index when the node does not
answer within two and a half seconds or nobody has signed in yet.

In Cowork on your computer the plugin runs the same server against `http://127.0.0.1:8787`, since
Cowork does not ask for plugin settings. Claude on the web loads only its skill.

## Claude on the web

In Claude, open Settings → Connectors → **Add custom connector** and paste the MCP endpoint
**Your AI agents** shows: `<PUBLIC_ORIGIN>/mcp`, or the remote address's `/mcp` while
[remote access](remote-access.md) is on. Claude asks you to sign in to Stuga, and the
connection appears under **Connected agents**.

## Codex and Google Antigravity

Both hosts set up from one command, shown under their name in **Your AI agents**:

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

Open **Uninstall from Codex** or **Uninstall from Antigravity**, which shows two commands.
The first disconnects this node and keeps the Skill, for a computer that reaches more than one Stuga
node; the second removes the Skill too, for the last node on that computer.

```sh
curl -fsSL 'http://localhost:8787/api/agent-install/codex?action=disconnect' | sh
curl -fsSL 'http://localhost:8787/api/agent-install/codex?action=uninstall' | sh
```

Neither revokes anything: the connection lives on the node. Revoke it under **Connected agents**,
then restart the host.

## Claude Desktop

In **Your AI agents**, open **Claude Desktop** and click **Add to Claude Desktop**. Double-click the
downloaded `stuga.mcpb` and click **Install**. The extension asks for:

- **Stuga address**, filled in with the node the file came from.
- **Access key**, optional. Leave it empty to sign in through the browser.

Then quit Claude completely and open it again. Closing the window leaves it running. When Claude
first starts the extension without a key, the node's consent page opens in your browser; approve it
and the tools appear. When Claude first asks to use **Save to Stuga**, choose **Always allow**.

The file carries no key, so it is safe to pass around. It is one extension for every node:
installing another node's replaces it, and changing **Stuga address** in Claude's extension settings
points it at another node.

If the tools do not appear, quit Claude fully and reopen it, then read the extension's
`mcp-server-*.log` in `~/Library/Logs/Claude/` (on Windows, `%APPDATA%\Claude\logs\`).

### Setting it up by hand

When the node's `PUBLIC_ORIGIN` is a loopback address, so the browser and the node share a machine,
**Your AI agents** also offers **Set it up by hand instead**: a `claude_desktop_config.json` entry with
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

## Apps that install from a link

Cursor, VS Code, Kiro, Goose and LM Studio add a server from a link. **Your AI agents** builds one per app
with the node's `/mcp` endpoint in it: **Add to Cursor** opens Cursor with the server, named `stuga`,
ready to install, and the app signs in through the browser when it first connects. To use a key
instead, open **Use an agent key instead**, mint one, and follow **Add to … with this key**; Goose's link
cannot carry a key. Removing the server in the app revokes nothing: revoke the connection or the key
under **Connected agents**.

## Other MCP clients

Any client that speaks Streamable HTTP can use `<PUBLIC_ORIGIN>/mcp`. A client that supports OAuth
signs in like Claude Code. Any other client sends a key as `Authorization: Bearer vk_...`, and the
**Other apps** in **Your AI agents** builds that config.

## The stdio server

`stuga-mcp.js`, which the Claude Desktop extension and the Stuga plugin run, forwards to the node's
`/mcp`: the tools, the prompts, their wording, the instructions and every check are the node's own,
whatever its version. It adds one thing only a process on your machine can do: read a file there.
`databases_add` action `import` takes `file`, a CSV or JSONL path on that machine; the server stages
the import with `start_import`, uploads the file and commits it, and hands the agent the table's
Import dialog link when the file is larger than the node accepts. `media_upload` action `upload`
takes `file`, any path on that machine; the server stages it with `start_upload`, sends it, and
stores it, named as the path names it unless the agent passes `name`.

Each release publishes it to npm as `@stuga/mcp`, so any client that starts local servers runs it
with `npx -y @stuga/mcp` and `STUGA_URL` set to the node's address.

With `STUGA_TOKEN` set, it sends that key. Without one, it signs in through the browser: it registers
itself with the node, opens the consent page (and writes its address to stderr), and takes the answer
on a one-off loopback address. The tokens are kept per node address in `~/.config/stuga/oauth.json`,
readable only by you. When the node stops accepting them, the server opens a new sign-in.

At startup it waits up to three seconds for the node, so the instructions a client keeps are the
node's. When the node has not answered by then, the server starts with instructions that say it is
still connecting, and announces the node's tools and prompts once the node answers. A list of tools
or prompts waits two seconds for the node. While the node is out of reach or the sign-in waits, it
answers with the lists the node last gave this connection, kept per node address and key in
`~/.config/stuga/catalog.json`, readable only by you; before the node has ever answered, with every
tool and prompt of the server's own version. A client that lists them once at launch still has them.
An error the node answers with is passed on as the node gave it, and a node too old for prompts lists
none. A tool call waits up to 50 seconds for the node or the sign-in, then says what it is waiting
for, and nothing is sent.

It reads these settings:

| Variable | File field | Default | |
|---|---|---|---|
| `STUGA_URL` | `url` | `http://127.0.0.1:8787` | The node's origin. |
| `STUGA_TOKEN` | `token` | none | An API key. Without one, the server signs in through the browser. |
| `STUGA_MODEL` | `model` | none | A model label, sent as `x-stuga-model` and shown beside the agent's runs. |
| `STUGA_CLIENT` | `client` | `stuga-mcp` | A client label, sent as `x-stuga-client`. It also names the connection a sign-in creates: **Claude Desktop** for `claude-desktop`, which the extension sets, **Claude** for `claude`, which the plugin sets, and **Stuga local connector** for the default. |
| `STUGA_NODE_NAME` | `node_name` | the host of `STUGA_URL` | The node's name, for when the node cannot be asked. At startup the server asks the node's public `/auth/config` for its current name and its `PUBLIC_ORIGIN`, which win. |
| `STUGA_VERSION` | `version` | the version it was built as | The version the server reports. The extension sets the node's. |

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

In **Your AI agents**, open **DeepSeek Harness** and mint a key. Then, on the machine that runs dsh:

```sh
dsh plugin --profile web add @stuga/dsh-plugin
```

Put `STUGA_URL` (the node's origin) and `STUGA_API_KEY` (the key) in `$DSH_HOME/.env` or in the
environment that launches dsh, and restart `dsh web`. **Your AI agents** prints both lines with the key
filled in. The harness's runs appear in the review inbox labelled `deepseek-harness`, under the key's
name.

dsh's MCP client has no browser sign-in, so the key is static and its owner reviews everything the
harness proposes. Mint one key per person rather than sharing one.

`dsh plugin --profile web remove @stuga/dsh-plugin` removes the plugin. It revokes nothing: revoke
the key under **Connected agents**.

## Pi

[Pi](https://pi.dev) has no MCP client of its own, so it reaches the node through
[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). The `@stuga/pi-package` package
registers the node with the adapter as `stuga`, and adds playbook skills for research, edits and
databases plus a system-prompt section on how calls are routed and reviewed. On the machine that runs
Pi:

```sh
pi install npm:pi-mcp-adapter
pi install npm:@stuga/pi-package
export STUGA_URL=http://localhost:8787
```

Use your node's origin; **Your AI agents** fills it in under **Pi**. Set `STUGA_URL` in the shell
that starts Pi, or put `{ "stuga": { "url": "…" } }` in `~/.pi/agent/settings.json`. Then start Pi
and run `/mcp-auth stuga`: you sign in in the browser ([Apps that sign in](#apps-that-sign-in)), at
any node address, and the connection is listed as **Pi**. To use a key instead, open **Use an agent
key instead** under **Pi**, mint one, and set `STUGA_API_KEY` beside `STUGA_URL`; there is then no
sign-in step. Pi's runs appear in the review inbox labelled `pi`.

`pi remove npm:@stuga/pi-package` removes the package and leaves the adapter. It revokes nothing:
revoke the connection or the key under **Connected agents**.

## API keys

Mint a key in **Your AI agents**, or with `POST /api/keys` ([api.md](api.md#authentication)). A key
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
  made read-only, or given an expiry. **Your AI agents** sets these when a key is minted, and
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
  once, or reverted. Undo after a decision puts its hunks back to pending.

While a run has pending hunks, their content appears only in the overlay of the people who review
it: its reviewer, or at `colleague` the people who may approve it. Other collaborators never see
pending agent text, and their own edits continue as usual. Accepted hunks merge block by
block, so surrounding structure and other people's changes survive.

An agent is never blocked on review. A proposal returns immediately, the agent's later reads include
its own pending edits, and `markdown` or `databases` action `status` reports what was decided.

## Reject with a note

**Reject with note…** rejects with a note saying what should change: under a single change in the
document, where the note is written in place of its buttons and stays until that change is decided,
from **Review each**, or from the menu beside the run bar's **Reject all**. The button that opens the
note and the one that sends it carry the same words. The review card's and the inbox's **Ask for
changes…** do the same for a whole run. The note is
kept with each change it rejected, and it reaches the agent that proposed them where that agent
already looks:

- **Its reads of that document** (for a database, its schema and query results) open with the
  reviewer's feedback (what was rejected and the note), and **every proposal it makes there** carries
  it again, until the agent answers it: a proposal that names the feedback's ids in `revises` is the
  revision, and from then on only `status` shows it. Proposing something else answers nothing. It
  stops leading reads after 14 days, or sooner once the run is marked reviewed: **Mark as reviewed**
  in the inbox, offered on a run with changes applied at once and not yet looked at, or
  `POST /api/docs/:id/runs/:run/ack` ([API](api.md#for-people-only)) on any run.
- **`markdown` or `databases` action `status`** lists each rejection and its note under its run.
- **`events` with `mine: true`** lists the decisions on the agent's own proposals across the
  workspace, the last 14 days of them without a cursor. A `run.decided` event with a `feedback_id` is a
  rejection with a note; the note itself is in `status`, since the feed reaches every agent that can
  read the document.

The in-app co-author hears its rejections at the start of its next turn. On its runs in the
document, with AI chat on, the note button is **Revise…** (**Revise all…** for the whole run): a turn that may change existing
text only inside the passages that rejection covered, followed through its own edits. While a turn is running, the revision waits for it
to end, and every request made meanwhile is answered in one turn; after **Stop** they wait for
**Revise now**. It may add text anywhere, so it can move what was
rejected. A change it tries to other existing text, or to another document, is refused, and it says
so instead of making it. When the document has changed so that the rejected passages can no longer
be found, every change to existing text is refused and it asks you to revise again.

A note is advice to the agent, like an instruction. It decides nothing about what a later write may
do; review mode and permissions do. A rejection carries one, and so does a revert: **Revert with
note…** in the inbox takes back a run that landed, on an `auto` document for instance,
and tells the agent why, the same way.

## Agent changes: wait for review, or apply at once

Whether an agent's change waits depends on the level of the document or database it changes,
`agent_mode`:

| Level | In the app | Meaning |
|---|---|---|
| `auto` | AI edits apply directly | The change applies at once. It is still recorded, attributed, notified and revertible. |
| `review` | Reviewed by whoever asked the AI | The default. The change waits for the person who asked the AI, for as long as that takes. They are notified, and their decision lands it. |
| `colleague` | Reviewed by a colleague | The change waits for someone else who can edit the item, a workspace admin included. The person who asked the AI never approves it. |

A folder gives its level to everything in it, folders inside it included: `review` unless it is set
to another. A document, database or folder follows its folder until it is set itself, and a
database's row pages are reviewed at least as strictly as the database. Its owner, or a workspace
admin, can make it stricter than its folder, as can the owner of a folder above it, who so undoes a
looser level they set; only the owner of the folder that sets the level, or a workspace admin, can
make it looser, and owning a stricter folder inside another lets nobody go looser than the outer
one. A level an item's owner set above its folder's stays theirs to give up. Making an item looser
than its folder, or a folder looser, notifies the workspace's other admins who can read it. Agents
never change a level.

A move takes an item, and everything in a folder, out from under the folders it leaves. It must not
let the mover alone review AI edits to anything it moves more loosely than they could before: not at
once, and not later by setting a level where it lands, in a folder of their own or, for what they
own, at the top level. Such a move takes the item's owner, the owner of the folders it leaves, or a
workspace admin. A folder's default `review`, which no folder sets, is no bar to leaving it. A row
page counts here without its database's level. An item at `colleague` moves out from under an
approver group someone else names only to where that group still applies. A move that loosens
a level is in the audit ledger, and notifies the workspace's other admins who can read the item. A
level looser than its folder's belongs to that place: an item moved into another folder follows that
folder. Deleting a folder puts everything in it in the trash, filed in the folder above, so it stays under
the levels set there.

The level is set from **Who reviews AI edits…**, in the ⋯ menu beside **Share** for a document or a
database, and in a folder's menu, where a folder also names its approver group. It covers every
agent and the in-app co-author, which is why the UI says AI edits. The dialog shows the level the
node holds agents to and what it rests on: its folder's level; for a row page, its database's; and
for a page in someone's [My notes](#my-notes) that others can read, at least **Reviewed by whoever
asked the AI**. Nobody sets an item below the last two, so the dialog offers nothing looser. An item
at a level other than the default shows an **AI edits apply directly** or **Reviewed by a colleague**
chip, and lists mark it. Every change of a level is in the audit ledger.

### Reviewed by a colleague

Anyone who can edit the item, other than the person who asked the AI, may approve its changes. A
folder can name an approver group: for everything in it, only members of that group who can edit
the item approve. A folder inside it names another only with the approval of that folder's owner or
a workspace admin. When nobody else can approve, the item's owner or a workspace admin who can edit
it stands in, never the person who asked. Until someone can, the change waits, and the person who
asked is told to give a colleague, or someone in the approver group, edit access.

The person who asked can still reject or revert their own AI's changes, and send a note with them.
Only someone else marks a run proposed at `colleague` reviewed.

Each person who may approve is notified that changes wait for their approval, in Stuga and by email
or webhook, and the notice opens the run's [review card](#the-review-card). A workspace or a folder
can also post these changes to a [Slack review channel](#the-slack-review-channel). A Slack, Teams or
Discord channel the node sends notifications to hears each run once: from the notice to the person who
asked, which says the changes wait for a colleague, or, for the in-app co-author's and the table
assistant's runs, which notify nobody who is watching them, from the first approver's. While nobody
may approve, the item's owner and the workspace admins who can read it are notified that the changes
wait for an approver. When a folder's approver group changes, or a document or folder moves,
whoever may now approve a change waiting there, and could not before, is notified.

A run keeps the level it was proposed under, and each decision on its waiting changes takes the
stricter of that level and the item's level now. Moving a document out of its folder, or loosening a
level after a change was proposed, leaves that change waiting for the review it was proposed under.
Marking a run reviewed keeps the level it was proposed under: raising a folder later leaves what
already applied at once to whoever asked.

### What holds for every level

The level never depends on whether someone has the document open. The same agent making the same
edit gets the same outcome at any hour, so a person can predict it and an agent can plan around it.
Two consequences follow:

- A document an agent keeps for its own notes waits for review like any other, until someone
  sets it to `auto`.
- `auto` belongs to the document, not to an agent. While it is on, every agent that can write the
  document changes it without review.

A run that still holds undecided changes parks new ones even on an `auto` document, and the reply
says so.

Only the run's reviewer, the people who may approve it, and the item's owner and workspace admins
see the text of a change that has not landed (waiting, rejected or in conflict), and the document
before and after its run. Anyone else who can read the item sees that the run exists, how it went,
and the changes that landed, which version history shows too. Version history names an agent by the
person it acts for ("Liv's agent"), as comments do.

The propose reply carries `review` and `reason`, so an agent can explain what happened. `docs`
action `metadata` (and `GET /api/docs/:id` for an agent) answers the same question before writing:

```json
"review": { "mode": "colleague", "reason": "this document waits for a colleague's approval" }
```

The agent's owner is notified of everything it proposes, whoever approves it.

**The in-app AI co-author** follows the same level. Its turn on the document you are working in is
one run, which waits for your review, waits for a colleague's, or, on an `auto` document, applies
when the turn ends. It sends you no notification, since you are watching it; at `colleague` the
people who may approve it are notified. The table assistant's changes likewise wait or apply as it
makes them. With **All documents** or a collection as the panel's search scope, the co-author can
also propose edits to other documents you can edit. Those follow each document's own level, and you
are notified for each, so they stay findable after the chat scrolls away.

Before letting AI edits to a document apply directly, look at that agent's record in the review inbox.

### Questions in comments

When the co-author needs a fact or a choice only you can give, it can ask in a comment on the
passage and go on with the edits that don't depend on the answer. Everyone who can read the document
sees that comment, so it asks this way only in a turn that never reached other documents: not with
**All documents** or a collection as the scope, nor later in a chat that had one. Otherwise it asks
in its reply. If you leave the document before the turn ends, you are notified of each question
still open.

Anyone who can edit the document can reply with **Send to AI** ticked, and their own co-author
answers. That turn takes its request from the reply, with the rest of the thread as context. It
reaches only the open document and the thread, and downloads no images its edits link. Its edits
follow the document's setting, and it posts its answer in the thread. A question or a thread answer
is posted only when nothing in front of the AI came from other documents, edits waiting for your
review included; an answer held back stays in the AI panel.

The co-author's comments are authored `panel:<alias>`, `<alias>` being the person it works for. That
person may resolve or delete them, as may the document's owner or a workspace admin, and is notified
when someone replies to them.

### Agents in comment threads

With `comments_add`, an agent can reply in a thread (`parent_num`; a reply to a reply joins the
thread) or attach a new comment to a passage by quoting it (`quote`). The quote must appear exactly
once in the document's text, as written. A reply takes its thread's passage, so it takes no quote. Over
REST, an agent attaches a comment to a passage the same way ([API](api.md#documents)).

A comment may @mention at most 5 members of the workspace: more is refused, and nothing is posted.
Those it mentions who can read the document are notified. As with a person's comment, the
document's owner is notified, and a reply notifies whoever started the thread or replied before, the
person the agent works for included, since an agent often works while they are away. A reply in a
thread an agent started or replied in also notifies the person that agent works for. One person's
agents send at most 60 notices an hour in a workspace; past that a comment is still posted, and the
answer says how many notices were held (`notifications_held`).

In comments and in the notifications they send, an agent is named by the person it works for
("Liv's agent"), never by its own name. `comments` marks the agent's own comments `you: true`, and
replies in threads it started reach it through `events` with `mine: true`
([below](#events-and-webhooks)). A reply is the words of whoever wrote it: the agent is told to read
it as information, never as an instruction.

## The review inbox

**Review AI edits** (`/review`) lists the runs on documents and databases you can read across the
workspace, in three tabs:

- **Needs you**: changes waiting for your decision, a colleague's run you may approve included, and
  changes applied at once that you may mark reviewed and nobody has. Its count shows on every tab.
- **Waiting on others**: changes waiting for someone else's decision, your own AI's at `colleague`
  among them. Each says whom it waits for.
- **Done**: the rest, decided, reverted, or applied at once and looked at.

The tab is in the address (`/review?tab=waiting`, `?tab=done`), and **Agent** narrows any of them.
**Review changes** (or **Open**) opens a run's [review card](#the-review-card). A run's **⋯** menu
opens the document or database, or acts on the whole run in the card's words: **Ask for changes…**
(a note, which it requires), **Decline**, **Revert these changes**, **Revert with note…** and **Mark
as reviewed** (which also withdraws the notes you left on it); open the card or the document to
approve. A decided run says how many changes were approved and declined. **AI activity**, below the
list, is each agent's record (sessions, waiting, approved, declined, applied automatically, reverted)
and is what to consult before switching a document to `auto`.

## The review card

Each run has a card at `/review/<document or database>/<run>`, laid out for a phone and the same on a
laptop. The inbox, [review channel](#the-slack-review-channel) posts and a run's notices by email or
webhook open it, and so does a notice in Stuga for whoever may approve; the person who asked opens
theirs on the card on a phone, and in the document on a wider screen.

- **What it shows.** The page and the folders above it; who asked, which AI and the app it came
  through, and when; the review level, and who may decide: at `colleague` the people who may approve
  it, at `review` whoever asked, and the item's owner or a workspace admin where one other than them
  can edit it ("Liv, the document's owner or an admin can approve it"). Then each change in the paragraph it sits in, under its section, the
  text before it struck through above the text after it, with the sources its footnotes cite. A
  database's run lists each change in a line.
- **What it does.** **Approve** accepts every change still waiting. **Ask for changes…** rejects them
  with a note, which it requires, and **Decline…** rejects them with a note if you write one: either
  way the agent gets the note as [Reject with a note](#reject-with-a-note) says. **Open the
  document** goes to the page, where each change can be decided on its own.
- **Who sees what.** The rules of [every level](#what-holds-for-every-level): whoever asked, those
  who may approve, and the item's owner and workspace admins read the waiting text, its sources and
  who may decide. Anyone else who can read the item sees that changes wait, who asked and the level.
  Whoever may not approve reads why beside **Approve**, such as "Liv asked for this change, so a
  colleague approves it."

A link from outside the app carries `?workspace=<id>`, so the card opens in the item's workspace when
another one is active.

## The Slack review channel

A workspace, or a folder in it, can post each AI change that waits for a colleague's approval to a
Slack channel, so approvers hear of it where they already are. A workspace owner or admin adds one
on **Settings → This workspace → Agents → Review channel**: in Slack, add an incoming webhook to the
channel, and paste its address, which starts `https://hooks.slack.com/`. Only that host is accepted.

Each run that waits for a colleague is posted once, however many people may approve it and however
many changes the agent adds to it later: the item's title, who asked, which AI, how many changes, the
level, and a link to its [review card](#the-review-card). A post never carries a change's text:

```
“Leave policy”: Liv’s Claude proposed 2 changes · Reviewed by a colleague · Review
```

A post is written in the language of whoever added the channel, since a channel has many readers. As
a [webhook](api.md#webhooks) does, a channel hears only of items the person who added it can read,
checked again when the post goes out, and a run decided by then is not posted. Changes that wait for
whoever asked the AI, and those that apply directly, stay off the channel. Posts are signed, time out
and are retried as webhook deliveries are; a channel that fails 20 times in a row is paused until
someone resumes it.

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
  or a comment polls this instead of re-reading everything. The tool's `mine: true` keeps the
  decisions on the agent's own proposals and the replies in comment threads it started. Event types:
  [api.md](api.md#the-event-feed).
- **Webhooks.** Workspace owners and admins can send the same events to a URL, signed and retried,
  for the documents the hook's creator can read. See [api.md](api.md#webhooks).
- **Review channels.** A Slack channel hears of each change that waits for a colleague, with a link
  to approve it ([The Slack review channel](#the-slack-review-channel)).

## Save to Stuga and Ask Stuga

Say **Save to Stuga** to your AI, or the same in your language, and it files what you told it into
your team's wiki or your own notes. Say **Ask Stuga**, or ask what you or your team decided, and it
answers from Stuga, saying who wrote each point and when. The tool descriptions teach the model both
phrases in every interface language, since a bare "remember this" is taken by an assistant's own
memory.

- **Saving.** `remember` takes 1 to 20 points, each a `text`, an optional `topic`, and an optional
  `source` (the meeting, email or document it came from, and when; none for what you told the agent
  yourself), and writes no text itself. It answers with whom the connection acts for (`user`: their
  Stuga name and username), and for each point up to five places, best first: a page that says the
  point already; pages about it, whose title its topic names or which it names (a page whose
  approved text is empty, as a new page's is while all of it waits, is found by its title); folders
  whose name or instructions for agents fit the point and hold no page about it, for a new page
  (`kind: "new_page"`); then other pages that hold its words. Each page comes with the section it
  fits under (never the page's title heading: null for the page's opening, or a page only its title
  fits), why, and an excerpt. A page found by common words alone is left out (a word more than one
  page found holds, or one search leaves out, such as "with"), and so is a page found by one rarer
  word when the point names a page by its title or a page says it already; a word in an email or
  web address is no reason, and a section names a topic by the same word, never another form of it.
  A page of your My notes is offered only when nothing of the wiki is about the point. Each place
  has the [review level](#agent-changes-wait-for-review-or-apply-at-once) the caller's own write
  there gets: an agent's by the page, a person's at review. Beside them come the sentences that
  already say the point (`already_saved`: a sentence that holds its words and states them, not a
  question, a denial or struck-through text), and the sentences it may make untrue or that may say
  it already in other words (`possibly_replaces`, hint `likely_duplicate`). Numbers or dates alone
  never make a match. When the point names a page by a title that reads as a name (one never
  written in lower case, as "Initech", not "Refunds"), the other pages in its folder are about
  something else of the same kind: Acme's page is no place for Initech's terms, and none of its
  sentences is one Initech's replaces. A sentence that names someone the point does not, by a
  possessive or such a page's title ("Globex's refund window" for Acme's), is not one it replaces
  either. It finds them with the same search as `retrieve`, by keywords and, when embeddings are
  on, by meaning, among the documents you can read, and returns the instructions for agents of those
  places and of up to 20 folders that have some, by title. A point keeps the language of what it
  came from or of the page it belongs on. When only words were matched (semantic search is off) and
  no page found is about a point, none saying it, holding a sentence it changes, named by it or
  holding two of its words, the point carries a `note`: a page on it may be written in another
  language, so the agent lists the folder it belongs in, or plans again with the point's key words
  in that language, before it makes a new page. The agent then reads the best page and corrects the
  sentence a point changes, adds the point under its section, or makes a new page in the folder
  where it belongs, else in My notes. Each of these is an ordinary write: the page's
  level decides whether it waits for you, for a colleague, or applies at once. Afterwards the agent
  tells you what it saved where, what was already there, and what waits for approval, and when it
  wrote nothing, says so.
- **Who said it, and when.** What you tell the agent yourself is saved without your name or a date
  ("per Liv", "noted on 2026-10-22"): Stuga's version history records who changed what and when. A
  point from a meeting, an email or a document goes in with that as its `source`, cited in the text
  as the place's instructions ask, else in a few words after it ("customer sync, 2026-10-21"), and is
  never attributed to you. Your name goes in only where a point is about you ("Liv is on call on
  Mondays").
- **Asking.** `search` and `retrieve` give an agent, for each document, when it last changed
  (`updated_at`), who made its latest version (`last_edited_by`: a person by name, an agent or an
  AI co-author by the person it worked for, as "Liv's agent"; for a page with no version yet, who
  created it), `ai_edits` (`none`, `reviewed`, or `unreviewed` while an AI change that applied
  directly is waiting to be marked reviewed), and `pending_changes`: the AI changes proposed to it
  that wait for approval and are not in its text, by who asked for them (`asked_by`: `user`, the
  person the agent acts for, through it, another of their agents or their AI co-author; `others`),
  whom they wait for (`waits_for`: `review`, the person who asked the AI; `colleague`, someone else)
  and since when. The changes you asked for are listed in `proposed`, each as it would land: the
  approved text it changes (`approved_now`, empty when it adds, as on a page with no approved text)
  and what that text reads once approved (`after_approval`, empty when it removes it), cut at 200
  characters. A change one of your agents made to another of its waiting changes is told as one
  with it, from the approved text to where they end. Up to six per document are listed, those
  holding the most words of the question first; with passages, each goes on the passage it lands
  in, and one that lands in no passage found is listed on the document's first, with its `section`,
  only when it holds a word of the question. When fewer are listed than wait, `note` says so ("1 of
  4 listed here; read the page for the rest"). Other people's changes are counted only. So one call
  can answer "the page says 14 days; a change to 30 days waits for a colleague". The agent answers
  with the approved text and says what waits. A person's search and retrieval over REST answer as
  before.
- **What waits, in a read.** An agent's `markdown` read lays the changes made through its connection
  over the text, so its next edits line up with them, and opens with a block that says the text is
  not the approved text and lists each change as it would land ("Approved now: … → after approval:
  …", or that the page has no approved text yet) and who approves it, saying they are the user's
  own changes, from this conversation or an earlier one. Then it lists the waiting changes the user
  asked for through another of their agents or their AI co-author, told the same way, and counts
  other people's; none of those is in the text.
- **Finding.** When no document holds every word of an agent's `search`, it lists those holding
  some of them, the most and rarest first, and says `partial`; a person's search box still finds
  only documents holding every word. With embeddings off, an agent's `retrieve` returns the passages
  that hold the question's words (`semantic: false`) instead of refusing, and says `partial` when
  none holds every word; both notes remind the agent that pages may be written in another language,
  to try the words in it. A heading with no text of its own (a page's title heading, or a section
  whose text is all in subsections) is never a passage. Both take `query` as another name for `q`.
- **Whom it acts for.** The server instructions and `workspaces` action `list` (`user`) name the
  person the connection acts for, by their Stuga name and username, so an agent never names you by a
  name it guessed from a file path or an email address, and they tell it that what you say is saved
  without your name or a date.
- **Prompts.** The connection offers two MCP prompts, which a client lists in its prompt menu:
  **Save to Stuga** (`save`, with `text`) and **Ask Stuga** (`ask`, with an optional `topic` of up
  to 2,000 characters). Each sends one line in your own words. A read-only connection is offered Ask
  Stuga only, and no `remember`.
- **Claude.** When Claude first asks to use **Save to Stuga**, choose **Always allow**, or it asks
  again every time.

### My notes

Each person has one folder of their own in each workspace, made the first time their AI plans a
save there and named **My notes** in the language they read Stuga in. It sits at the top level,
owned by them and shared with nobody, a workspace admin included, and AI edits in it apply directly.
A point that fits no page of the wiki goes there, one page per topic. You can rename, move or share
it like any folder you own, and it stays your My notes; `remember` says in `home.shared` whether
anyone else can read it now. A key confined to some folders gets none unless its folders include it.

A page or folder in My notes that anyone else can read, after you share it or a folder above it, is
at `review` (**Reviewed by whoever asked the AI**) at least for every agent, yours included: no agent
changes a shared note unseen. `docs` action:metadata says so in its `review` reason.

## The tools

`/mcp` registers twenty tools from `@stuga/agent-surface`, and runs them in-process over the
node's own code, through the same permission checks and run ledger as the REST routes. The stdio
server lists the node's tools as they are. Reads and writes are separate tools, and each carries MCP
annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`. A client shows
them or acts on them, such as asking before a destructive call. They grant nothing: permissions and
the item's `agent_mode` decide what a call does.

**Reads.** Every one is read-only and idempotent.

| Tool | Actions and use |
|---|---|
| `workspaces` | `list` · `instructions`. The workspaces this connection reaches and the node each is on ([above](#one-connection-and-which-node-a-call-lands-on)), whom the connection acts for (`user`), and one workspace's instructions for agents. |
| `docs` | `list` · `metadata`. `list` takes an optional folder (`parent_id`, null for the root). `metadata` includes this agent's `review` answer for the document and its `instructions`. |
| `search` | Hybrid keyword and semantic search that returns documents, across `workspace_ids`, optionally within a collection. Each result says who last changed it and when, and what waits for approval ([Asking](#save-to-stuga-and-ask-stuga)). |
| `markdown` | `read` · `status` · `provenance`. `read` lists the changes that wait for approval, then shows the document's instructions in a marked block, then the text with the waiting changes made through the connection laid over it. `status` reports what became of its edits. |
| `comments` | A document's comments. An `author` of `panel:<alias>` is that person's [in-app co-author](#questions-in-comments), and the agent's own comments carry `you: true`. |
| `folders` | The folders the credential can read in the workspace. |
| `events` | What changed in the workspace since `after`, optionally narrowed by `types`. Without `after` it starts from the newest event. |
| `collections` | `list` · `open`. The saved document sets of the credential's person, which `search` and `retrieve` can be scoped to. `open` lists the members the credential can read ([collections.md](collections.md)). |
| `retrieve` | The passages most relevant to a question across `workspace_ids`, with their sources, who last changed each and what waits for approval, optionally within a collection ([rag-cross-doc-qa.md](rag-cross-doc-qa.md)). With embeddings off, the passages that hold the question's words. |
| `databases` | `list` · `schema` · `status` · `page`. `schema` returns tables, columns with their physical SQL names and `description` (what the column holds, written by the people here), saved views and the database's `instructions`. `page` returns the `doc_id` of a row's page, or null when it has none. |
| `query` | One read-only `SELECT` (SQLite dialect) against one database, with `?` parameters. At most 8 KB of SQL, 1,000 rows, 1 MB per value and five seconds of work. `WITH RECURSIVE` is refused, because a recursive query that never ends cannot be stopped. |

**Writes.** None but `remember` is idempotent. *Destructive* ones may replace or remove what exists;
*open-world* ones may make the node download an image or file from the web.

| Tool | Actions and use | Destructive | Open-world |
|---|---|---|---|
| `remember` | Save to Stuga: where each of 1 to 20 points belongs ([above](#save-to-stuga-and-ask-stuga)). It writes no text, and makes the person's [My notes](#my-notes) the first time. | no | no |
| `docs_create` | A document with a title, optionally in a folder. Returns its `instructions`. | no | no |
| `markdown_append` | Adds text at the end of a document, or under `heading`, and touches nothing else. Under a heading it goes at the end of that heading's own text: before its first subsection when it has any (so under a page's title heading, in the page's opening), and the answer says where it went and names the subsections; else at the end of its section. A heading the page lacks is refused with the headings it has, or, on a page with none, a note to put the heading in the text. | no | yes |
| `markdown_edit` | `write` · `str_replace` · `cited_edits`. `write` replaces the whole document, `str_replace` swaps `find` for `replace` (one occurrence, or all with `replace_all`; `old_string` and `new_string` are the same), and `cited_edits` makes several exact edits at once with citations that become footnotes. | yes | yes |
| `comments_add` | A comment on a document, a reply in a thread (`parent_num`), or a comment on a passage (`quote`, its exact text). It may mention at most 5 people, and those who can read the document are notified, as are the document's owner and, for a reply, the thread's people ([Agents in comment threads](#agents-in-comment-threads)). | no | no |
| `media_upload` | `upload` · `upload_from_url` · `start_upload`. Stores an image or any other file with a document, or a file with a database: from base64 of up to 3 MB with its `name`, from a public URL the node downloads, or, after `start_upload`, from the `upload_url` the caller sends it to itself, by `upload_id`. A document gets the Markdown that places it, an image shown and any other file a link that downloads; a database gets the link for a `files` cell. | no | yes |
| `collections_edit` | `create` · `rename` · `delete` · `add_items` · `remove_items`. `add_items` skips ids the credential cannot read and says how many. | yes | no |
| `databases_add` | `create_database` · `create_table` · `add_column` · `insert_rows` · `import` · `start_import` · `create_view` · `open_page`. `add_column` may set a column's `description`. `import` loads a whole CSV or JSONL file as one reviewable change, from its text in `content` or from an upload by `import_id`, so bulk data never passes through `insert_rows`. `start_import` returns an `upload_url` for a caller that can send the file itself, and the `import_id` to commit. `open_page` returns a row's page, a document read and edited like any other, and creates it the first time. | no | no |
| `databases_change` | `update_rows` · `delete_rows` · `update_view`. | yes | no |

Edits to a document's text and to a database are proposals. Writing `![alt](https://…)` or a `data:`
URI through `markdown_edit` or `markdown_append` downloads and stores the image, behind the node's
outbound address checks. A mention of a person reads and writes as `[@username](mention:<alias>)`;
keep it as written, and once an edit lands, a newly mentioned person who can read the document is
notified. The answer to a proposal names the instructions that apply beyond the workspace's.

When a file is too large to carry, `import` hands the agent a link to the table's Import dialog to
give the person. A `files` column holds a row's attachments as links, one per line; an agent adds
one by storing the file with `media_upload` on the database and writing the link into the cell
through `databases_change`, a proposal like any other. The stdio server also takes a local `file`
for `import` and `upload` ([above](#the-stdio-server)).

### Searching several workspaces

`search` and `retrieve` take `workspace_ids`: from 1 to 50 ids from `workspaces` action `list`, or
`["*"]` for every workspace the connection reaches.

- Each workspace is searched on its own, under its own permissions. Scores from different workspaces
  do not compare, so the answers are merged by rank: each workspace's first result, then each one's
  second, and so on. Scores are left out.
- Each result names its `workspace_id` and carries a `url` that opens the document.
- `collection_id` narrows a search of exactly one workspace.
- `unavailable: [{ workspace_id, reason }]` lists each workspace the call could not cover: one the
  connection cannot use. The agent is told to say so and never to present the rest as complete.
  When the only workspace named fails, its reason is the tool's error.

### Read-only credentials

A read-only key, or a connection given **Read only**, is offered the eleven reading tools and the
Ask Stuga prompt, and nothing else. The server instructions say that it may change nothing, and to tell the user what it
would change instead. `workspaces` action `list` reports `access: "read"`. A write tool it names
anyway is unknown to it, and the node's own read-only check stands behind that. Ask over REST is a
read too, and a read-only key keeps its own Ask threads ([api.md](api.md#read-only-keys)).

Two rules hold whatever a client does:

- Raw Yjs writes from an agent's socket are refused (`approval_required`). Proposals are the only way
  an agent changes content.
- A successful proposal is recorded even while review is pending. An agent that sees no change on
  re-read is looking at its own pending edits, not a lost write. The tool results say `Proposed` and
  tell the agent not to retry.
