# Configuration

A node has two kinds of settings, and each setting lives in exactly one place:

- **Environment variables** hold what the node needs before it can serve: where its database and
  data are, the address it answers at, the key that signs sessions. The node reads them when it
  starts, so a change takes effect at the next start. The Settings page shows them read-only where
  they matter, with a sentence saying how to apply a change on your platform.
- **Settings in the app** hold everything else. They are stored in the database and apply when they
  are saved, with no restart.

Where to put environment variables: `.env` on [Docker](install/docker.md#settings), and the node's
definition on [macOS](install/macos.md#where-things-live), or the build flags and job definition of
[a build from a checkout](install/macos.md#other-environment-variables). Each packaging sets
`DATABASE_URL`, `DATA_DIR`, `BIND`, `PORT` and `PG_BIN` for you.

## Environment variables

### Database and files

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | required | The Postgres database, as `postgres://user:password@host:5432/stuga`. For a unix socket, put the socket directory in the query, with spaces percent-encoded: `postgres:///stuga?host=/var/run/postgresql&user=stuga`. |
| `DATA_DIR` | required | The node's files: document snapshots, media, the per-actor SQLite stores, the signing key and secrets. One node uses a given directory. |
| `WEB_DIST_DIR` | `apps/web/dist` in the app tree | The built web app. |
| `PG_BIN` | the `PATH` | The directory with `pg_dump` and `pg_restore` for the server's Postgres major, used by backups and restores. |
| `BACKUP_DIR` | `backups` beside `DATA_DIR` | Where backups go. |
| `BACKUP_KEEP` | `7` | How many backups of the database are kept, the node's own and `backup`'s. At least 1. |

### Network

How these fit together, and what each way of reaching a node protects, is in
[Network access](network-access.md).

| Variable | Default | |
|---|---|---|
| `BIND` | `127.0.0.1` | The address the node listens on. |
| `PORT` | `8787` | The port the node listens on. |
| `PUBLIC_ORIGIN` | `http://localhost:8787` | The address people and agents reach the node at. Every link the node creates, the token issuer and the origins browsers may call from all derive from it. |
| `EXTRA_ORIGINS` | none | Further exact origins browsers may call from, comma-separated. Wildcards are refused. The node's own IP addresses and local names, at `PUBLIC_ORIGIN`'s http or https, need no entry ([Network access](network-access.md#public_origin-and-extra_origins)). An agent that calls the node at one of these signs in there ([Agents signing in](network-access.md#agents-signing-in)). |
| `TRUST_PROXY_HEADERS` | `false` | Take the client address from `X-Forwarded-For` or `X-Real-IP`. Turn it on only behind a reverse proxy that sets them. |
| `TLS_CERT_DIR` | none | A directory holding `<hostname>/fullchain.pem` and `<hostname>/privkey.pem`. When set, the node serves https only. |
| `SAMPLES_URL` | `https://github.com/stuga-dev/samples/releases` | Where the sample workspaces under **Start with** come from, laid out as GitHub's release list: the node reads the list from `<SAMPLES_URL>/latest/download/index.json`, keeps it an hour, and downloads a sample from `<SAMPLES_URL>/download/<tag>/<id>.stuga.zip`. The requests carry nothing about the node or anyone on it. For a network without internet access, serve a release's assets at those paths and point this at the server. No credentials, query or fragment. |

### Accounts and sign-in

Every account has a username, and signs in with a password, through the node's
[identity provider](#identity-provider), or both. The first account created on a node claims it and
administers it, and needs the node's setup code, which the node logs at every start until then
([Getting started](getting-started.md#2-claim-the-node)). Administrators appoint others in **Settings → This node → Access**. Every
account after the first is created with an invite link from **Settings → This workspace → Members**;
there is no open signup to turn on.

A username is 2 to 32 characters: lowercase letters, digits, `.`, `_` and `-`, starting with a
letter or a digit. These are reserved: `admin`, `administrator`, `root`, `stuga`, `support`,
`security`, `abuse`, `postmaster`, `system`, `api`, `www`, `me`, `null` and `undefined`.

| Variable | Default | |
|---|---|---|
| `NODE_SIGNING_KEY` | `<DATA_DIR>/identity/signing.jwk` | The key that signs session tokens, created on first start. Outside `DATA_DIR` it is not in backups, and losing it signs everyone out. |
| `ACCESS_TOKEN_TTL_SECONDS` | `3600` | How long a session's access token lasts. At least 60. The tokens apps get through OAuth last an hour whatever this says. |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` (30 days) | How long a session lasts without being renewed. At least 60. |
| `REFRESH_ROTATION_GRACE_SECONDS` | `60` | How long a just-used refresh token is still accepted. A refresh token is used once, and a second use normally ends every session of the account. The grace window covers two tabs renewing at the same moment. `0` turns it off. |

### Search and media

| Variable | Default | |
|---|---|---|
| `AI_EMBED_DIMS` | `1024` | The width of embedding vectors, fixed when the database is created. Pick it to match your embedding model, at most 2000. The node refuses to start when it differs from the database: [Change the embedding width](operations.md#change-the-embedding-width). |
| `MEDIA_COOKIE_SAMESITE` | `lax` | `lax`, `strict` or `none`, for the cookie that authorizes images. |

### Packaging hints

Packagings set these to fit their platform. Each has a neutral default.

| Variable | Default | |
|---|---|---|
| `STUGA_RESTART_HINT` | `Restart the node to apply.` | The sentence the Settings page shows next to values that come from the environment. |
| `STUGA_UPGRADE_HINT` | `Upgrade on the machine that runs the node.` | The sentence **About** shows beside a newer version: how this packaging upgrades. |
| `STUGA_STDIO_ENTRY` | the bundled `stuga-mcp.js` | The stdio MCP server **Your own AI** offers to local clients. Empty offers none. |
| `STUGA_UPGRADE_REQUESTS`, `STUGA_UPGRADE_STATUS` | none | Where an upgrade helper beside the node takes a request and reports how it went. With both set, **About** offers **Update now**. The Mac package sets them. |
| `AI_OLLAMA_DEFAULT_URL` | `http://127.0.0.1:11434` | The address the **Ollama (local)** choice fills in. |

How each packaging sets them is in [packaging/contract.md](../packaging/contract.md).

## Settings in the app

**Settings** is at the foot of the sidebar. Everyone sees **Preferences** and **This workspace**,
and node administrators also see **This node**.

| Where | What |
|---|---|
| Preferences → **Your own AI** | Connecting your own agent, such as Claude Desktop, Claude Code or Codex, and the agents you have connected: apps that signed in, and keys ([agents.md](agents.md)). Each person connects their own. |
| This node → **AI providers** | **Built-in AI** (chat), with its model providers and **Default model**, and **Search by meaning** (semantic search), with its service, model and [match cutoffs](#match-cutoffs). Each is set up on its own and runs without the other. Setting a half up turns it on, its switch turns it off and keeps it, and **Remove** forgets it. **Test** in an **Edit** checks that service. |
| This node → **Notifications** | Where notifications go: Slack, Microsoft Teams, Discord, a plain webhook or email, with **Send a test**. |
| This node → **Access** | The node's address and accepted origins (read-only), the [identity provider](#identity-provider), administrators, the node's audit log, and account recovery links. |
| This node → **Storage** | The largest upload, how long audit history, AI usage records and idle Ask threads are kept, and how many changes each database keeps in its Activity feed. |
| This node → **Search** | The [search languages](#search-languages): Korean and Arabic, each off unless chosen. |
| This node → **Backups** | The daily backup, on unless turned off, and its hour in the node's time zone, which first-run setup takes from the browser; **Back up now**; and the backups the node keeps ([Operations](operations.md#the-nodes-own-backups)). |
| This node → **Branding** | The node's name and the colour that marks the selected item. |
| This node → **About** | The address, listen address, data directory, database, the node's [name](#the-nodes-name-and-id) as agents know it, node ID, and the version with the day it was released. Under **Updates**: a newer version when the node knows of one, with **Update now** on a Mac, and **Check for new versions**, which is also asked at first-run setup ([Operations](operations.md#learning-of-a-new-version)). |
| This workspace → **General**, **Members**, **Agents** | The workspace, its members and invite links, and the workspace's instructions for agents and its webhooks. Folders, documents and databases keep their own instructions in their ⋯ menu ([agents.md](agents.md#instructions-for-agents)). |
| This workspace → **Audit log**, **AI usage** | The workspace's audit history and AI use. |

Provider API keys, the identity provider's client secret, the notification webhook URL and the SMTP
URL entered in Settings are kept under `DATA_DIR/secrets`, not in the database.

### Match cutoffs

The semantic half of search drops a passage whose meaning is too far from the query. How far is a
maximum cosine distance between the two embeddings: greater than 0 and at most 2, where lower is
stricter. There are two, under **Match cutoffs** in the **Edit** of **Search by meaning** in
**Settings → This node → AI providers**, and a change applies to the next query once saved. Nothing is re-indexed.

| Setting | Default | Applies to |
|---|---|---|
| **Search cutoff** | `0.6` | The search box, `POST /api/search`, and agents' `search`. |
| **Retrieval cutoff** | `0.9` | Ask, `POST /api/retrieve`, agents' `retrieve`, and the co-author's and table assistant's document search. |

Retrieval's default is looser because a short question sits far from even its best passage, and
ranking and the rerank decide what is kept. How far apart related text lands depends on the embedding
model, so set the cutoffs for the model you use: raise one when paraphrases are missed, lower it when
unrelated documents come back. Keyword matches are not affected. Clear a field and save to return to
its default.

### Search languages

Keyword search gives every text a general tokenizer, which splits Chinese and Japanese into words as
well as the languages that space theirs. Korean and Arabic it splits only at spaces, so a word with a
particle attached is missed. Two languages get a tokenizer of their own when chosen: **Korean**
segments Korean words, and **Arabic** stems Arabic. Each one adds a field to the search indexes, so
a node carries only the ones it chose. First-run setup asks, and a node administrator changes them
under **Settings → This node → Search**.

Saving rebuilds the keyword indexes while the node runs. Until the rebuild is done, search keeps
answering with the languages the old and the new choice share, and the section says it is
rebuilding. Saving other languages meanwhile stops it and rebuilds for those. A rebuild that keeps
failing gives up after five tries, and the section says why; search then keeps to the shared
languages until they are saved again or the node restarts. A node stopped midway finishes the
rebuild when it starts again.

`SEARCH_LANGUAGES`, the environment variable this setting replaces, is read until the node has the
setting: a node started with it before anyone has chosen takes its value as the setting, which
first-run setup shows ticked, and ignores the variable from then on. Started without it, such a node
takes the languages its search indexes are built for, so a node upgraded from an earlier version
keeps them either way. Indexes built for neither Korean nor Arabic give no setting, so the node reads
the variable again at its next start. An earlier version still reads the variable, so keep it while
the node may go back to one.

### The node's name and ID

The node's name is shown in the top bar, the browser tab and the sign-in page, and agents are told
it ([Agents](agents.md#one-connection-and-which-node-a-call-lands-on)). Once someone keeps shortcuts to other nodes, it also
heads their workspace switcher. A node
administrator sets it under **Settings → This node → Branding**: up to 80 characters, at least one
of them visible, and no control characters, line breaks or invisible direction marks.

Until then, and whenever it is saved empty, the app shows Stuga's own name. Where nodes are told
apart, in the workspace switcher and to agents, an unnamed node goes by the host of `PUBLIC_ORIGIN`
without its port or a trailing `.local`, such as `livs-air` for `http://livs-air.local:8787`, so
that label changes with the node's address. **Settings → This node → About** shows it.

The node ID is 16 lowercase letters and digits, chosen when the node first starts. A rename does not
change it, and it is kept in the database, so a restored node keeps it. `workspaces` action `list`
names it as the node each workspace is on. Neither the name nor the ID appears in what a client
stores: that is always `stuga` ([Agents](agents.md#one-connection-and-which-node-a-call-lands-on)).

### Identity provider

Local accounts are always on. A node administrator can add one identity provider, any OpenID
Connect provider, under **Identity provider** in **Settings → This node → Access**. The login page
then offers **Continue with** the provider below the password form.

| Field | |
|---|---|
| Issuer URL | The provider's issuer, https unless its host is loopback. On save the node reads `<issuer>/.well-known/openid-configuration` and refuses a provider it cannot use. Saving a different issuer unlinks every account. |
| Client ID | The client registered at the provider for this node. |
| Client secret | Optional. Without one the node signs in as a public client. |
| Button label | What follows **Continue with**. The issuer's host by default. |
| Scopes | `openid profile email` by default. |

At the provider, register `<origin>/auth/oidc/callback` as a redirect URI for `PUBLIC_ORIGIN` and
for each origin in `EXTRA_ORIGINS`. The Access page lists them.

Saving checks the issuer only, so a wrong client ID or secret shows at the first sign-in, when the
provider refuses it ([Troubleshooting](troubleshooting.md#accounts-and-sign-in)).

The node runs the sign-in itself, as an authorization code flow with PKCE. The browser visits only
the provider's sign-in page; the node reads the provider's discovery document and keys and redeems
the code. On Docker that means the node's container has to reach the issuer, and `localhost` there
is the container itself. The node ties each sign-in to the browser that started it with a
short-lived cookie, so a browser that blocks cookies for the node's address cannot sign in this way.
It checks the provider's ID token once and then issues its own session, as for a password, so the
provider's tokens are never credentials on the node. Sessions keep working while the provider is
down, and the sign-in works over plain http too.

The node renews its sessions without asking the provider, so disabling someone there stops their next
sign-in through it but not the session they have. Removing them from a workspace's **Members** ends
their access to that workspace, revokes the keys they minted there and takes the workspace out of
the apps they connected, but not their session, and a node administrator stays one until removed
under **Access**. Redeeming a reset link for their account
ends every session they have ([Troubleshooting](troubleshooting.md#accounts-and-sign-in) has the
steps).

The first time someone signs in with the provider, they create an account, which needs an invite
link like any new account, or link an account they already have by entering its username and
password. Accounts are never matched by email or username. In **Settings → Profile** people link and
unlink the provider and set a password; unlinking needs a password.

When the login page opens in a browser that last signed in through the provider, it signs in through
it again without a click, if the provider still has that person signed in. Signing out stops that,
and the next **Continue with** has the provider ask which account to use. **Use a different account**
on the first-visit page does the same.

Removing the provider or saving a different issuer, which the Access page confirms first, unlinks
every account, and so does resetting the node's settings with `DELETE /api/node/settings`
([API](api.md#through-the-identity-provider)). Nobody is signed out. People with a password sign in
with it and link again from **Settings → Profile**. Someone without one who is still signed in sets
one there; anyone else needs a reset link from **Account recovery**.
