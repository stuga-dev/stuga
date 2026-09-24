/**
 * Copy standard input into a week of daily log files: <dir>/<name>-<Day>.log.
 *
 *   node rotate-log.mjs <dir> <name>
 *
 * launchd opens a job's StandardOutPath once and never rotates it, and newsyslog can only
 * rotate by renaming, which a running writer keeps writing into; node-wrapper.sh pipes
 * the node through this instead.
 *
 * - The day is the UTC weekday, like Postgres's log_timezone. A day's file last written on
 *   an earlier date is last week's and starts over; one written today is appended to.
 * - A day's file stops at maxBytes with one line saying so: a node in an error loop must
 *   not fill the disk the database lives on.
 * - It exits only when its input ends, never on a write error or SIGTERM/SIGINT/SIGHUP:
 *   the node's next write would otherwise hit a closed pipe, and its shutdown lines be lost.
 */
import { closeSync, fstatSync, mkdirSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

const utcDate = (at) => at.toISOString().slice(0, 10);

/** `onError` receives what could not be written (default: stderr). */
export function createLogWriter({ dir, name, maxBytes = DEFAULT_MAX_BYTES, now = () => new Date(), onError }) {
  const fallback = onError ?? ((chunk) => process.stderr.write(chunk));
  let day = null;
  let fd = null;
  let bytes = 0;
  let capped = false;

  const open = (at) => {
    if (fd !== null) closeSync(fd);
    fd = null;
    day = DAYS[at.getUTCDay()];
    capped = false;
    const path = join(dir, `${name}-${day}.log`);
    let flags = "a";
    try {
      if (utcDate(statSync(path).mtime) !== utcDate(at)) flags = "w";
    } catch {
      // No file yet: "a" creates it.
    }
    fd = openSync(path, flags, 0o640);
    bytes = fstatSync(fd).size;
  };

  return {
    write(chunk) {
      const at = now();
      try {
        if (fd === null || DAYS[at.getUTCDay()] !== day) open(at);
        if (capped) return;
        if (bytes + chunk.length > maxBytes) {
          const note = Buffer.from(`${at.toISOString()} [rotate-log] ${name}-${day}.log reached ${maxBytes} bytes; the rest of today's output is dropped\n`);
          writeSync(fd, note);
          bytes += note.length;
          capped = true;
          return;
        }
        writeSync(fd, chunk);
        bytes += chunk.length;
      } catch {
        fallback(chunk);
      }
    },
    close() {
      if (fd !== null) closeSync(fd);
      fd = null;
    },
  };
}

// Started through the runtime's `current` symlink, so real paths are compared.
const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(import.meta.filename);
  } catch {
    return false;
  }
};

if (isMain()) {
  const [dir, name] = process.argv.slice(2);
  if (!dir || !name) {
    process.stderr.write("usage: node rotate-log.mjs <directory> <name>\n");
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});
  const writer = createLogWriter({ dir, name });
  process.stdin.on("data", (chunk) => writer.write(chunk));
  process.stdin.on("end", () => {
    writer.close();
    process.exit(0);
  });
}
