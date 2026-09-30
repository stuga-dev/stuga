# What the node sends and stores

Stuga sends no telemetry. Apart from the two requests under [Without any setup](#without-any-setup),
a node makes outbound requests only for the features in use on it, and nothing reaches us unless a
node administrator turns on remote access, which
[Remote access](remote-access.md#what-the-node-sends-to-the-service) lists field by field.

An AI app you connect sees what its model reads and writes
([Agents](agents.md#which-clients-can-reach-a-node)).

## Without any setup

- **New releases.** Once a day the node fetches the list of Stuga releases from GitHub.
  [Operations](operations.md#learning-of-a-new-version) says what the request carries and how to
  turn it off.
- **Sample workspaces.** When someone opens **Create a workspace**, the node fetches the list of
  sample workspaces, at most once an hour, and then the sample they pick, from GitHub or the mirror
  [`SAMPLES_URL`](configuration.md#network) names.

## For features in use

| Feature | When | To, and what it carries |
|---|---|---|
| **Built-in AI** and **Reranking** | Once a node administrator sets them up under **Settings → This node → AI providers**, whenever the co-author, the table assistant, Ask or an agent's `retrieve` uses them | The service chosen: the question or conversation, what the feature reads to answer it (the document being edited, passages it found, rows it queried, images attached to the chat), and the instructions that apply |
| **Semantic search** | Once it is set up: for every document then and whenever its model changes, for each change to a document's text, and for each search and question | The service chosen: the text of every document not hidden from search, in sections, and the text of each search and question |
| Notifications | For each one, once a node administrator chooses where they go under **Settings → This node → Notifications** | Slack, Microsoft Teams, Discord, a webhook or an SMTP server: the notification's title, text and link, and to a webhook or by email its recipient |
| Webhooks | For each event, once a workspace owner or admin adds one | Its URL: the event, signed ([API](api.md#webhooks)) |
| Identity provider | When an administrator adds one, and at each sign-in through it | The provider ([Configuration](configuration.md#identity-provider)) |
| Images and files by URL | When an agent or the co-author adds one by its URL | That URL. The node stores what it gets and serves it itself |
| An app's metadata document | When an app that names itself by one signs in, at most once a day | That URL, to name the app on the consent page ([Agents signing in](network-access.md#agents-signing-in)) |

**Test** and the list of models under **AI providers** reach the service with its key and no
workspace content. **Send a test** under **Notifications** sends a fixed message with the node's
address.

AI is off until a node administrator sets it up, and with Ollama on the same machine the text stays
there. A document hidden from search (**Hide from search** in its ⋯ menu) has no sections in the
index, so while it is hidden its text is not sent for embedding.

For webhooks, images and files by URL, and apps' metadata documents, the node refuses a URL that
resolves to a private or loopback address.

## Installing and upgrading

- **Docker.** `install.sh` and `./stuga upgrade` download the release's files from GitHub and its
  images from `ghcr.io`. A node without internet access upgrades from files carried to it
  ([Install with Docker](install/docker.md#without-a-connection-to-the-registry)).
- **Mac.** **Update now** under **Settings → This node → About** downloads the release's package
  from GitHub, when an administrator chooses it. Turning on remote access downloads its connector
  from the release ([Install on macOS](install/macos.md#remote-access)).

## What the node stores

- **Postgres:** metadata, permissions, the search index (each document's text in sections, and
  their vectors), the audit ledger and the job queue.
- **`DATA_DIR`:** document snapshots, images and files, each document's and database's own SQLite
  file, the signing keys, and the secrets entered in Settings
  ([Configuration](configuration.md#settings-in-the-app)).

Stuga does not encrypt data at rest. Documents, the database and keys are stored in plaintext on the
node's disk, readable by anyone who can read that disk. A backup holds the same, secrets included
([Operations](operations.md#backups)). Passwords, API key secrets and apps' tokens are stored only as
hashes.

**Settings → This node → Storage** sets how long audit history, AI usage records and idle Ask
threads are kept, and [the event feed](api.md#the-event-feed) says how long events stay. Documents
and databases in the trash are deleted after 30 days; the images they showed stay on disk until
[media-scan](operations.md#reclaim-media) reclaims them.

Reaching a node from other devices, and what each way of doing that protects, is in
[Network access](network-access.md#what-each-way-of-reaching-a-node-protects).
