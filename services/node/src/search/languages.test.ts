/**
 * The background pass's order, one-at-a-time and retries, against a fake
 * Postgres that keeps each document's format and the settings column, and a
 * fake writer that records each document it writes with what queries used then.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchFormat, type SearchLanguage, type Sql } from "@stuga/db";
import { createSearchLanguages, type SearchLanguages } from "./languages.js";

interface Write {
  docId: string;
  languages: readonly SearchLanguage[];
  /** What current() said when the document was written. */
  current: readonly SearchLanguage[];
}

/** A write's failure or hold, chosen by the test; undefined writes it. */
type Hook = (docId: string, languages: readonly SearchLanguage[]) => Promise<void> | void;

function fakePostgres(docs: number, languages: readonly SearchLanguage[] = []) {
  const formats = new Map<string, string | null>();
  for (let i = 1; i <= docs; i++) formats.set(`d${String(i).padStart(3, "0")}`, searchFormat(languages));
  const writes: Write[] = [];
  let stored: string[] | null = null;
  let coordinator: SearchLanguages | null = null;
  let hook: Hook = () => {};
  let saveHook: (languages: string[]) => Promise<void> | void = () => {};

  const tagged = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("search_format IS DISTINCT FROM")) {
      const [format, after, , limit] = values as [string, string | null, string | null, number];
      const page = [...formats]
        .filter(([id, f]) => f !== format && (after === null || id > after))
        .map(([id]) => id)
        .sort()
        .slice(0, limit);
      return Promise.resolve(page.map((doc_id) => ({ doc_id })));
    }
    if (text.includes("INSERT INTO node_settings")) {
      const saved = [...(values[0] as string[])];
      return Promise.resolve(saved)
        .then(saveHook)
        .then(() => {
          stored = saved;
          return [];
        });
    }
    return Promise.reject(new Error(`unexpected query: ${text}`));
  };

  const reindex = async (_sql: Sql, docId: string, to: readonly SearchLanguage[]) => {
    writes.push({ docId, languages: to, current: coordinator?.current() ?? [] });
    await hook(docId, to);
    formats.set(docId, searchFormat(to));
  };

  return {
    sql: tagged as unknown as Sql,
    reindex,
    writes,
    stored: () => stored,
    setFormat: (docId: string, format: string) => void formats.set(docId, format),
    /** The documents not yet written for `languages`. */
    behind: (to: readonly SearchLanguage[]) => [...formats].filter(([, f]) => f !== searchFormat(to)).map(([id]) => id),
    watch: (c: SearchLanguages) => void (coordinator = c),
    onWrite: (h: Hook) => void (hook = h),
    /** Run before a save of the setting commits; a rejection fails it. */
    onSave: (h: (languages: string[]) => Promise<void> | void) => void (saveHook = h),
  };
}

function coordinator(pg: ReturnType<typeof fakePostgres>, languages: SearchLanguage[], over: Partial<Parameters<typeof createSearchLanguages>[0]> = {}) {
  const sleeps: number[] = [];
  const c = createSearchLanguages({
    sql: pg.sql,
    languages,
    retryDelaysMs: [5, 30],
    sleep: async (ms) => void sleeps.push(ms),
    reindex: pg.reindex,
    ...over,
  });
  pg.watch(c);
  return { c, sleeps };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the background pass", () => {
  it("writes every document in another format again, a page at a time, while queries already use the new languages", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pg = fakePostgres(250);
    const { c } = coordinator(pg, []);
    let during: unknown = null;
    pg.onWrite(() => void (during ??= c.status()));
    await c.rebuild(["de"]);

    expect(pg.writes).toHaveLength(250);
    expect(new Set(pg.writes.map((w) => w.docId)).size).toBe(250);
    expect(pg.writes.every((w) => w.current.join() === "de" && w.languages.join() === "de")).toBe(true);
    expect(during).toEqual({ languages: ["de"], rebuilding: true, error: null });
    expect(pg.behind(["de"])).toEqual([]);
    expect(c.current()).toEqual(["de"]);
    expect(c.status()).toEqual({ languages: ["de"], rebuilding: false, error: null });
  });

  it("sweeps again for a document a write in the old languages left behind it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pg = fakePostgres(3);
    const { c } = coordinator(pg, []);
    let late = true;
    pg.onWrite((docId) => {
      // An index job that read the languages before the change commits d001 once the sweep is past it.
      if (docId === "d003" && late) {
        late = false;
        pg.setFormat("d001", searchFormat([]));
      }
    });
    await c.rebuild(["de"]);
    expect(pg.writes.map((w) => w.docId)).toEqual(["d001", "d002", "d003", "d001"]);
    expect(pg.behind(["de"])).toEqual([]);
  });

  it("writes nothing when every document is in the languages' format already", async () => {
    const pg = fakePostgres(20, ["de"]);
    const { c } = coordinator(pg, ["de"]);
    await c.rebuild(["de"]);
    expect(pg.writes).toEqual([]);
    expect(c.status()).toEqual({ languages: ["de"], rebuilding: false, error: null });
  });

  it("runs one pass at a time, and a request for other languages stops the one under way", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pg = fakePostgres(10);
    const { c } = coordinator(pg, []);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    pg.onWrite((docId, to) => (docId === "d001" && to.join() === "de" ? held : undefined));

    const first = c.rebuild(["de"]);
    await vi.waitFor(() => expect(pg.writes).toHaveLength(1));
    const second = c.rebuild(["fr"]);
    const third = c.rebuild(["de", "fr"]);
    expect(c.current()).toEqual(["de", "fr"]);
    expect(c.status()).toEqual({ languages: ["de", "fr"], rebuilding: true, error: null });
    release();
    await Promise.all([first, second, third]);

    // The German pass stopped at its first document; the newest request's pass wrote every one.
    expect(pg.writes.filter((w) => w.languages.join() === "de").map((w) => w.docId)).toEqual(["d001"]);
    expect(pg.writes.filter((w) => w.languages.join() === "fr")).toEqual([]);
    expect(pg.behind(["de", "fr"])).toEqual([]);
    expect(c.status().rebuilding).toBe(false);
  });

  it("goes back at once when the languages are changed back while a failed pass waits to try again", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pg = fakePostgres(3, ["ar"]);
    const waits: number[] = [];
    const { c } = coordinator(pg, ["ar"], {
      // A wait that only a stop or a replacing request ends.
      sleep: (ms, signal) =>
        new Promise((_, reject) => {
          waits.push(ms);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    pg.onWrite((docId, to) => {
      if (docId === "d002" && to.join() === "de") throw new Error("deadlock detected");
    });
    const german = c.rebuild(["de"]);
    await vi.waitFor(() => expect(waits).toEqual([5]));
    expect(c.current()).toEqual(["de"]);

    await Promise.all([german, c.rebuild(["ar"])]);
    expect(c.current()).toEqual(["ar"]);
    expect(c.status()).toEqual({ languages: ["ar"], rebuilding: false, error: null });
    // German was not tried again; what it wrote is written back.
    expect(pg.writes.map((w) => `${w.docId} ${w.languages.join()}`)).toEqual(["d001 de", "d002 de", "d003 de", "d001 ar", "d003 ar"]);
    expect(pg.behind(["ar"])).toEqual([]);
  });

  it("writes the rest past a document it cannot write, then tries that one again after a wait", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pg = fakePostgres(3);
    const { c, sleeps } = coordinator(pg, []);
    let failures = 1;
    pg.onWrite((docId) => {
      if (docId === "d002" && failures-- > 0) throw new Error("canceling statement due to lock timeout");
    });
    await c.rebuild(["ar"]);

    expect(sleeps).toEqual([5]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("trying again in 0.005s: 1 document could not be indexed, first d002: canceling statement"));
    expect(pg.writes.map((w) => w.docId)).toEqual(["d001", "d002", "d003", "d002"]);
    expect(pg.behind(["ar"])).toEqual([]);
    expect(c.status()).toEqual({ languages: ["ar"], rebuilding: false, error: null });
  });

  it("gives up once the waits are spent, says why, and tries again when asked", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pg = fakePostgres(2);
    const { c, sleeps } = coordinator(pg, []);
    let failing = true;
    pg.onWrite((docId) => {
      if (failing && docId === "d001") throw new Error("could not extend file: No space left on device");
    });
    await c.rebuild(["ar"]);
    expect(sleeps).toEqual([5, 30]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("gave up writing the keyword index for English, ar after 3 tries"));
    expect(c.status()).toEqual({
      languages: ["ar"],
      rebuilding: false,
      error: "1 document could not be indexed, first d001: could not extend file: No space left on device",
    });
    expect(pg.behind(["ar"])).toEqual(["d001"]);

    failing = false;
    const again = c.rebuild(["ar"]);
    // The failure stands until the next try starts.
    expect(c.status()).toMatchObject({ rebuilding: true, error: null });
    await again;
    expect(pg.behind(["ar"])).toEqual([]);
    expect(c.status()).toEqual({ languages: ["ar"], rebuilding: false, error: null });
  });

  it("does not try a replaced request again", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pg = fakePostgres(2);
    const { c, sleeps } = coordinator(pg, []);
    pg.onWrite((docId, to) => {
      if (to.join() === "de") {
        void c.rebuild(["ar"]);
        throw new Error("could not write the document");
      }
    });
    await c.rebuild(["de"]);
    expect(sleeps).toEqual([]);
    expect(c.current()).toEqual(["ar"]);
    expect(pg.writes.map((w) => `${w.docId} ${w.languages.join()}`)).toEqual(["d001 de", "d001 ar", "d002 ar"]);
  });

  it("stops at the next document when the node stops, and takes no further requests", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pg = fakePostgres(5);
    const { c, sleeps } = coordinator(pg, []);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    pg.onWrite((docId) => (docId === "d001" ? held : undefined));
    const rebuilding = c.rebuild(["de"]);
    await vi.waitFor(() => expect(pg.writes).toHaveLength(1));
    const stopped = c.stop();
    release();
    await Promise.all([stopped, rebuilding]);
    expect(pg.writes.map((w) => w.docId)).toEqual(["d001"]);
    expect(sleeps).toEqual([]);
    expect(c.status().rebuilding).toBe(false);

    await c.rebuild(["ar"]);
    expect(pg.writes).toHaveLength(1);
  });
});

describe("a save of the languages", () => {
  it("waits for the save before it, so the pass goes to the one that committed last", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pg = fakePostgres(2);
    const { c } = coordinator(pg, []);
    const sent: string[][] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    pg.onSave((languages) => {
      sent.push(languages);
      return languages.includes("de") ? held : undefined;
    });

    const german = c.save(["de"], "u_liv");
    const arabic = c.save(["ar"], "u_liv");
    await vi.waitFor(() => expect(sent).toEqual([["de"]]));
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([["de"]]);
    release();
    await Promise.all([german, arabic]);

    expect(sent).toEqual([["de"], ["ar"]]);
    expect(pg.stored()).toEqual(["ar"]);
    expect(c.status().languages).toEqual(["ar"]);
    await c.rebuild(["ar"]);
    expect(c.current()).toEqual(["ar"]);
    expect(pg.behind(["ar"])).toEqual([]);
  });

  it("rejects when the save fails, writes nothing for it, and lets the next one go", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pg = fakePostgres(2);
    const { c } = coordinator(pg, []);
    pg.onSave((languages) => {
      if (languages.includes("de")) throw new Error("connection terminated");
    });
    const german = c.save(["de"], "u_liv");
    const arabic = c.save(["ar"], "u_liv");
    await expect(german).rejects.toThrow("connection terminated");
    await arabic;
    expect(pg.stored()).toEqual(["ar"]);
    await c.rebuild(["ar"]);
    expect(pg.writes.every((w) => w.languages.join() === "ar")).toBe(true);
    expect(pg.behind(["ar"])).toEqual([]);
  });
});
