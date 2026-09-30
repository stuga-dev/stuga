import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { lchown } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRemoteDir, RemoteDirError, writeFileDurable, type Chown } from "./files.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A group this user is in, other than its own where it has one: only such a group can be given without root. */
const OTHER_GID = process.getgroups!().find((g) => g !== process.getgid!()) ?? process.getgid!();
const UID = process.getuid!();

const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "stuga-files-"));
  dirs.push(d);
  return d;
};

describe("writeFileDurable", () => {
  it("writes with the mode asked for, whatever the umask, and leaves no temporary file", async () => {
    const dir = tempDir();
    const previous = process.umask(0o077);
    try {
      await writeFileDurable(join(dir, "relay-1.jwt"), "a.b.c\n", 0o640);
    } finally {
      process.umask(previous);
    }
    expect(statSync(join(dir, "relay-1.jwt")).mode & 0o777).toBe(0o640);
    expect(readFileSync(join(dir, "relay-1.jwt"), "utf8")).toBe("a.b.c\n");
    expect(readdirSync(dir)).toEqual(["relay-1.jwt"]);
  });

  it("replaces a file whole, past a temporary file an earlier run of this process left", async () => {
    const dir = tempDir();
    const path = join(dir, "certificate.pem");
    await writeFileDurable(path, "old", 0o600);
    writeFileSync(`${path}.tmp-${process.pid}`, "half");
    await writeFileDurable(path, "new", 0o600);
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["certificate.pem"]);
  });

  it("gives the file the group asked for", async () => {
    const dir = tempDir();
    await writeFileDurable(join(dir, "relay-1.jwt"), "a.b.c\n", 0o640, { gid: OTHER_GID });
    expect(statSync(join(dir, "relay-1.jwt")).gid).toBe(OTHER_GID);
    expect(statSync(join(dir, "relay-1.jwt")).mode & 0o777).toBe(0o640);
  });
});

describe("ensureRemoteDir", () => {
  it("creates a missing directory 0750, parents included, and names the socket in it", async () => {
    const dir = join(tempDir(), "home", ".stuga-remote");
    expect(await ensureRemoteDir(dir)).toBe(join(dir, "https.sock"));
    expect(statSync(dir).mode & 0o777).toBe(0o750);
  });

  it("takes a directory this user owns that no one else can write to", async () => {
    const dir = tempDir();
    chmodSync(dir, 0o755);
    await expect(ensureRemoteDir(dir)).resolves.toBe(join(dir, "https.sock"));
  });

  it("refuses a directory other users can write to, through its group too", async () => {
    const dir = tempDir();
    for (const mode of [0o777, 0o770, 0o730]) {
      chmodSync(dir, mode);
      await expect(ensureRemoteDir(dir)).rejects.toMatchObject({ code: "remote_dir_unusable", message: expect.stringContaining("other users can write") });
    }
  });

  it("refuses a path that is a file", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "file"), "");
    await expect(ensureRemoteDir(join(dir, "file"))).rejects.toMatchObject({ code: "remote_dir_unusable" });
  });

  it("refuses a directory it cannot create", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "locked"), { mode: 0o500 });
    const err = await ensureRemoteDir(join(dir, "locked", "remote")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteDirError);
    expect(err).toMatchObject({ code: "remote_dir_unusable" });
  });

  it("refuses a socket path longer than a unix socket can take", async () => {
    const dir = join(tempDir(), "x".repeat(110));
    await expect(ensureRemoteDir(dir)).rejects.toMatchObject({ code: "socket_path_too_long" });
  });
});

describe("ensureRemoteDir with a group", () => {
  const group = { gid: OTHER_GID, connectorUid: UID };
  const mode = (path: string) => lstatSync(path).mode & 0o7777;

  /** The real lchown, which records what it was asked. */
  const recording = () => {
    const calls: Array<[string, number, number]> = [];
    const chown: Chown = async (path, uid, gid) => {
      calls.push([path, uid, gid]);
      await lchown(path, uid, gid);
    };
    return { calls, chown };
  };

  it("creates the directory 02750, control/ and status/ 0750, all the group's", async () => {
    const dir = join(tempDir(), "stuga-remote");
    expect(await ensureRemoteDir(dir, { group })).toBe(join(dir, "https.sock"));
    expect(mode(dir)).toBe(0o2750);
    expect(mode(join(dir, "control"))).toBe(0o750);
    expect(mode(join(dir, "status"))).toBe(0o750);
    for (const path of [dir, join(dir, "control"), join(dir, "status")]) expect(lstatSync(path)).toMatchObject({ uid: UID, gid: OTHER_GID });
  });

  it("puts wrong modes right rather than refusing, and changes nothing that is right", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "control"), { mode: 0o777 });
    mkdirSync(join(dir, "status"));
    chmodSync(join(dir, "control"), 0o777);
    chmodSync(join(dir, "status"), 0o700);
    chmodSync(dir, 0o777);
    writeFileSync(join(dir, "relay-1.toml"), "x", { mode: 0o666 });
    writeFileSync(join(dir, "relay-1.jwt"), "x", { mode: 0o600 });
    writeFileSync(join(dir, "notes.txt"), "x", { mode: 0o600 });
    chmodSync(join(dir, "relay-1.toml"), 0o666);
    await ensureRemoteDir(dir, { group });
    expect(mode(dir)).toBe(0o2750);
    expect(mode(join(dir, "control"))).toBe(0o750);
    expect(mode(join(dir, "status"))).toBe(0o750);
    expect(mode(join(dir, "relay-1.toml"))).toBe(0o640);
    expect(mode(join(dir, "relay-1.jwt"))).toBe(0o640);
    expect(lstatSync(join(dir, "relay-1.jwt")).gid).toBe(OTHER_GID);
    // Not the node's: left alone.
    expect(mode(join(dir, "notes.txt"))).toBe(0o600);

    const { calls, chown } = recording();
    await ensureRemoteDir(dir, { group, chown });
    expect(calls).toEqual([]);
  });

  it("gives each place its owner: the node's user, and the connector's for status/", async () => {
    const dir = tempDir();
    const calls: Array<[string, number, number]> = [];
    // Other ids than this user can give: only recorded.
    const chown: Chown = async (path, uid, gid) => void calls.push([path, uid, gid]);
    await ensureRemoteDir(dir, { group: { gid: 65532, connectorUid: 65533 }, chown });
    expect(calls).toEqual([
      [dir, UID, 65532],
      [join(dir, "control"), UID, 65532],
      [join(dir, "status"), 65533, 65532],
    ]);
  });

  it("replaces a link or a file where control/ and status/ go, never following it", async () => {
    const dir = tempDir();
    const elsewhere = tempDir();
    chmodSync(elsewhere, 0o700);
    symlinkSync(elsewhere, join(dir, "control"));
    writeFileSync(join(dir, "status"), "not a directory");
    await ensureRemoteDir(dir, { group });
    expect(lstatSync(join(dir, "control")).isDirectory()).toBe(true);
    expect(lstatSync(join(dir, "status")).isDirectory()).toBe(true);
    expect(mode(elsewhere)).toBe(0o700);
  });

  it("removes what the node would not have written, never following a link, and keeps the rest", async () => {
    const dir = tempDir();
    const elsewhere = tempDir();
    writeFileSync(join(elsewhere, "target"), "x", { mode: 0o600 });
    symlinkSync(join(elsewhere, "target"), join(dir, "relay-1.jwt"));
    mkdirSync(join(dir, "relay-1.toml", "deeper"), { recursive: true, mode: 0o777 });
    symlinkSync(elsewhere, join(dir, "relay-1.toml", "deeper", "out"));
    writeFileSync(join(dir, "relay-1.toml", "deeper", "file"), "x", { mode: 0o400 });
    writeFileSync(join(dir, "https.sock"), "not a socket");
    mkdirSync(join(dir, "control", "request"), { recursive: true });
    writeFileSync(join(dir, "control", ".request.1f2e.tmp"), "off\n");
    writeFileSync(join(dir, "relay-1.ca.pem"), "x");
    writeFileSync(join(dir, "notes.txt"), "x");
    mkdirSync(join(dir, "status"));
    writeFileSync(join(dir, "status", "status.json"), "{}");
    await ensureRemoteDir(dir, { group });
    expect(readdirSync(dir).sort()).toEqual(["control", "notes.txt", "relay-1.ca.pem", "status"]);
    expect(readdirSync(join(dir, "control"))).toEqual([".request.1f2e.tmp"]);
    expect(readdirSync(join(dir, "status"))).toEqual(["status.json"]);
    expect(readdirSync(elsewhere)).toEqual(["target"]);
    expect(mode(join(elsewhere, "target"))).toBe(0o600);
  });

  it("still refuses a path that is not a directory, or one it cannot arrange", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "file"), "");
    await expect(ensureRemoteDir(join(dir, "file"), { group })).rejects.toMatchObject({ code: "remote_dir_unusable" });
    symlinkSync(tempDir(), join(dir, "link"));
    await expect(ensureRemoteDir(join(dir, "link"), { group })).rejects.toMatchObject({ code: "remote_dir_unusable" });
    const refuse: Chown = async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    };
    const err = await ensureRemoteDir(join(dir, "remote"), { group: { gid: 65532, connectorUid: 65532 }, chown: refuse }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteDirError);
    expect(err).toMatchObject({ code: "remote_dir_unusable", message: expect.stringContaining("EPERM") });
  });
});
