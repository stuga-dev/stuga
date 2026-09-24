import type { Sql } from "@stuga/db";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../config/env.js";
import {
  assertDatabaseLocale,
  assertPgSearch,
  databaseLocaleProblem,
  PG_MAX_EXCLUSIVE,
  PG_MIN,
  pgSearchProblem,
  postgresVersionProblem,
} from "./preflight.js";

describe("postgresVersionProblem", () => {
  it("accepts the major this node is built for, at any patch level", () => {
    expect(postgresVersionProblem(PG_MIN)).toBeNull();
    expect(postgresVersionProblem(180006)).toBeNull();
    expect(postgresVersionProblem(PG_MAX_EXCLUSIVE - 1)).toBeNull();
  });

  it("refuses an older major and names the dump/restore path", () => {
    const msg = postgresVersionProblem(160004);
    expect(msg).toMatch(/built for Postgres 18/);
    expect(msg).toMatch(/is Postgres 16/);
    expect(msg).toMatch(/Postgres 16 that wrote it, then restore into Postgres 18/);
  });

  it("refuses a newer major and names the Stuga upgrade that reads it", () => {
    const msg = postgresVersionProblem(190001);
    expect(msg).toMatch(/is Postgres 19/);
    expect(msg).toMatch(/This node has written nothing/);
    expect(msg).toMatch(/release built for Postgres 19\.$/);
  });
});

describe("pgSearchProblem", () => {
  it("refuses a server that does not offer the extension, naming the build it needs", () => {
    const msg = pgSearchProblem({ available: false, preloaded: null });
    expect(msg).toMatch(/does not offer the pg_search extension/);
    expect(msg).toMatch(/pg_search built for Postgres 18/);
    expect(msg).toMatch(/shared_preload_libraries/);
    expect(msg).toMatch(/restart Postgres/);
  });

  it("refuses a missing preload", () => {
    const msg = pgSearchProblem({ available: true, preloaded: false });
    expect(msg).toMatch(/missing from shared_preload_libraries/);
    expect(msg).toMatch(/restart Postgres/);
  });

  it("says nothing when the setting could not be read", () => {
    expect(pgSearchProblem({ available: true, preloaded: null })).toBeNull();
  });

  it("accepts an available, preloaded extension", () => {
    expect(pgSearchProblem({ available: true, preloaded: true })).toBeNull();
  });
});

describe("databaseLocaleProblem", () => {
  it("accepts the builtin provider's C.UTF-8", () => {
    expect(databaseLocaleProblem({ provider: "b", locale: "C.UTF-8", collate: "C.UTF-8" })).toBeNull();
  });

  it("refuses another builtin locale", () => {
    const msg = databaseLocaleProblem({ provider: "b", locale: "C", collate: "C" });
    expect(msg).toMatch(/builtin provider's "C",/);
    expect(msg).toMatch(/This node has written nothing/);
  });

  it("refuses an operating-system collation, naming it and both ways to create a matching database", () => {
    const msg = databaseLocaleProblem({ provider: "c", locale: null, collate: "en_US.utf8" });
    expect(msg).toMatch(/operating system's "en_US\.utf8"/);
    expect(msg).toMatch(/initdb --locale-provider=builtin --builtin-locale=C\.UTF-8/);
    expect(msg).toMatch(/LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C\.UTF-8' TEMPLATE template0/);
  });

  it("refuses an ICU collation", () => {
    expect(databaseLocaleProblem({ provider: "i", locale: "und-x-icu", collate: "C" })).toMatch(/ICU locale "und-x-icu"/);
  });

  it("names no platform", () => {
    const msg = databaseLocaleProblem({ provider: "c", locale: null, collate: "C" }) ?? "";
    expect(msg).not.toMatch(/docker|compose|launchd|mac/i);
  });
});

describe("assertDatabaseLocale", () => {
  const fakeSql = (rows: unknown[]): Sql => (() => Promise.resolve(rows)) as unknown as Sql;

  it("boots on a builtin C.UTF-8 database", async () => {
    await expect(assertDatabaseLocale(fakeSql([{ provider: "b", locale: "C.UTF-8", collate: "C.UTF-8" }]))).resolves.toBeUndefined();
  });

  it("refuses any other database with a configuration error", async () => {
    const sql = fakeSql([{ provider: "c", locale: null, collate: "en_US.utf8" }]);
    await expect(assertDatabaseLocale(sql)).rejects.toThrow(ConfigError);
    await expect(assertDatabaseLocale(sql)).rejects.toThrow(/en_US\.utf8/);
  });
});

describe("assertPgSearch", () => {
  /** A template tag answering the catalog query and SHOW the way postgres.js shapes their rows. */
  function fakeSql(catalog: { available: boolean }, show: () => Promise<unknown[]>): Sql {
    const tag = (strings: TemplateStringsArray): Promise<unknown[]> =>
      strings.join("").includes("SHOW shared_preload_libraries") ? show() : Promise.resolve([catalog]);
    return tag as unknown as Sql;
  }

  it("reads the setting from the column SHOW names after it", async () => {
    const preloading = fakeSql({ available: true }, () =>
      Promise.resolve([{ shared_preload_libraries: "$libdir/pg_search" }]),
    );
    await expect(assertPgSearch(preloading)).resolves.toBeUndefined();
    const notPreloading = fakeSql({ available: true }, () =>
      Promise.resolve([{ shared_preload_libraries: "pg_stat_statements" }]),
    );
    await expect(assertPgSearch(notPreloading)).rejects.toThrow(/shared_preload_libraries/);
  });

  it("refuses when the setting does not list pg_search", async () => {
    const sql = fakeSql({ available: true }, () =>
      Promise.resolve([{ shared_preload_libraries: "pg_stat_statements" }]),
    );
    await expect(assertPgSearch(sql)).rejects.toThrow(ConfigError);
    await expect(assertPgSearch(sql)).rejects.toThrow(/missing from shared_preload_libraries/);
  });

  it("refuses a server that does not offer the extension", async () => {
    const sql = fakeSql({ available: false }, () =>
      Promise.resolve([{ shared_preload_libraries: "" }]),
    );
    await expect(assertPgSearch(sql)).rejects.toThrow(/does not offer the pg_search extension/);
  });

  it("boots when the role may not read the setting", async () => {
    const sql = fakeSql({ available: true }, () =>
      Promise.reject(new Error("permission denied to examine \"shared_preload_libraries\"")),
    );
    await expect(assertPgSearch(sql)).resolves.toBeUndefined();
  });
});
