/**
 * Files remote access writes (docs/remote-access.md): a write that survives a crash at any point,
 * and the directory the node shares with the connector, checked before anything goes into it.
 */
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** macOS's `sun_path` is 104 bytes with its terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = 103;

export const SOCKET_NAME = "https.sock";

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
 * a temporary file created with `mode`, flushed, renamed over `path`, then the directory flushed.
 */
export async function writeFileDurable(path: string, data: string | Uint8Array, mode: number): Promise<void> {
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

/**
 * The directory shared with the connector: created 0750 where missing; one that exists must be a
 * directory this node's user owns and no other user can write to, its group's members included
 * (on macOS that group is usually `staff`, every local user). Returns the socket's path, refused
 * when it is too long for a unix socket.
 */
export async function ensureRemoteDir(dir: string): Promise<string> {
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
  const socketPath = join(dir, SOCKET_NAME);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new RemoteDirError(
      "socket_path_too_long",
      `${socketPath} is ${Buffer.byteLength(socketPath)} bytes; a unix socket's path can be at most ${MAX_SOCKET_PATH_BYTES}`,
    );
  }
  return socketPath;
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
