/**
 * The online rebuild's order, one-at-a-time and retries, against a fake
 * Postgres that keeps the bm25 catalog and the settings column and records
 * each statement with the languages queries could name while it ran.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchLanguage, Sql } from "@stuga/db";
import { createSearchLanguages, type SearchLanguages } from "./languages.js";

interface FakeIndex {
  name: string;
  table: string;
  valid: boolean;
  builtBy: string | null;
}

interface Step {
  statement: string;
  /** What current() said when the statement was sent. */
  queryable: readonly SearchLanguage[];
}

/** A statement's failure or hold, chosen by the test; undefined runs it. */
type Hook = (statement: string) => Promise<void> | void;

function fakePostgres(indexes: string[]) {
  const catalog: FakeIndex[] = indexes.map((name) => ({
    name,
    table: name.startsWith("docs_") ? "docs" : "doc_chunks",
    valid: true,
    builtBy: "pg_search 0.25.9",
  }));
  const steps: Step[] = [];
  const cancelled: string[] = [];
  let stored: string[] | null = null;
  let coordinator: SearchLanguages | null = null;
  let hook: Hook = () => {};
  let saveHook: (languages: string[]) => Promise<void> | void = () => {};

  const tagged = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("FROM pg_available_extensions")) return Promise.resolve([{ default_version: "0.25.9" }]);
    if (text.includes("amname = 'bm25'")) return Promise.resolve(catalog.map((i) => ({ ...i })));
    if (text.includes("SELECT search_languages FROM node_settings")) {
      return Promise.resolve(stored === null ? [] : [{ search_languages: stored }]);
    }
    if (text.includes("INSERT INTO node_settings")) {
      const languages = [...(values[0] as string[])];
      return Promise.resolve(languages)
        .then(saveHook)
        .then(() => {
          stored = languages;
          return [];
        });
    }
    return Promise.reject(new Error(`unexpected query: ${text}`));
  };

  const unsafe = (statement: string) => {
    let reject!: (err: Error) => void;
    let settled = false;
    const query = new Promise<void>((resolve, rej) => {
      reject = rej;
      steps.push({ statement: statement.split("\n")[0]!.trim(), queryable: coordinator?.current() ?? [] });
      Promise.resolve(hook(statement))
        .then(() => {
          if (settled) return;
          apply(statement);
          resolve();
        })
        .catch(rej);
    });
    return Object.assign(query, {
      cancel: () => {
        if (settled) return;
        settled = true;
        cancelled.push(statement.split("\n")[0]!.trim().replace(/ USING bm25 \($/, ""));
        // As Postgres does, a cancelled concurrent build leaves its index behind, invalid.
        const build = /^CREATE INDEX CONCURRENTLY (\w+) ON (\w+)/.exec(statement);
        if (build) catalog.push({ name: build[1]!, table: build[2]!, valid: false, builtBy: null });
        reject(new Error("canceling statement due to user request"));
      },
    });
  };

  function apply(statement: string): void {
    const create = /^CREATE INDEX (CONCURRENTLY )?(\w+) ON (\w+)/.exec(statement);
    if (create) {
      if (catalog.some((i) => i.name === create[2])) throw new Error(`relation "${create[2]}" already exists`);
      catalog.push({ name: create[2]!, table: create[3]!, valid: true, builtBy: null });
      return;
    }
    const drop = /^DROP INDEX (CONCURRENTLY )?IF EXISTS "(\w+)"/.exec(statement);
    if (drop) {
      catalog.splice(catalog.findIndex((i) => i.name === drop[2]) >>> 0, 1);
      return;
    }
    const comment = /^COMMENT ON INDEX "(\w+)" IS '(.*)'$/.exec(statement);
    if (comment) {
      catalog.find((i) => i.name === comment[1])!.builtBy = comment[2]!;
      return;
    }
    throw new Error(`unexpected statement: ${statement}`);
  }

  return {
    sql: Object.assign(tagged, { unsafe }) as unknown as Sql,
    catalog,
    steps,
    cancelled,
    stored: () => stored,
    watch: (c: SearchLanguages) => void (coordinator = c),
    onStatement: (h: Hook) => void (hook = h),
    /** Run before a save of the setting commits; a rejection fails it. */
    onSave: (h: (languages: string[]) => Promise<void> | void) => void (saveHook = h),
    /** Leave an invalid index under the name the next concurrent build of `table` makes, and fail it. */
    failNextBuild(table: string) {
      const previous = hook;
      let done = false;
      hook = (statement) => {
        const m = /^CREATE INDEX CONCURRENTLY (\w+) ON (\w+)/.exec(statement);
        if (!done && m && m[2] === table) {
          done = true;
          catalog.push({ name: m[1]!, table, valid: false, builtBy: null });
          throw new Error("could not build the index: concurrent update");
        }
        return previous(statement);
      };
    },
  };
}

const BASE = ["docs_bm25_v1", "doc_chunks_bm25_v1"];
const names = (pg: ReturnType<typeof fakePostgres>) => pg.catalog.map((i) => `${i.name}${i.valid ? "" : " (invalid)"}`).sort();
const statements = (pg: ReturnType<typeof fakePostgres>) => pg.steps.map((s) => s.statement.replace(/ USING bm25 \($/, ""));

function coordinator(pg: ReturnType<typeof fakePostgres>, languages: SearchLanguage[], over: Partial<Parameters<typeof createSearchLanguages>[0]> = {}) {
  const sleeps: number[] = [];
  const c = createSearchLanguages({
    sql: pg.sql,
    languages,
    retryDelaysMs: [5, 30],
    sleep: async (ms) => void sleeps.push(ms),
    ...over,
  });
  pg.watch(c);
  return { c, sleeps };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the online rebuild", () => {
  it("builds each table's new index concurrently, drops its old one, and only then lets queries name the new languages", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pg = fakePostgres(BASE);
    const { c } = coordinator(pg, []);
    await c.rebuild(["ko"]);

    expect(statements(pg)).toEqual([
      "CREATE INDEX CONCURRENTLY docs_bm25_v1_ko ON docs",
      `COMMENT ON INDEX "docs_bm25_v1_ko" IS 'pg_search 0.25.9'`,
      `DROP INDEX CONCURRENTLY IF EXISTS "docs_bm25_v1"`,
      "CREATE INDEX CONCURRENTLY doc_chunks_bm25_v1_ko ON doc_chunks",
      `COMMENT ON INDEX "doc_chunks_bm25_v1_ko" IS 'pg_search 0.25.9'`,
      `DROP INDEX CONCURRENTLY IF EXISTS "doc_chunks_bm25_v1"`,
    ]);
    // Nothing named Korean until the index without it was gone.
    expect(pg.steps.every((s) => s.queryable.length === 0)).toBe(true);
    expect(c.current()).toEqual(["ko"]);
    expect(names(pg)).toEqual(["doc_chunks_bm25_v1_ko", "docs_bm25_v1_ko"]);
    expect(c.status()).toEqual({ languages: ["ko"], rebuilding: false, error: null });
  });

  it("names only the languages both sets share while it runs", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pg = fakePostgres(["docs_bm25_v1_ko", "doc_chunks_bm25_v1_ko"]);
    const { c } = coordinator(pg, ["ko"]);
    let during: unknown = null;
    pg.onStatement(() => void (during ??= { current: c.current(), status: c.status() }));
    await c.rebuild(["ko", "ar"]);
    expect(during).toEqual({ current: ["ko"], status: { languages: ["ko", "ar"], rebuilding: true, error: null } });
    expect(pg.steps.map((s) => s.queryable)).toEqual(pg.steps.map(() => ["ko"]));
    expect(c.current()).toEqual(["ko", "ar"]);
    expect(names(pg)).toEqual(["doc_chunks_bm25_v1_ar_ko", "docs_bm25_v1_ar_ko"]);

    // Korean off: nothing extra is named until the Korean indexes are gone.
    pg.steps.length = 0;
    await c.rebuild(["ar"]);
    expect(pg.steps.map((s) => s.queryable)).toEqual(pg.steps.map(() => ["ar"]));
    expect(c.current()).toEqual(["ar"]);
  });

  it("does nothing for the languages the indexes are already built for", async () => {
    const pg = fakePostgres(BASE);
    const { c } = coordinator(pg, []);
    await c.rebuild([]);
    expect(pg.steps).toEqual([]);
    expect(c.status()).toEqual({ languages: [], rebuilding: false, error: null });
  });

  it("runs one rebuild at a time, and a request for other languages stops the one under way", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pg = fakePostgres(BASE);
    const { c } = coordinator(pg, []);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    pg.onStatement((statement) => (statement.startsWith("CREATE INDEX CONCURRENTLY docs_bm25_v1_ko ") ? held : undefined));

    const first = c.rebuild(["ko"]);
    await vi.waitFor(() => expect(pg.steps).toHaveLength(1));
    const second = c.rebuild(["ar"]);
    const third = c.rebuild(["ko", "ar"]);
    expect(c.status()).toEqual({ languages: ["ko", "ar"], rebuilding: true, error: null });
    await Promise.all([first, second, third]);
    release();

    expect(pg.cancelled).toEqual(["CREATE INDEX CONCURRENTLY docs_bm25_v1_ko ON docs"]);
    expect(statements(pg).filter((s) => s.startsWith("CREATE"))).toEqual([
      "CREATE INDEX CONCURRENTLY docs_bm25_v1_ko ON docs",
      "CREATE INDEX CONCURRENTLY docs_bm25_v1_ar_ko ON docs",
      "CREATE INDEX CONCURRENTLY doc_chunks_bm25_v1_ar_ko ON doc_chunks",
    ]);
    // The newest request's pass drops what the stopped build left.
    expect(statements(pg)).toContain(`DROP INDEX CONCURRENTLY IF EXISTS "docs_bm25_v1_ko"`);
    expect(names(pg)).toEqual(["doc_chunks_bm25_v1_ar_ko", "docs_bm25_v1_ar_ko"]);
    expect(c.current()).toEqual(["ko", "ar"]);
    expect(c.status().rebuilding).toBe(false);
  });

  it("goes back at once when the languages are changed back while a failed build waits to try again", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pg = fakePostgres(["docs_bm25_v1_ar", "doc_chunks_bm25_v1_ar"]);
    const waits: number[] = [];
    const { c } = coordinator(pg, ["ar"], {
      // A wait that only a stop or a replacing request ends.
      sleep: (ms, signal) =>
        new Promise((_, reject) => {
          waits.push(ms);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    pg.failNextBuild("docs");
    const korean = c.rebuild(["ko"]);
    await vi.waitFor(() => expect(waits).toEqual([5]));
    expect(c.current()).toEqual([]);

    await Promise.all([korean, c.rebuild(["ar"])]);
    expect(c.current()).toEqual(["ar"]);
    expect(c.status()).toEqual({ languages: ["ar"], rebuilding: false, error: null });
    // Korean was not tried again, and only its leftover went.
    expect(statements(pg).filter((s) => s.startsWith("CREATE"))).toEqual(["CREATE INDEX CONCURRENTLY docs_bm25_v1_ko ON docs"]);
    expect(names(pg)).toEqual(["doc_chunks_bm25_v1_ar", "docs_bm25_v1_ar"]);
  });

  it("drops what a failed build left and tries again after a wait, naming only the shared languages meanwhile", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pg = fakePostgres(BASE);
    const { c, sleeps } = coordinator(pg, []);
    pg.failNextBuild("doc_chunks");
    await c.rebuild(["ar"]);

    expect(sleeps).toEqual([5]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("trying again in 0.005s: could not build the index"));
    expect(statements(pg)).toEqual([
      "CREATE INDEX CONCURRENTLY docs_bm25_v1_ar ON docs",
      `COMMENT ON INDEX "docs_bm25_v1_ar" IS 'pg_search 0.25.9'`,
      `DROP INDEX CONCURRENTLY IF EXISTS "docs_bm25_v1"`,
      "CREATE INDEX CONCURRENTLY doc_chunks_bm25_v1_ar ON doc_chunks",
      // The second try keeps the docs index it built, and clears the invalid one before building its name again.
      `DROP INDEX CONCURRENTLY IF EXISTS "doc_chunks_bm25_v1_ar"`,
      "CREATE INDEX CONCURRENTLY doc_chunks_bm25_v1_ar ON doc_chunks",
      `COMMENT ON INDEX "doc_chunks_bm25_v1_ar" IS 'pg_search 0.25.9'`,
      `DROP INDEX CONCURRENTLY IF EXISTS "doc_chunks_bm25_v1"`,
    ]);
    expect(pg.steps.every((s) => s.queryable.length === 0)).toBe(true);
    expect(names(pg)).toEqual(["doc_chunks_bm25_v1_ar", "docs_bm25_v1_ar"]);
    expect(c.current()).toEqual(["ar"]);
  });

  it("gives up once the waits are spent, says why, keeps to the shared languages, and tries again when asked", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pg = fakePostgres(["docs_bm25_v1_ko", "doc_chunks_bm25_v1_ko"]);
    const { c, sleeps } = coordinator(pg, ["ko"]);
    let failing = true;
    pg.onStatement((statement) => {
      if (failing && statement.startsWith("CREATE INDEX CONCURRENTLY docs_")) throw new Error("canceling statement due to statement timeout");
    });
    await c.rebuild(["ko", "ar"]);
    expect(sleeps).toEqual([5, 30]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("gave up rebuilding the keyword indexes for ko, ar after 3 tries"));
    expect(c.status()).toEqual({ languages: ["ko", "ar"], rebuilding: false, error: "canceling statement due to statement timeout" });
    expect(c.current()).toEqual(["ko"]);
    expect(names(pg)).toEqual(["doc_chunks_bm25_v1_ko", "docs_bm25_v1_ko"]);

    failing = false;
    const again = c.rebuild(["ko", "ar"]);
    // The failure stands until the next try starts.
    expect(c.status()).toMatchObject({ rebuilding: true, error: null });
    await again;
    expect(c.current()).toEqual(["ko", "ar"]);
    expect(names(pg)).toEqual(["doc_chunks_bm25_v1_ar_ko", "docs_bm25_v1_ar_ko"]);
  });

  it("does not try a replaced request again", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pg = fakePostgres(BASE);
    const { c, sleeps } = coordinator(pg, []);
    let replaced = false;
    pg.onStatement((statement) => {
      if (statement.startsWith("CREATE INDEX CONCURRENTLY docs_bm25_v1_ko ")) {
        void c.rebuild(["ar"]);
        replaced = true;
        pg.catalog.push({ name: "docs_bm25_v1_ko", table: "docs", valid: false, builtBy: null });
        throw new Error("could not build the index");
      }
    });
    await c.rebuild(["ko"]);
    expect(replaced).toBe(true);
    expect(sleeps).toEqual([]);
    expect(c.current()).toEqual(["ar"]);
    // The invalid Korean leftover goes with the other indexes the Arabic set does not want.
    expect(names(pg)).toEqual(["doc_chunks_bm25_v1_ar", "docs_bm25_v1_ar"]);
  });

  it("cancels the statement in flight when the node stops, and takes no further requests", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pg = fakePostgres(BASE);
    const { c, sleeps } = coordinator(pg, []);
    pg.onStatement((statement) => (statement.startsWith("CREATE INDEX CONCURRENTLY") ? new Promise<void>(() => {}) : undefined));
    const rebuilding = c.rebuild(["ko"]);
    await vi.waitFor(() => expect(pg.steps).toHaveLength(1));
    await c.stop();
    await rebuilding;
    expect(pg.cancelled).toEqual(["CREATE INDEX CONCURRENTLY docs_bm25_v1_ko ON docs"]);
    expect(sleeps).toEqual([]);
    expect(c.status().rebuilding).toBe(false);
    expect(c.current()).toEqual([]);

    await c.rebuild(["ar"]);
    expect(pg.steps).toHaveLength(1);
  });
});

describe("a save of the languages", () => {
  it("waits for the save before it, so the rebuild goes to the one that committed last", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pg = fakePostgres(BASE);
    const { c } = coordinator(pg, []);
    const sent: string[][] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    pg.onSave((languages) => {
      sent.push(languages);
      return languages.includes("ko") ? held : undefined;
    });

    const korean = c.save(["ko"], "u_liv");
    const arabic = c.save(["ar"], "u_liv");
    await vi.waitFor(() => expect(sent).toEqual([["ko"]]));
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([["ko"]]);
    release();
    await Promise.all([korean, arabic]);

    expect(sent).toEqual([["ko"], ["ar"]]);
    expect(pg.stored()).toEqual(["ar"]);
    expect(c.status().languages).toEqual(["ar"]);
    await c.rebuild(["ar"]);
    expect(c.current()).toEqual(["ar"]);
    expect(names(pg)).toEqual(["doc_chunks_bm25_v1_ar", "docs_bm25_v1_ar"]);
  });

  it("rejects when the save fails, rebuilds nothing for it, and lets the next one go", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const pg = fakePostgres(BASE);
    const { c } = coordinator(pg, []);
    pg.onSave((languages) => {
      if (languages.includes("ko")) throw new Error("connection terminated");
    });
    const korean = c.save(["ko"], "u_liv");
    const arabic = c.save(["ar"], "u_liv");
    await expect(korean).rejects.toThrow("connection terminated");
    await arabic;
    expect(pg.stored()).toEqual(["ar"]);
    await c.rebuild(["ar"]);
    expect(statements(pg).filter((s) => s.startsWith("CREATE"))).toEqual([
      "CREATE INDEX CONCURRENTLY docs_bm25_v1_ar ON docs",
      "CREATE INDEX CONCURRENTLY doc_chunks_bm25_v1_ar ON doc_chunks",
    ]);
  });
});
