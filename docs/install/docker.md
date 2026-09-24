# Install with Docker

A Docker node is two containers, Postgres and the node, started by Docker Compose from three files
in a directory of their own. Nothing is compiled on your machine.

## Requirements

- Docker Engine or Docker Desktop with Compose 2.24 or later, on x86-64 or arm64.
- `bash` and `curl`, for the `./stuga` operator commands.

## Install

```sh
curl -fsSL https://github.com/stuga-dev/stuga/releases/latest/download/install.sh | bash
```

This makes a `stuga` directory, downloads the release's `compose.yml`, `env.example` and `stuga`
into it, writes `.env` with this machine's address on the network as `PUBLIC_ORIGIN`, starts the
stack and waits until the node serves. It ends by printing the link that sets the node up, with its
setup code in it. Continue with [Getting started](../getting-started.md).

Options go after `bash -s --`: `--dir <dir>`, `--version <1.2.3>`, `--port <n>`, `--origin <url>`
when this machine's address is not the one other devices use, and `--local-only` to serve this
machine only.

By hand, the same steps are:

```sh
mkdir stuga && cd stuga
for f in compose.yml env.example stuga; do
  curl -fsSLO "https://github.com/stuga-dev/stuga/releases/latest/download/$f"
done
chmod +x stuga
cp env.example .env
echo "PUBLIC_ORIGIN=http://192.168.1.50:8787" >> .env   # this machine's address on the network
docker compose up -d
```

For a specific release, use `releases/download/v<version>/` in place of `releases/latest/download/`.
Until the node serves, it answers with a page that says it is starting. `./stuga status` reports
`ready yes` once it serves, and the setup link while nobody has claimed the node.

## What is where

| Path | Holds |
|---|---|
| `compose.yml` | The stack, with both images pinned to one release. An upgrade replaces it, so do not edit it. |
| `.env` | Your settings. Compose reads it, and passes it to the node. |
| `stuga` | The operator commands. |
| `data/node/` | The node's data directory (`DATA_DIR`): document snapshots, media, per-actor SQLite stores, the signing key and secrets. |
| the `stuga_pgdata` volume | The Postgres cluster. `docker volume inspect stuga_pgdata` shows where Docker keeps it. |
| `backups/` | Backups: the node's daily ones, the one it takes before an upgrade, and `./stuga backup`'s. |

The node's log is `docker compose logs node`, and Postgres's is `docker compose logs postgres`. Add
`-f` to follow either one.

## Settings

Put settings in `.env`, then run `docker compose up -d`. A `docker compose restart` keeps the old
environment. Any node variable in [Configuration](../configuration.md) can go in `.env`, except the
ones the stack sets itself. `compose.yml` sets `DATABASE_URL`, `DATA_DIR`, `BIND`, `PORT` and
`BACKUP_DIR` inside the container, and a value for them in `.env` has no effect there. The image sets `PG_BIN` and the packaging hints, so leave
those out too.

These variables belong to the stack, not to the node:

| Variable | Default | |
|---|---|---|
| `HOST_BIND` | `0.0.0.0` | The host address Docker publishes the node on. `127.0.0.1` keeps it to this machine. |
| `HOST_PORT` | `8787` | The host port Docker publishes the node on. `PUBLIC_ORIGIN` must name it. |
| `STUGA_VOLUME_NAME` | `stuga_pgdata` | The Postgres volume. |
| `COMPOSE_PROJECT_NAME` | `stuga` | The Compose project. Give a second stack on the same host its own project, volume and port. |
| `BACKUP_DIR` | `./backups` | Where backups go, the node's own and `./stuga`'s. |
| `BACKUP_KEEP` | `7` | How many backups are kept, the node's own and `./stuga backup`'s. |

To add to the stack, for example another volume, put the change in `compose.override.yml` and set
`COMPOSE_FILE=compose.yml:compose.override.yml` in `.env`, so that `./stuga` uses the same files
as `docker compose`.

### Reaching the node from other devices

The node is published on every address of the machine, and only whoever has its setup code can
claim it ([Getting started](../getting-started.md#2-claim-the-node)). `PUBLIC_ORIGIN` is the address
invite links carry; `install.sh` sets it to this machine's address on the network. Reserve that
address on your router so it does not change. To keep the node to this machine, set
`HOST_BIND=127.0.0.1`. [Network access](../network-access.md) explains what each way of reaching
the node protects.

For HTTPS, put a reverse proxy in front of the node, as
[Network access](../network-access.md#https) describes, or let the node serve TLS itself: mount the
certificate directory into the node container in `compose.override.yml`, set `TLS_CERT_DIR` to its
path inside the container, and set `PUBLIC_ORIGIN` to the https address. The container's health
check and `./stuga` then reach the node over https.

## Operator commands

`./stuga` runs the node's own `stuga-node` commands in a one-off container of the image that
created the node's container, and stops and starts the node around the commands that need that.
What each command does, and its exit codes, are described in [Operations](../operations.md).

| Command | |
|---|---|
| `./stuga status` | Version, schema, whether the node is serving, the last backup, and the setup link while nobody has claimed the node. |
| `./stuga backup` | Stops the node, takes a verified backup, and starts the node again. |
| `./stuga verify <backup>` | Checks that a backup is whole and that this release can restore it. |
| `./stuga list` | Backups, and what restores kept beside the data. |
| `./stuga restore [--yes] <backup>` | Verifies the backup while the node still serves, asks you to type its name, restores it, and starts the node on the release that took the backup. |
| `./stuga upgrade [<version>]` | Fetches the newest release's files (or the named one's), pulls its images unless they are already on the machine, starts them and waits until the node serves. The node backs up before it upgrades. |
| `./stuga reset-password <username>` | Prints a password reset link. The node must be running. |
| `./stuga media-scan [--reclaim] [--empty-trash[=<days>]] [--grace-hours=<hours>]` | Reports or reclaims media no document uses. The node must be running. |

A `<backup>` is a name in `BACKUP_DIR`, or a path inside it. To restore a backup taken elsewhere,
copy its directory into `backups/` first.

The commands wait for a starting node for as long as it shows progress. Two shell variables bound
that wait: `STUGA_READY_QUIET_SECONDS` (default 600) and `STUGA_READY_MAX_SECONDS` (default 7200).

A restore keeps what it replaced. Once you are satisfied, remove both copies. `./stuga list` names
them:

```sh
docker compose exec postgres psql -U stuga -d postgres -c 'DROP DATABASE "stuga_replaced_<stamp>"'
sudo rm -rf data/node.replaced-<stamp>
```

## Upgrade

**Settings → This node → About** names a newer version once the node knows of one
([Operations](../operations.md#learning-of-a-new-version)).

Read the release's **Upgrade notes** first. Then:

```sh
./stuga upgrade            # the newest release
./stuga upgrade 1.2.3      # or a given one
```

It downloads that release's `compose.yml`, `env.example` and `stuga` over the ones you have (your
`.env` is not touched), pulls the new images, starts them and waits until the node serves. The new
version backs up the database before it changes anything, and answers with a page that says so
meanwhile. `./stuga upgrade` ends by printing the version change and the restore command that
undoes it; if the new version does not serve, it prints the command for the node's log and the same
restore command. It refuses an older release than the running one: going back is a restore. Compare
the new `env.example` with your `.env` for settings the release adds.

A NAS app store that updates the images does the same without `./stuga`: the node backs up before it
upgrades, whatever started it.

### Without a connection to the registry

A node that cannot reach `ghcr.io` upgrades from images carried to it. On a machine that is online,
fetch the release's three files and save both images for the node's architecture (`linux/arm64` or
`linux/amd64`):

```sh
V=1.2.3
for f in compose.yml env.example stuga; do
  curl -fsSLO "https://github.com/stuga-dev/stuga/releases/download/v$V/$f"
done
for image in stuga-node stuga-postgres; do
  docker pull --platform linux/arm64 "ghcr.io/stuga-dev/$image:$V"
done
docker save -o "stuga-$V-images.tar" "ghcr.io/stuga-dev/stuga-node:$V" "ghcr.io/stuga-dev/stuga-postgres:$V"
```

Carry the three files and the archive to the node. There, load the images, put the three files over
the ones in the Stuga directory, and upgrade as usual. With a `compose.yml` naming another version
than the running one, `./stuga upgrade` uses it as it is and downloads nothing:

```sh
docker load -i stuga-1.2.3-images.tar
chmod +x stuga
./stuga upgrade
```

The backup, the wait and the way back are the same as with a connection. Keep the previous version's
images until you are satisfied with the new one: a roll back starts the node on them, and
`docker image prune -a` would remove them. A first install works the same way, with
`docker compose up -d` in place of `./stuga upgrade`.

## Roll back

Restore the backup the new version took before it upgraded, which `./stuga upgrade` names:

```sh
./stuga restore <backup>
```

The node comes back on the release whose data the backup holds. Before the next
`docker compose up`, download that release's `compose.yml` from `releases/download/v<version>/`,
because the one in the directory still names the newer images.

## Uninstall

In the Stuga directory:

```sh
docker compose down
```

This removes the containers. Your data stays in `data/`, `backups/` and the `stuga_pgdata` volume.
To delete it and the images too, run `docker compose down -v --rmi all` and remove the directory.
The node writes its files as root, so on Linux that needs `sudo rm -rf`.
