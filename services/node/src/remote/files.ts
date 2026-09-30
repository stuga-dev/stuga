/**
 * Files remote access writes (docs/remote-access.md): a write that survives a crash at any point,
 * and the directory the node shares with the connector, checked before anything goes into it, or,
 * where the connector is kept apart by a group of its own, arranged.
 */
import { constants, type Stats } from "node:fs";
import { chmod, lchown, lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RemoteGroup } from "../config/env.js";

/** macOS's `sun_path` is 104 bytes with its terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = 103;

export const SOCKET_NAME = "https.sock";
/** With a group: where the node asks, and where the connector answers. */
const CONTROL_DIR = "control";
const STATUS_DIR = "status";

/** The node's files in the shared directory, which a group arrangement also puts right. */
const CONNECTOR_FILE = /^[a-z0-9-]{1,32}\.(toml|jwt|ca\.pem)$/;
const CONNECTOR_FILE_MODE = 0o640;

/** The shared directory, or the socket path in it, cannot be used; says which and why. */
export class RemoteDirError extends Error {
  constructor(
    readonly code: "remote_dir_unusable" | "socket_path_too_long",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Write `data` so that `path` holds either the old content or all of the new, whatever happens:
 * a temporary file created with `mode`, and `gid` when given, flushed, renamed over `path`, then the
 * directory flushed.
 */
export async function writeFileDurable(path: string, data: string | Uint8Array, mode: number, opts: { gid?: number | undefined } = {}): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  let handle;
  try {
    handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  } catch (e) {
    // Left by a run of this pid that died mid-write; nothing else writes this name.
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    await unlink(tmp);
    handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  }
  try {
    await handle.writeFile(data);
    // The umask narrows the mode given at creation.
    await handle.chmod(mode);
    if (opts.gid !== undefined) await handle.chown(-1, opts.gid);
    await handle.sync();
  } catch (e) {
    await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw e;
  }
  await handle.close();
  await rename(tmp, path);
  await syncDir(dirname(path));
}

/** Flush a directory's entries, so a rename in it is on disk. */
export async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Create `dir` with `mode` where missing, parents included. */
export async function ensurePrivateDir(dir: string, mode: number): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
  await chmod(dir, mode);
}

/** Changes a path's owner and group without following a link: `lchown`, but in tests, which cannot give files away. */
export type Chown = (path: string, uid: number, gid: number) => Promise<void>;

/**
 * The directory shared with the connector, and the socket's path in it, refused when it is too long
 * for a unix socket.
 *
 * Without `group`: created 0750 where missing; one that exists must be a directory this node's user
 * owns and no other user can write to, its group's members included (on macOS that group is usually
 * `staff`, every local user).
 *
 * With `group`, arranged rather than checked, owner and mode put right wherever they are wrong: the
 * directory the node's user's and `group`'s, 02750; `control/`, where the node asks, the same, 0750;
 * `status/`, where the connector answers, its user's and `group`'s, 0750; and the node's files in
 * the directory the node's user's and `group`'s, 0640. Anything else in the directory or `control/`
 * that is not a file of the node's user, or its socket, is removed.
 */
export async function ensureRemoteDir(dir: string, opts: { group?: RemoteGroup | undefined; chown?: Chown } = {}): Promise<string> {
  if (opts.group) await arrangeRemoteDir(dir, opts.group, opts.chown ?? lchown);
  else await checkRemoteDir(dir);
  const socketPath = join(dir, SOCKET_NAME);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new RemoteDirError(
      "socket_path_too_long",
      `${socketPath} is ${Buffer.byteLength(socketPath)} bytes; a unix socket's path can be at most ${MAX_SOCKET_PATH_BYTES}`,
    );
  }
  return socketPath;
}

async function checkRemoteDir(dir: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw unusable(dir, (e as Error).message);
    try {
      await mkdir(dir, { recursive: true, mode: 0o750 });
      await chmod(dir, 0o750);
    } catch (err) {
      throw unusable(dir, `it does not exist and could not be created: ${(err as Error).message}`);
    }
    stat = await lstat(dir);
  }
  if (!stat.isDirectory()) throw unusable(dir, "it is not a directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw unusable(dir, "it belongs to another user");
  }
  if (stat.mode & 0o022) throw unusable(dir, "other users can write to it");
}

/**
 * The directory first: once it is the node's alone to write, nothing else can swap what is in it
 * while the rest is put right. A new volume may have been the connector's when it was mounted.
 */
async function arrangeRemoteDir(dir: string, group: RemoteGroup, chown: Chown): Promise<void> {
  const uid = process.getuid!();
  try {
    await arrange(dir, { uid, gid: group.gid, mode: 0o2750, chown, top: true });
    await arrange(join(dir, CONTROL_DIR), { uid, gid: group.gid, mode: 0o750, chown, top: false });
    await arrange(join(dir, STATUS_DIR), { uid: group.connectorUid, gid: group.gid, mode: 0o750, chown, top: false });
    // Only the node can write these now: whatever it did not write goes, so nothing planted passes for its own.
    for (const name of await readdir(dir)) {
      if (name === CONTROL_DIR || name === STATUS_DIR) continue;
      const path = join(dir, name);
      const stat = await lstat(path);
      if (stat.uid !== uid || !(name === SOCKET_NAME ? stat.isSocket() : stat.isFile())) await removeEntry(path, stat, uid, chown);
      else if (CONNECTOR_FILE.test(name)) await putRight(path, stat, { uid, gid: group.gid, mode: CONNECTOR_FILE_MODE, chown });
    }
    const control = join(dir, CONTROL_DIR);
    for (const name of await readdir(control)) {
      const path = join(control, name);
      const stat = await lstat(path);
      if (stat.uid !== uid || !stat.isFile()) await removeEntry(path, stat, uid, chown);
    }
  } catch (e) {
    if (e instanceof RemoteDirError) throw e;
    throw unusable(dir, (e as Error).message);
  }
}

/** A directory with this owner and mode: created where missing; below the top, whatever else is there replaced. */
async function arrange(path: string, want: { uid: number; gid: number; mode: number; chown: Chown; top: boolean }): Promise<void> {
  let stat = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (stat && !stat.isDirectory()) {
    if (want.top) throw unusable(path, "it is not a directory");
    await unlink(path);
    stat = null;
  }
  if (!stat) {
    await mkdir(path, { recursive: want.top, mode: want.mode });
    stat = await lstat(path);
  }
  await putRight(path, stat, want);
}

async function putRight(path: string, stat: Stats, want: { uid: number; gid: number; mode: number; chown: Chown }): Promise<void> {
  let mode = stat.mode & 0o7777;
  if (stat.uid !== want.uid || stat.gid !== want.gid) {
    await want.chown(path, want.uid, want.gid);
    // A change of owner may clear the setgid bit.
    mode = (await lstat(path)).mode & 0o7777;
  }
  if (mode !== want.mode) await chmod(path, want.mode);
}

/**
 * Remove an entry of a directory only the node can write, never following a link. A directory is
 * made the node's alone before it is read, so nothing in it can be swapped for a link meanwhile.
 */
async function removeEntry(path: string, stat: Stats, uid: number, chown: Chown): Promise<void> {
  if (!stat.isDirectory()) return unlink(path);
  if (stat.uid !== uid) await chown(path, uid, stat.gid);
  await chmod(path, 0o700);
  for (const name of await readdir(path)) {
    const child = join(path, name);
    await removeEntry(child, await lstat(child), uid, chown);
  }
  await rmdir(path);
}

function unusable(dir: string, why: string): RemoteDirError {
  return new RemoteDirError("remote_dir_unusable", `${dir} can't be used for remote access: ${why}`);
}

/** Remove a file; one already gone is fine. */
export async function removeFile(path: string): Promise<void> {
  await unlink(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
}
