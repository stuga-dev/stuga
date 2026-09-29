import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRemoteDir, RemoteDirError, writeFileDurable } from "./files.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
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
