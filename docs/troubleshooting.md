# Troubleshooting

Start from what you see. Most entries quote the node's log, which is `docker compose logs node` on
[Docker](install/docker.md#what-is-where) and `/Library/Logs/Stuga/node-<Day>.log` on a
[Mac](install/macos.md#where-things-live), which **Show Logs** in the menu bar opens.

## Start here

Three checks tell most "it won't open" problems apart. Do them in order.

**1. Is the node serving?** On the node's machine:

```console
$ curl -s http://127.0.0.1:8787/ready
{"ok":true}
```

`{"ok":true}` means the node serves and its database answers. `{"ok":false}`, with status 503, means
the node runs but cannot reach its database. With a `status` such as `"starting"`, `"backing_up"` or
`"upgrading"`, it is on its way: wait, and a browser shows a page that says so. A refused connection
means nothing listens on that port: the node is stopped, still starting, or on another port. `/ready`
needs no sign-in, and `curl` sends no `Origin` header, so it answers even when `PUBLIC_ORIGIN` is
wrong.

**2. Does it open from a phone on the same network?** Open the node's network address. A phone
shares the network but none of your computer's settings.

**3. Then the browser that fails.**

| The first check that fails | Go to |
|---|---|
| `curl` on the node's machine | [The node does not start](#the-node-does-not-start) |
| The phone | [The connection is refused or times out](#the-connection-is-refused-or-times-out) |
| Only the computer's browser | [The browser says the site can't be reached](#the-browser-says-the-site-cant-be-reached) |
| None: the page loads, then breaks | [The page loads, but nothing saves](#the-page-loads-but-nothing-saves) |

## The node does not start

When the node refuses to start, its log has a line starting `[node] configuration error:` that says
what is wrong and what to do. Any other failure logs `[node] failed to start` and the error, most
often a database it cannot reach at `DATABASE_URL`. Docker restarts the container and hits the same
error each time, so the container keeps restarting until the cause is fixed.

| The message | What to do |
|---|---|
| `another Stuga node is already running against this database` | Stop the other node. One node runs per database. |
| `a backup or restore of this database is in progress` | Wait for it to finish, then start the node. |
| `AI_EMBED_DIMS is … but this database stores doc_chunks.embedding as vector(…)` | Set `AI_EMBED_DIMS` to the database's width, or [change the width](operations.md#change-the-embedding-width). |
| `this database is at schema …, but this build of Stuga only knows schema …` | An older version is running against data a newer one wrote: [Upgrades](operations.md#upgrades). |
| `the backup this node takes before upgrading a database did not complete` | Nothing was upgraded, and the data is as the previous version left it. The message ends with why. For lack of disk space, free some or set `BACKUP_DIR` to a larger disk, then start the node again. |
| `this node is built for Postgres …, but the server it connected to is Postgres …` | Follow the message. A newer Postgres needs a Stuga built for it. Data in an older one has to move to the major Stuga is built for. |
| `does not offer the pg_search extension`, or `pg_search is missing from shared_preload_libraries` | Install pg_search for that Postgres, list it in `shared_preload_libraries`, and restart Postgres. |
| `this database's default collation is …` | Create the database again with the builtin `C.UTF-8` locale, as the message shows. A backup restores into it. |
| `migration … has been edited since it ran on this database` | Put the migration file back as it was. |

On a Mac, the menu bar says `Stuga is not answering`: **Show Logs** opens the node's log. A
Stuga.app built from a checkout says in its status line why it could not start:

| The status line | What to do |
|---|---|
| `Could not start: port 8787 is already in use by another program` | Stop the other program, or rebuild with `--port`. |
| `Could not start: setting up the database failed` | Read `init-cluster.log` in the logs folder. |
| `Could not start: Stuga did not answer within 5 minutes — see the logs` | Read the node's log. |

On Docker, when port 8787 on the host is taken, set `HOST_PORT` in `.env` and change the port in
`PUBLIC_ORIGIN` to match. The first `docker compose up` pulls two images and can print little for
several minutes.

## The page won't open from another device

### The connection is refused or times out

The node answers on its own machine, but not from other devices.

- **Docker** with `HOST_BIND=127.0.0.1` serves only its own machine. Remove it, and set
  `PUBLIC_ORIGIN` as [install/docker.md](install/docker.md#reaching-the-node-from-other-devices)
  shows.
- **A Mac** built with `--local-only` serves only itself. If the macOS firewall is on, allow `node`
  to accept incoming connections.
- A device that cannot resolve `<name>.local` opens the node by the Mac's IP address instead. For
  invite links to carry that address too, set it as `PUBLIC_ORIGIN` in the node's definition
  ([install/macos.md](install/macos.md#where-things-live)), or rebuild a build from a checkout with
  `--origin`.
- Check that the address is still the machine's. A new DHCP lease is a new address.
- Check that the machine's firewall allows the port, and that both devices are on the same network.
  A guest Wi-Fi often keeps its devices apart.

### The browser says the site can't be reached

The address opens on your phone, but a browser on your Mac reports `ERR_ADDRESS_UNREACHABLE`, a
timeout or a reset. On macOS 15 and later, that browser has lost its permission to reach devices on
your local network.

1. Open **System Settings → Privacy & Security → Local Network** and turn the browser on. A browser
   can be listed more than once.
2. Quit the browser with ⌘Q and open it again. If it asks to find devices on your local network,
   choose **Allow**.
3. If that does not help, restart the Mac.

On the node's own Mac, `http://127.0.0.1:8787` needs no such permission.

### The page loads, but nothing saves

The page opens and sign-in works, but saving fails and documents never connect. The address in the
browser is a public name that is not the node's `PUBLIC_ORIGIN`, nor in `EXTRA_ORIGINS`. An IP
address or a local name such as `<name>.local` always works. The log names the refused address:

```
[node] refused browser origin "http://stuga.example.com:8787"; this node's PUBLIC_ORIGIN is http://192.168.1.50:8787. …
```

Set `PUBLIC_ORIGIN` to the address people use, or add this one to `EXTRA_ORIGINS`.
[Network access](network-access.md#public_origin-and-extra_origins) explains both.

### Copy buttons do nothing

On plain http at a network address, the browser withholds the clipboard. Select text to copy it, or
give the node an https address as [Network access](network-access.md#https) describes.

## Accounts and sign-in

| What you see | What it is |
|---|---|
| `Creating an account here needs an invite link.` | Every account after the first is created with an invite link. Ask a workspace owner or admin for one from **Settings → This workspace → Members**. |
| `That invite link is no longer valid. Ask whoever sent it for a new one.` | The link expired, admitted as many people as it allows, or was revoked. **Invite links** on the Members page lists the links that still work. |
| `Too many attempts. Wait a moment and try again.` | The sign-in limit. Behind a reverse proxy every attempt shares the proxy's address unless `TRUST_PROXY_HEADERS` is set: [Network access](network-access.md#a-reverse-proxy). |
| You forgot your password, and no other administrator can sign in | Run `reset-password` on the node's machine: [Operations](operations.md#reset-a-password). |
| `this is the last node administrator; appoint another one first` | Appoint another administrator in **Settings → This node → Access** first. |
| `Couldn’t sign in with <label>.` | The node could not finish a sign-in through the identity provider: the provider refused it, it took longer than 10 minutes, it finished in a different browser from the one that started it, or it started at an address that is neither `PUBLIC_ORIGIN` nor in `EXTRA_ORIGINS`. The node's log has an `[auth]` line with the reason. |
| `Couldn’t sign in with <label>.` every time, and the log's reason is `browser_binding` | The browser did not send back the cookie that ties a sign-in to it. Allow cookies for the node's address. |
| The provider's own page says the client is unknown, or the log's reason starts with `token_`, such as `token_invalid_client` | The client ID or secret is wrong. Saving the provider checks only its issuer, so they show at the first sign-in. Correct them under **Identity provider** in **Settings → This node → Access**. |
| The identity provider refuses the redirect URI | Register the callback URL that **Settings → This node → Access** lists for the address in the browser: [Identity provider](configuration.md#identity-provider). |
| Saving the identity provider refuses the issuer | On save the node reads `<issuer>/.well-known/openid-configuration`, and the message says what failed: the node cannot reach it, its `issuer` differs from the one typed, or the provider offers no authorization code flow with S256 PKCE. The issuer must be https unless its host is loopback. On Docker the node's container has to reach it, and `localhost` there is the container itself. |
| **Continue with** signs straight back in as the same person | The provider still has them signed in. After signing out here, the next **Continue with** has the provider ask which account to use, and the first-visit page offers **Use a different account**. |
| Someone disabled at the identity provider can still use the node | Expected. The provider is asked only at sign-in, and the node renews its own sessions, which removing them from a workspace does not end. First take away node administration in **Settings → This node → Access** if they have it. Then mint a reset link for them under **Account recovery**, redeem it yourself in a private window and sign out there: that ends every session of theirs, though an access token already issued works for up to `ACCESS_TOKEN_TTL_SECONDS`. Last, remove them from each workspace's **Members**, which revokes the keys they minted there and takes the workspace out of the apps they connected. |
| Someone who signed in only through the identity provider cannot sign in after it was removed or its issuer changed | The change signed nobody out. While they are still signed in, they set a password in **Settings → Profile**. Otherwise send them a reset link from **Account recovery** in **Settings → This node → Access**. It sets their first password. |
| **Unlink** is unavailable: `Set a password first.` | An account keeps a way to sign in. Set a password in **Settings → Profile** first. |
| Everyone has to sign in again after the address changed | Expected. Sessions belong to the old address. |
| People are signed out with two tabs open | `REFRESH_ROTATION_GRACE_SECONDS=0` is set. Remove it to restore the default of 60. |

## Several nodes

| What you see | What it is |
|---|---|
| Adding to **Other nodes** says `That’s this node’s own address.` | The address is this node's `PUBLIC_ORIGIN` or in its `EXTRA_ORIGINS`. The switcher already lists this node's workspaces. |
| A shortcut under **Other nodes** opens a sign-in page | Expected. Each node has its own sign-in, and being signed in here signs you in nowhere else: [Several nodes](network-access.md#several-nodes). |
| A shortcut opens the wrong page, or nothing | A shortcut keeps the address it was added with, and nothing checks it. Remove it and add the node's current address. |
| Adding a second node to one client fails, or the installer says the name is taken | A client cannot hold two entries called `stuga`. Add the second under another name: write `stuga-work` in the Claude Code command, change the key in a pasted config, or run an installer as `curl -fsSL '…' \| STUGA_SERVER=stuga-work sh`. |
| An agent finds nothing that lives on another node | Each node is its own MCP server, and a search covers only workspaces on the node it is sent to. Set the agent up on each node: [Agents](agents.md#one-connection-and-which-node-a-call-lands-on). |
| Claude Desktop reaches the wrong node after you installed a second node's extension | The extension is one for every node, so the second replaced the first. Its **Stuga address** setting says which node it reaches. |

## Agents

| What you see | What it is |
|---|---|
| An agent does not see a workspace | The app signed in with other workspaces ticked. Sign in from the app again and tick it. A key confined to folders reaches only the workspace it was minted in. |
| An agent's call says `workspace is not available to this connector` | The `workspace_id` is not one this connection reaches, or you are no longer a member there. `workspaces` action `list` names the ones it can use. |
| An agent was working, then asks to sign in again | Its connection was revoked under **Connected agents**, its refresh token went unused for 90 days, or you left every workspace it named. Sign in again. |
| An agent can read but offers no way to change anything | The connection or key is read-only, so only the reading tools are offered. Sign in again with **Read and suggest changes**, or mint a key that can propose. |
| Claude Desktop lists no Stuga tools | The sign-in page may be waiting in your browser: approve it. Otherwise quit Claude fully, reopen it, and read the extension's log ([Agents](agents.md#claude-desktop)). |
| The consent page says **Unverified app** | The app registered itself with the node, so its name is its own claim. Allow it only if you started the connection and recognize the host it returns to. |
| **Your own AI** has no **Claude** tab | Claude on the web needs the node at a public https address: [HTTPS](network-access.md#https). |

## AI

| What you see | What it is |
|---|---|
| The log says `ai off`, or a request answers `AI chat is disabled on this node` | Chat is not set up, or its switch is off. Connect a provider under **Built-in AI** in **Settings → This node → AI providers**, or switch **Built-in AI** on there. |
| **Connect** says the service didn't accept the key | The key is wrong, revoked or for another service. Paste it again. For a service that is not listed, choose **Something else…** and check its **Base URL**. |
| The log says `a chat provider is saved but offers no model` | Chat stays off until the provider offers a model. Open its **Edit** and choose **Models offered**. |
| An agent's `retrieve` answers `AI chat is disabled on this node for retrieval (embeddings are off)` | **Search by meaning** is not set up, or its switch is off. Keyword search with `search` still works. |
| **Connect** or **Test** cannot reach Ollama on Docker Desktop | Use **Ollama (local)**, which fills in `http://host.docker.internal:11434`, and check that Ollama is running on the host. |
| **Connect** or **Test** cannot reach Ollama on Docker on Linux | Ollama listens on `127.0.0.1` by default, which the container cannot reach. Make it listen on an address the container can reach, such as `OLLAMA_HOST=0.0.0.0:11434`, and keep that port closed to the network in the host's firewall. |
| Anthropic is not listed under **Search by meaning** | Anthropic serves no embeddings. Use another service there, or leave search matching words. |
| A new embedding model cannot be saved because of its width | The width is fixed when the database is created: [Change the embedding width](operations.md#change-the-embedding-width). |

## Search

| What you see | What it is |
|---|---|
| Search finds exact words but nothing by meaning | **Search by meaning** is off, or the node has not embedded the documents yet. It does so in the background. |
| It found things by meaning, and stopped | The embedding service is failing, so search falls back to keywords. The log says `degrading to keyword-only`. |
| Search by meaning misses paraphrases: a document is found by its exact words but not by a rewording | The match cutoff is too strict for this embedding model. Some models, such as `text-embedding-3-small`, place related text further apart. Raise **Search cutoff** (or **Retrieval cutoff** for Ask and agents' `retrieve`) under **Match cutoffs** in the **Edit** of **Search by meaning** in **Settings → This node → AI providers**, a step at a time, and save: [Match cutoffs](configuration.md#match-cutoffs). |
| Search by meaning returns unrelated documents | The match cutoff is too loose for this embedding model. Lower it the same way. |
| Korean or Arabic words are missed when a particle is attached | Set `SEARCH_LANGUAGES`: [Configuration](configuration.md#search-and-media). |

## Uploads and disk

| What you see | What it is |
|---|---|
| `image too large (max N MB)` | The upload limit. A node administrator sets it in **Settings → This node → Storage**, up to 50 MB. |
| `markdown too large (max N KB)` | The separate limit on a Markdown import. |
| The disk keeps growing after documents are deleted | Images stay until you reclaim them: [Reclaim media](operations.md#reclaim-media). Old backups (`BACKUP_KEEP`) and the copies a restore keeps also take space; `list` shows them. |

## Documents

A document opens blank, and edits never reach its history. The snapshot behind the document is
missing from disk, and the node refuses to save over it, so the gap can still be repaired. The log
says so each time the document loads:

```
snapshot missing for a doc that has one; refusing to flush over it { docId: '…', seq: …, key: '…', recover: 'POST /api/docs/…/recover' }
```

The document's owner or a workspace administrator repairs it with `POST /api/docs/<id>/recover`
([API authentication](api.md#authentication)). The node rebuilds the document from the newest
earlier snapshot still on disk, or from its search text when none is left, as a new version
attributed to `system:recovered`. If the snapshot is readable again, for example because a disk was
mounted late, the call answers that there is nothing to recover and changes nothing.

## Backups and restores

| What you see | What it is |
|---|---|
| `the node is running against database "…"; stop it first. Nothing was changed.` | `backup` and `restore` need the node stopped. `./stuga` does that on Docker. On a Mac, stop the node as [install/macos.md](install/macos.md#stuga-node-commands) shows. **Back up now** under **Settings → This node → Backups** backs up a running node. |
| `not enough disk at …` | Free space, or set `BACKUP_DIR` to a larger disk. |
| `this backup came from Postgres … and this runtime is built for Postgres …` | Restore it with a Stuga built for the backup's Postgres major. |
| `this backup is at schema …` | The backup is newer than this Stuga. Restore it with the version that took it. |
| `this backup stores embeddings of width …` | Set `AI_EMBED_DIMS` to the width the message names, then restore. |
| A command exits 4 | Something changed before it failed. Read the message before doing anything else: it says what changed and how to put it back. |
