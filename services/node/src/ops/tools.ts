/**
 * The external programs a backup runs and the filesystem facts it measures.
 * Programs get an argument vector, never a shell string, since data paths may
 * hold spaces. pg_dump and pg_restore come from PG_BIN when set: pg_dump refuses
 * a newer server major, and a dump is trusted when the major that wrote it reads
 * it back. `tar` uses only -czf/-tzf/-xzf with COPYFILE_DISABLE=1 (no AppleDouble
 * members), and members are relative to the data directory.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface ToolEnv {
  /** Directory holding pg_dump and pg_restore; null means "whatever PATH finds". */
  pgBin: string | null;
}

export function pgTool(env: ToolEnv, name: "pg_dump" | "pg_restore"): string {
  return env.pgBin ? join(env.pgBin, name) : name;
}

class ToolError extends Error {
  constructor(program: string, code: number | null, stderr: string) {
    super(`${program} exited ${code ?? "on a signal"}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-5).join(" | ")}` : ""}`);
    this.name = "ToolError";
  }
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  /** Aborting stops the program (SIGTERM) and rejects. */
  signal?: AbortSignal;
}

/** Run a program to completion; reject with the tail of its stderr on failure. */
export function run(program: string, args: string[], opts: RunOptions = {}): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { env: opts.env ?? process.env, stdio: ["ignore", "ignore", "pipe"], signal: opts.signal });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new ToolError(program, code, stderr))));
  });
}

const TAR_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, COPYFILE_DISABLE: "1" });

export function createArchive(srcDir: string, archive: string, signal?: AbortSignal): Promise<void> {
  return run("tar", ["-czf", archive, "-C", srcDir, "."], { env: TAR_ENV(), signal });
}

export function extractArchive(archive: string, destDir: string, signal?: AbortSignal): Promise<void> {
  return run("tar", ["-xzf", archive, "-C", destDir], { env: TAR_ENV(), signal });
}

/**
 * Read an archive end to end and report how many members it has and its first
 * one. Listing decompresses the whole gzip stream, so a truncated or corrupted
 * archive fails here rather than on the day it is restored.
 */
export function listArchive(archive: string, signal?: AbortSignal): Promise<{ members: number; first: string | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("tar", ["-tzf", archive], { env: TAR_ENV(), stdio: ["ignore", "pipe", "pipe"], signal });
    let members = 0;
    let first: string | null = null;
    let stderr = "";
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (first === null) first = line;
      members++;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolvePromise({ members, first }) : reject(new ToolError("tar", code, stderr)),
    );
  });
}

export async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** Bytes under a directory, symlinks not followed. Zero for a directory that does not exist. */
export async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else total += (await lstat(path)).size;
  }
  return total;
}

/** Bytes an unprivileged process may still write on the filesystem holding `path`. */
export async function freeBytes(path: string): Promise<number> {
  const s = await statfs(path);
  return Number(s.bavail) * Number(s.bsize);
}
