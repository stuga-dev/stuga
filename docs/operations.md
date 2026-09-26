# Operations

Backups, restores, account recovery and media reclaim are the node's own `stuga-node` commands.
How to run them depends on the platform:

- Docker: the `./stuga` script beside `compose.yml`
  ([install/docker.md](install/docker.md#operator-commands)).
- macOS: the `stuga-node` shell function ([install/macos.md](install/macos.md#stuga-node-commands)).

The commands never start a node. `backup`, `verify`, `restore` and `list` take `--json`, which
writes one JSON object to standard output and keeps notes and errors on standard error.

| Exit code | Meaning |
|---|---|
| 0 | Done. |
| 2 | Refused, and nothing changed. Configuration errors exit 2 too. |
| 3 | Failed, and nothing changed. |
| 4 | Failed after a change. The message says where things are and how to put them back. |

## Backups

A node's data is in two halves that only mean something together: the Postgres database and the data
directory (`DATA_DIR`). A backup takes both while nothing writes to either, so they describe the same
instant. The node takes backups of itself ([below](#the-nodes-own-backups)): every day, and before
an upgrade. `stuga-node backup` backs up a stopped node. It refuses while a node holds the database,
and `./stuga backup` stops and restarts the node around it.

`backup`:

1. refuses while a node or another backup or restore holds the database;
2. refuses unless the backup directory has room for one and a half times the database and data
   directory;
3. writes `postgres.dump` (`pg_dump`, custom format) and `data.tar.gz` into `<name>.partial`;
4. reads both back in full;
5. writes `MANIFEST.json`, with versions, sizes and SHA-256 checksums, and renames the directory
   into place;
6. removes the oldest backups of the same database beyond `BACKUP_KEEP`, and any unfinished one.

A backup is a directory in `BACKUP_DIR`, named for the moment it was taken in UTC, such as
`2026-09-16T101500Z`. Docker also copies `compose.yml` into it.

The archive holds the signing key and the secrets under `DATA_DIR/secrets`: provider API keys, the
identity provider's client secret, the notification webhook and SMTP URLs, and the key that signs
sockets and media links. Treat a backup as secret. It sits on the same disk as the node, so copy it
somewhere else as well.

### The node's own backups

A running node backs itself up once a day, at 03:00 in its time zone unless an administrator picks
another hour under **Settings → This node → Backups**. The time zone is the one the browser was in at
first-run setup, and **Backups** can change it. **Back up now** there takes one at once, and the page
lists the backups the node keeps.

To back up while running, the node pauses for a moment: it answers new requests with a page that
says it is making a backup, lets the requests already under way finish, stops its background jobs
and closes every document and database. It keeps its hold on the database throughout, so nothing
else can start writing. Then it takes the same backup `backup` takes of a stopped node, and serves
again. Open documents reconnect by themselves. If requests are still under way after a minute, the
node serves again without a backup, and the backup fails.

No backup starts while a workspace is being imported or exported, which can take longer than that.
The backup waits, the daily one or one from **Back up now**, and is tried every two minutes until
none is; one still waiting after three hours fails. While it waits, no new import or export starts,
so it starts once the ones under way are done, and **Backups** says why it waits. An import or export
stops after 50 minutes, and an export also stops when its download has read nothing for a minute.

A daily backup that fails is shown on **Backups**, and every node administrator gets a notification,
in the app and through the [notification sink](configuration.md#settings-in-the-app) when one is set.
The next one is tried at the next day's hour.

Before an upgrade changes anything, the new version backs up the data the previous one left: when it
starts on a database another version served last, it takes a backup before it migrates. It takes
that backup once per upgrade, so a new version that fails to start and is started again does not
take another. If it cannot take the backup, for example for lack of disk space, it stops and changes
nothing. The backup's manifest names the version that served the data, and a restore goes back to
that version.

The node's backups go to `BACKUP_DIR` beside the operator commands' own, and `BACKUP_KEEP` (default
7) counts them all.

### verify

`verify <backup>` checks that a backup is whole: the manifest parses, both files match their
recorded size and checksum, `pg_restore` reads the whole dump, and `tar` reads the whole archive. It
also checks that this build can restore it. It refuses a backup from another Postgres major, a
schema newer than this build knows, or an embedding width other than the node's `AI_EMBED_DIMS`. It
notes a schema older than this build's, which the node migrates when it starts, and a backup taken
at another `PUBLIC_ORIGIN`, after which everyone signs in again. `verify` only reads.

### list

`list` shows complete backups, newest first, with the Stuga version and schema of each. It also
shows unfinished backups, which the next backup removes, and what restores left beside the data.

## Restore

`restore <backup>` replaces the current database and data directory with the backup's. It asks you
to type the backup's name, unless you pass `--yes`.

Before it changes anything, it refuses while a node or another backup or restore holds the database.
It also refuses when the backup does not verify, when Postgres cannot load pg_search, or when there
is no room for a second copy of both halves. Then it:

1. extracts the archive beside the data directory, into `<DATA_DIR>.restore-<stamp>`;
2. restores the dump into a new database, `<database>_restore_<stamp>`, without the search indexes,
   which the node builds when it starts. A backup from before the
   [search languages](configuration.md#search-languages) were a setting keeps its own, whose names
   are its only record of them;
3. swaps by renaming, keeping the current halves as `<database>_replaced_<stamp>` and
   `<DATA_DIR>.replaced-<stamp>`.

A failure in the first two steps removes what they made and exits 3. A failure while swapping puts
the original names back and exits 3. Only when that fails too does it exit 4, naming where each half
is. The next restore removes what an interrupted one left.

The replaced copies stay until you remove them. `list` names them, and each install doc shows how to
remove them.

Within minutes of starting on restored data, the node's maintenance runs against today's date: trash
older than 30 days and audit rows past their retention are removed for good.

A backup restores onto another machine that runs the same Postgres major, with the same
`AI_EMBED_DIMS`, and a Stuga that knows the backup's schema. The archive carries the signing key, so
sessions from the time of the backup keep working when `PUBLIC_ORIGIN` is unchanged. The node's ID,
and a name set in Settings, are in the database, so the restored node keeps them. A node that was
never named goes by the host of the restored node's `PUBLIC_ORIGIN`.

Practise a restore once, before the node holds anything you would miss.

## Move a workspace to another node

A backup moves a whole node. One workspace moves as a [workspace archive](workspace-archive.md):

1. On the old node, a workspace owner or admin chooses **Settings → This workspace → General →
   Export workspace**. The `<name>.stuga.zip` it downloads holds everything that person can open.
2. On the other node, **Create a workspace** with **Start with → From a file**, and choose the
   file. With no name typed, the workspace keeps the one it had. The file must be within that
   node's upload limit, 10 MB unless an administrator raises it in **Settings → This node →
   Storage**, up to 50 MB.

The new workspace has the folders, documents, databases with their rows, views and row pages,
images, comments, agent instructions, and each document's review mode, lock and search setting.
Whoever imports it owns everything in it, under the new workspace's default access. It does not
have the version history, the review and Activity history, sharing, members, collections,
favorites, or when rows were created and updated: invite the members and share again. A comment
shows its author's name marked as imported, and a mention is plain text. The old workspace stays
as it was until someone deletes it.

## Reset a password

```sh
stuga-node reset-password <username>
```

This prints a link, valid for 24 hours, that sets a new password on that account. Only a hash of the
link is stored, so it is shown once. Run the command again for another. Redeeming it ends every
session of that account. The command writes an audit row attributed to `console`.

It is the way back in when no node administrator can sign in. It needs a shell on the node's
machine, which can already read the signing key. A node administrator can mint the same link in
**Settings → This node → Access**, under **Account recovery**.

The link also works for an account that has never had a password and signs in only through the
identity provider. That is how its owner gets back in after the provider is removed, unless they are
still signed in and set a password in **Settings → Profile** themselves.

## Reclaim media

Images stay on disk after the documents that showed them are gone. One image can appear in several
documents and in their retained versions, so `media-scan` finds the images nothing uses by looking
at every document body and every retained version at once:

```sh
stuga-node media-scan                          # report, change nothing
stuga-node media-scan --reclaim                # move unreferenced images to the trash
stuga-node media-scan --empty-trash=30 --reclaim   # destroy what has been in the trash 30+ days
```

- `media-scan` never touches an image uploaded in the last 24 hours (`--grace-hours`). An image is
  stored before the document that links it is saved.
- It refuses to reclaim anything when a version snapshot cannot be decoded, and names the snapshots.
  Without them, the set of images in use would be incomplete.
- `--reclaim` moves images to the trash under `DATA_DIR/blobs/media/trash/`, and frees no disk. To
  put one back, move its `<hash>.blob` and `<hash>.blob.meta.json` from `trash/<workspace>/` to
  `media/<workspace>/`.
- `--empty-trash` alone reports. With `--reclaim` it destroys, and that cannot be undone. The
  default retention is 30 days.

## Change the embedding width

The width of the stored embedding vectors is fixed when the database is created, from
`AI_EMBED_DIMS` (default 1024). The vector index accepts widths up to 2000. The node refuses to
start when `AI_EMBED_DIMS` differs from the database, and Settings refuses an embedding model of
another width.

A different model of the same width needs none of this. Choose it in **Settings → This node → AI
providers**, and the node clears the old vectors and re-embeds every document.

To change the width, take a backup and stop the node, leaving Postgres running. Then run this in
`psql` against the node's database, here for a width of 768:

```sql
ALTER TABLE doc_chunks DROP COLUMN embedding;
ALTER TABLE doc_chunks ADD COLUMN embedding vector(768);
CREATE INDEX doc_chunks_vec_hnsw ON doc_chunks
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200);
UPDATE doc_chunks SET embed_hash = NULL, embed_attempts = 0;
```

Set `AI_EMBED_DIMS` to the new width, start the node, and choose the new embedding model in
Settings. The last statement matters: a chunk that failed too often under the old model is otherwise
never embedded again. The node re-embeds in the background, and search finds by meaning only what it
has re-embedded so far.

## Learning of a new version

Only the most recent release gets fixes ([SECURITY.md](../SECURITY.md)), so a node that does not
learn of a release is not fixed.

**A node that can reach the internet** looks once a day. It fetches one file from GitHub,
`https://github.com/stuga-dev/stuga/releases/latest/download/releases.json`, and compares the
releases it lists with its own version on the node. The request carries no version, no node ID and
nothing else about the node, and it goes to GitHub, not to us. What the node learns is shown to node
administrators only:

- **Settings → This node → About** names the newer version, links its release notes and says how
  this packaging upgrades; on a Mac, **Update now** there installs it. The **About** entry in the
  Settings rail is marked.
- When a newer release fixes a vulnerability, every node administrator also gets a notification,
  once per release, in the app and through the [notification sink](configuration.md#settings-in-the-app)
  when one is set.

**Check for new versions** turns this off and on. It is on unless someone turns it off, and
first-run setup asks before the node has made a single request: a node set up with it unticked
never looks. **Check now** looks at once. A node built from source, or on any version that is not a
plain `1.2.3`, never looks.

**A node that cannot reach the internet** learns nothing on its own, and a look that fails is tried
again the next day, so turn the switch off on a network that watches for outbound attempts.
**About** always shows the day the running version was released, which is how you tell how old a
node is from the node alone, and **All releases** there opens the list in your own browser. To hear
of releases, follow them from a machine that is online:

- **Watch → Custom → Releases** and **Security alerts** on
  [the repository](https://github.com/stuga-dev/stuga), or its
  [releases feed](https://github.com/stuga-dev/stuga/releases.atom) in a feed reader.
- [CHANGELOG.md](../CHANGELOG.md) lists every release, and each entry with a **Security** section
  fixes a vulnerability.

Such a node upgrades from files carried to it, with the same backup and the same way back as any
other ([Docker](install/docker.md#without-a-connection-to-the-registry)). On a Mac, open a newer
`Stuga.pkg` on it ([macOS](install/macos.md#updates-and-backups)).

The node never upgrades itself. An upgrade replaces the software and migrates the database, so it
runs on the machine: on Docker, `./stuga upgrade` or a NAS app store's update; on a Mac, the
package's helper, which runs as root beside the node and installs a release when a node
administrator chooses **Update now**. The helper installs only a newer release's package, notarized
by Apple and signed by Stuga's developer. Either way the new version backs up the data before it
changes it.

## Upgrades

A new version backs up the database before it changes anything
([The node's own backups](#the-nodes-own-backups)), however it arrived: **Update now** or a newer
`Stuga.pkg` on a Mac, `./stuga upgrade`, a NAS app store's update, or images pulled by hand. The
install docs have the commands for [Docker](install/docker.md#upgrade) and
[macOS](install/macos.md#updates-and-backups).

Any release upgrades straight to the newest one. There are no versions you have to stop at on the
way, however many you skip.

On its first start, a new version backs up, then migrates the database in one transaction, and only
then serves. Until then it answers with a page that says it is upgrading. An upgrade that stops
halfway leaves the schema as it was. The node's log names both versions:

```
[node] stuga <old> → <new>, schema <n> → <m>
```

There is no downgrade. A node refuses to start on a database that a newer version wrote, because the
newer version may have changed what its tables mean:

```
this database is at schema <m>, but this build of Stuga only knows schema <n>. …
```

Each document's and each database's own store under `DATA_DIR/actors` is stamped the same way. A
build refuses to open one that a newer version stamped, that document or database answers with an
error, and the node's log says which store and which versions.

Start the newer version again, or restore the backup taken before the upgrade and run the earlier
version on it. The other reasons a node refuses to start are listed in
[Troubleshooting](troubleshooting.md#the-node-does-not-start).
