import type { TableSchema } from "@stuga/protocol/databases/types";
import { describe, expect, it } from "vitest";
import { openZip, zipFiles } from "../lib/zip.js";
import type { ColumnInput, ImportClient } from "./client.js";
import { ARCHIVE_MAX_ENTRIES, ARCHIVE_MAX_ROWS, MANIFEST_NAME } from "./format.js";
import { IMPORT_PAGES_PER_WRITE, IMPORT_ROWS_PER_WRITE, ImportStepError, importArchive, readArchive } from "./import.js";
import { IMAGE, LIMITS, PNG, build, settings, sha256, text, type Json } from "./testing/fixture.js";

type Call = [string, ...unknown[]];

/**
 * An ImportClient that records every write, and each release, and hands out ids by kind: folder1, doc1, db1, table1, col1,
 * row1, view1, page1. `ops` lists the writes alone.
 */
function fakeClient(overrides: Partial<ImportClient> = {}): { client: ImportClient; calls: Call[]; ops: () => string[] } {
  const calls: Call[] = [];
  const counters = new Map<string, number>();
  const next = (kind: string): string => {
    const n = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, n);
    return `${kind}${n}`;
  };
  const tableOf = (display: string, columns: ColumnInput[]): TableSchema => ({
    table_id: next("table"),
    name: display.toLowerCase(),
    display,
    position: 0,
    row_count: 0,
    columns: columns.map((c, i) => ({ column_id: next("col"), name: `c${i}`, display: c.name, type: c.type, position: i, options: null })),
    views: [],
  });
  const client: ImportClient = {
    setWorkspaceInstructions: async (...args) => void calls.push(["setWorkspaceInstructions", ...args]),
    createFolder: async (...args) => (calls.push(["createFolder", ...args]), next("folder")),
    createDoc: async (...args) => (calls.push(["createDoc", ...args]), next("doc")),
    createDatabase: async (db) => (calls.push(["createDatabase", db]), { docId: next("db"), table: tableOf(db.table, db.columns) }),
    createTable: async (id, table) => (calls.push(["createTable", id, table]), tableOf(table.display, table.columns)),
    deleteTable: async (...args) => void calls.push(["deleteTable", ...args]),
    insertRows: async (id, table, rows) => (calls.push(["insertRows", id, table, rows]), rows.map(() => next("row"))),
    createView: async (...args) => (calls.push(["createView", ...args]), next("view")),
    openRowPages: async (id, table, pages) => (calls.push(["openRowPages", id, table, pages]), pages.map(() => next("page"))),
    uploadImage: async (docId, bytes, mime) => (calls.push(["uploadImage", docId, mime]), sha256(bytes)),
    seedBody: async (...args) => void calls.push(["seedBody", ...args]),
    setTitle: async (...args) => void calls.push(["setTitle", ...args]),
    importComments: async (...args) => void calls.push(["importComments", ...args]),
    setDocState: async (...args) => void calls.push(["setDocState", ...args]),
    release: async (...args) => void calls.push(["release", ...args]),
    ...overrides,
  };
  return { client, calls, ops: () => calls.map((c) => c[0]).filter((op) => op !== "release") };
}

const callsOf = (calls: Call[], op: string): unknown[][] => calls.filter((c) => c[0] === op).map((c) => c.slice(1));

describe("importing an archive", () => {
  it("writes containers before their contents, bodies once every id exists, and settings last", async () => {
    const { client, ops } = fakeClient();
    const out = await importArchive(client, await readArchive(build(), LIMITS));
    expect(ops()).toEqual([
      "setWorkspaceInstructions",
      "createFolder",
      "createDatabase",
      "insertRows",
      "createView",
      "createView",
      "createTable",
      "openRowPages",
      "createDoc",
      "createDoc",
      // GDPR first shows the image, so it is uploaded into GDPR; the start document is written last.
      "uploadImage",
      "seedBody",
      "seedBody",
      "seedBody",
      "setTitle",
      "importComments",
      "importComments",
      "setDocState",
      "setDocState",
    ]);
    expect(out.startDocId).toBe("doc1");
    expect(out.counts).toEqual({ folders: 1, docs: 2, databases: 1, pages: 1, rows: 2, images: 1, comments: 3 });
    expect(out.ids.docs).toEqual(new Map([["Start here.md", "doc1"], ["Laws/GDPR.md", "doc2"], ["Obligations/pages/gdpr-breach.md", "page1"]]));
  });

  it("releases each actor once a pass or its settings are done with it, and every one again once the import is", async () => {
    const { client, calls } = fakeClient();
    await importArchive(client, await readArchive(build(), LIMITS));
    const timeline = calls.map((c) => (c[0] === "release" ? `release ${String(c[1])}` : String(c[0])));
    const passes = timeline.slice(0, timeline.indexOf("setTitle"));
    expect(passes).toEqual([
      "setWorkspaceInstructions",
      "createFolder",
      "createDatabase",
      "insertRows",
      "createView",
      "createView",
      "createTable",
      // The database after its tables, rows and views, and again after its pages.
      "release db1",
      "openRowPages",
      "release db1",
      "createDoc",
      "createDoc",
      // Each document once its body is written.
      "uploadImage",
      "seedBody",
      "release doc2",
      "seedBody",
      "release page1",
      "seedBody",
      "release doc1",
    ]);
    expect(timeline.slice(timeline.lastIndexOf("importComments") + 1)).toEqual([
      // Each item once its settings are written.
      "setDocState",
      "release doc2",
      "setDocState",
      "release db1",
      "release page1",
      "release doc1",
      "release doc2",
      "release db1",
    ]);
    expect(callsOf(calls, "release").map((c) => c[1])).toEqual(["database", "database", "prose", "prose", "prose", "prose", "database", "prose", "prose", "prose", "database"]);
  });

  it("creates each item where the archive puts it, with its tables, rows by column id and views by column id", async () => {
    const { client, calls } = fakeClient();
    await importArchive(client, await readArchive(build(), LIMITS));
    expect(callsOf(calls, "setWorkspaceInstructions")).toEqual([["Answer with citations."]]);
    expect(callsOf(calls, "createFolder")).toEqual([[{ title: "Laws", parentId: null, agentInstructions: "Quote the official text." }]]);
    expect(callsOf(calls, "createDoc")).toEqual([[{ title: "Start here", parentId: null }], [{ title: "Regulation (EU) 2016/679", parentId: "folder1" }]]);
    expect(callsOf(calls, "createDatabase")).toEqual([
      [
        {
          title: "Obligations",
          parentId: null,
          table: "Main",
          columns: [
            { name: "Law", type: "text" },
            { name: "Topic", type: "single_select", choices: ["Breach", "Consent"] },
            { name: "Hours", type: "number", description: "Hours to notify." },
            { name: "Checked", type: "checkbox" },
            { name: "Due", type: "date" },
          ],
        },
      ],
    ]);
    expect(callsOf(calls, "createTable")).toEqual([["db1", { display: "Sources", columns: [{ name: "URL", type: "text" }] }]]);
    expect(callsOf(calls, "insertRows")).toEqual([
      [
        "db1",
        { table_id: "table1", display: "Main" },
        [
          { col1: "GDPR", col2: "Breach", col3: 72, col4: 1, col5: "2026-10-01" },
          { col1: "PIPL", col2: "Consent", col4: 0 },
        ],
      ],
    ]);
    expect(callsOf(calls, "createView")).toEqual([
      [
        "db1",
        "table1",
        {
          name: "Breach",
          kind: "table",
          position: 0,
          filter: { and: [{ column_id: "col2", op: "eq", value: "Breach" }, { column_id: "col4", op: "eq", value: 1 }] },
          sorts: [{ column_id: "col3", dir: "desc" }],
          group_by: "col1",
          hidden_columns: ["col4"],
          config: { width: 2 },
        },
      ],
      [
        "db1",
        "table1",
        {
          name: "One row",
          kind: "table",
          position: 1,
          filter: { column_id: "_id", op: "eq", value: "row1" },
          sorts: [{ column_id: "_created_at", dir: "asc" }],
          group_by: null,
          hidden_columns: [],
          config: {},
        },
      ],
    ]);
    expect(callsOf(calls, "openRowPages")).toEqual([["db1", "table1", [{ rowId: "row1", title: "GDPR breach" }]]]);
  });

  it("points links and images at the node, in the web app's own link forms, and writes a mention as plain text", async () => {
    const { client, calls } = fakeClient();
    await importArchive(client, await readArchive(build(), LIMITS));
    const bodies = new Map(callsOf(calls, "seedBody") as Array<[string, string]>);
    const hash = sha256(PNG);
    expect(bodies.get("doc1")).toBe(
      [
        "# Start here",
        "",
        "Read [the laws](/?folder=folder1) and [GDPR](/doc/doc2), then [the obligations](/doc/db1), [breaches](/doc/db1?table=table1&view=view1), " +
          "[one row](/doc/db1?table=table1&row=row1) and [its page](/doc/page1?row=db1.table1.row1). Ask @Liv or see [the site](https://example.com/a).",
        "",
        `![Chart](/api/docs/doc1/media/${hash})`,
      ].join("\n"),
    );
    expect(bodies.get("doc2")).toBe(`# GDPR\n\nBack to [the start](/doc/doc1).\n\n![Chart](/api/docs/doc2/media/${hash})`);
    // Nothing to rewrite: the body goes as the file holds it.
    expect(bodies.get("page1")).toBe("# GDPR breach\n\nNotify within 72 hours.");
    expect(callsOf(calls, "uploadImage")).toEqual([["doc2", "image/png"]]);
  });

  it("links a folder by its whole path of ids, as the library's URL holds it", async () => {
    const { client, calls } = fakeClient();
    const archive = build((m, f) => {
      m.items.splice(2, 0, { kind: "folder", path: "Laws/EU", parent: "Laws", title: "EU", agent_instructions: "" });
      f["Start here.md"] = "# Start here\n\nSee [EU law](Laws/EU).\n";
    });
    await importArchive(client, await readArchive(archive, LIMITS));
    expect(callsOf(calls, "createFolder")[1]).toEqual([{ title: "EU", parentId: "folder1", agentInstructions: "" }]);
    expect(new Map(callsOf(calls, "seedBody") as Array<[string, string]>).get("doc1")).toBe("# Start here\n\nSee [EU law](/?folder=folder1/folder2).");
  });

  it("keeps a user title, carries comments with their authors, threads and times, and settles each document last", async () => {
    const { client, calls } = fakeClient();
    await importArchive(client, await readArchive(build(), LIMITS));
    expect(callsOf(calls, "setTitle")).toEqual([["doc2", "Regulation (EU) 2016/679"]]);
    expect(callsOf(calls, "importComments")).toEqual([
      [
        "doc2",
        [
          { num: 3, parentNum: null, authorName: "Liv", body: "Link the start?", anchorQuote: "the start", resolved: true, createdAt: "2026-03-01T09:30:00Z" },
          { num: 5, parentNum: 3, authorName: "Liv", body: "Done.", anchorQuote: null, resolved: false, createdAt: "2026-03-02T09:30:00Z" },
        ],
      ],
      ["db1", [{ num: 1, parentNum: null, authorName: "Liv", body: "Check the hours.", anchorQuote: null, resolved: false, createdAt: "2026-03-03T09:30:00Z" }]],
    ]);
    expect(callsOf(calls, "setDocState")).toEqual([
      ["doc2", { agent_instructions: "Quote articles.", search_hidden: true, agent_mode: "auto", locked: true }],
      ["db1", { agent_instructions: "One row per law and topic.", locked: true }],
    ]);
  });

  it("replays sample steps only for a trusted archive, after the comments and before any setting", async () => {
    const withSteps = build((m) => {
      m.sample = { steps: [{ kind: "comment", doc: "Start here.md", body: "Welcome, {{me}}." }] };
    });
    const replayed: unknown[] = [];
    const { client, calls, ops } = fakeClient();
    const sampleSteps = async (steps: unknown[], ids: { docs: Map<string, string> }) => {
      replayed.push(steps, ids.docs.get("Start here.md"));
      calls.push(["sampleSteps"]);
    };
    await importArchive(client, await readArchive(withSteps, LIMITS), { sampleSteps });
    expect(replayed).toEqual([]);

    calls.length = 0;
    await importArchive(client, await readArchive(withSteps, LIMITS), { trusted: true, sampleSteps });
    expect(replayed).toEqual([[{ kind: "comment", doc: "Start here.md", body: "Welcome, {{me}}." }], "doc3"]);
    expect(ops().slice(-4)).toEqual(["importComments", "sampleSteps", "setDocState", "setDocState"]);
  });

  it("inserts rows in writes of IMPORT_ROWS_PER_WRITE and makes pages in batches of IMPORT_PAGES_PER_WRITE, in order", async () => {
    const rowCount = 2 * IMPORT_ROWS_PER_WRITE + 1;
    const pageCount = IMPORT_PAGES_PER_WRITE + 1;
    const archive = build((m, f) => {
      const main = m.items[3].tables[0];
      main.views = [];
      main.pages = Array.from({ length: pageCount }, (_, i) => ({ row: `k${i}`, file: `Obligations/pages/k${i}.md`, ...settings(`Row ${i}`) }));
      f["Obligations/Main.jsonl"] = Array.from({ length: rowCount }, (_, i) => `{"_id":"k${i}","Hours":${i}}\n`).join("");
      delete f["Obligations/pages/gdpr-breach.md"];
      for (let i = 0; i < pageCount; i++) f[`Obligations/pages/k${i}.md`] = "";
      f["Start here.md"] = "# Start here\n\nSee [the last row](Obligations#row=k10000).\n";
    });
    const { client, calls } = fakeClient();
    const out = await importArchive(client, await readArchive(archive, LIMITS));
    const inserts = callsOf(calls, "insertRows") as Array<[string, unknown, Array<Record<string, number>>]>;
    expect(inserts.map((c) => c[2].length)).toEqual([IMPORT_ROWS_PER_WRITE, IMPORT_ROWS_PER_WRITE, 1]);
    expect(inserts[2]![2]).toEqual([{ col3: rowCount - 1 }]);
    const batches = callsOf(calls, "openRowPages") as Array<[string, string, Array<{ rowId: string; title: string }>]>;
    expect(batches.map((c) => c[2].length)).toEqual([IMPORT_PAGES_PER_WRITE, 1]);
    expect(batches[1]![2]).toEqual([{ rowId: `row${pageCount}`, title: `Row ${pageCount - 1}` }]);
    expect(out.ids.docs.get(`Obligations/pages/k${pageCount - 1}.md`)).toBe(`page${pageCount}`);
    // Empty bodies are not written.
    expect((callsOf(calls, "seedBody") as Array<[string, string]>).map((c) => c[0])).toEqual(["doc2", "doc1"]);
    expect(new Map(callsOf(calls, "seedBody") as Array<[string, string]>).get("doc1")).toBe("# Start here\n\nSee [the last row](/doc/db1?table=table1&row=row10001).");
  });

  it("gives a database the archive holds no table of none, dropping the one it starts with", async () => {
    const archive = build((m, f) => {
      m.items[3].tables = [];
      for (const name of Object.keys(f)) if (name.startsWith("Obligations/")) delete f[name];
      f["Start here.md"] = "# Start here\n\nSee [the obligations](Obligations).\n";
    });
    const { client, calls } = fakeClient();
    await importArchive(client, await readArchive(archive, LIMITS));
    expect(callsOf(calls, "createDatabase")).toEqual([[{ title: "Obligations", parentId: null, table: "Obligations", columns: [] }]]);
    expect(callsOf(calls, "deleteTable")).toEqual([["db1", "table1"]]);
  });

  it("writes a body as the file holds it, less a byte order mark, \\r\\n line ends and control characters", async () => {
    const archive = build((_m, f) => {
      f["Obligations/pages/gdpr-breach.md"] = "﻿# GDPR breach\r\n\r\nNotify\u0007 within 72 hours.\r\n";
    });
    const { client, calls } = fakeClient();
    await importArchive(client, await readArchive(archive, LIMITS));
    expect(new Map(callsOf(calls, "seedBody") as Array<[string, string]>).get("page1")).toBe("# GDPR breach\n\nNotify within 72 hours.");
  });

  it("names the step that failed, and writes nothing after it", async () => {
    const { client, calls, ops } = fakeClient();
    const seed = client.seedBody;
    // Recorded like every other write, so one made after the failure would show.
    client.seedBody = async (docId, markdown) => {
      await seed(docId, markdown);
      if (docId === "page1") throw new Error("the actor is gone");
    };
    const err = await importArchive(client, await readArchive(build(), LIMITS)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportStepError);
    expect((err as ImportStepError).step).toBe("Obligations/pages/gdpr-breach.md");
    expect((err as Error).message).toBe("Obligations/pages/gdpr-breach.md: the actor is gone");
    expect(ops().at(-1)).toBe("seedBody");
    const seeded = callsOf(calls, "seedBody").map(([docId]) => docId);
    expect(seeded.at(-1)).toBe("page1");
    // The start document is written last, so it never is.
    expect(seeded).not.toContain("doc1");
  });
});

describe("reading an archive", () => {
  const refusal = async (bytes: Uint8Array, limits = LIMITS): Promise<string> => {
    const err = await readArchive(bytes, limits).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, "the archive was accepted").toBeInstanceOf(Error);
    return (err as Error).message;
  };

  it("reads only the files the manifest names and the images the bodies show", async () => {
    const other = new Uint8Array([...PNG, 1]);
    const contents = await readArchive(
      build((_m, f) => {
        f["README.md"] = "notes";
        f[`media/${sha256(other)}.png`] = new Uint8Array([1, 2, 3]);
      }),
      LIMITS,
    );
    expect([...contents.media]).toEqual([[IMAGE, "image/png"]]);
    expect([...contents.rewrites]).toEqual([
      ["Start here.md", true],
      ["Laws/GDPR.md", true],
      ["Obligations/pages/gdpr-breach.md", false],
    ]);
    // Read again from the zip when they are written.
    expect((await contents.rows("Obligations/Main.jsonl")).map((r) => r.key)).toEqual(["gdpr-breach", "pipl-consent"]);
    expect(await contents.body("Obligations/pages/gdpr-breach.md")).toBe("# GDPR breach\n\nNotify within 72 hours.");
    expect(await contents.image(IMAGE)).toEqual(PNG);
  });

  it("reads an archive a Mac compressed from the folder it was unzipped into", async () => {
    const entries = [...openZip(build()).files.keys()];
    const inner = openZip(build());
    const wrapped = await Promise.all(entries.map(async (name) => ({ name: `Privacy laws.stuga/${name}`, data: await inner.read(name) })));
    const mac = [
      ...wrapped,
      { name: "Privacy laws.stuga/.DS_Store", data: text("") },
      { name: "__MACOSX/Privacy laws.stuga/._stuga.json", data: text("forks") },
    ];
    const contents = await readArchive(zipFiles(mac, "deflate"), LIMITS);
    expect(contents.manifest.workspace.name).toBe("Privacy laws");
    expect(await contents.body("Laws/GDPR.md")).toContain("Back to [the start]");
    expect((await contents.rows("Obligations/Main.jsonl")).length).toBe(2);
    // Anything else beside the folder, or a second folder, and it is no archive.
    for (const extra of [{ name: "notes.md", data: text("") }, { name: "Other/stuga.json", data: text("{}") }]) {
      expect(await refusal(zipFiles([...wrapped, extra], "deflate"))).toBe("stuga.json: is missing, so this is not a Stuga workspace archive");
    }
  });

  it("counts the files an archive holds against its cap, not a zip's folder entries or a Mac's forks", async () => {
    const inner = openZip(build());
    const files = await Promise.all([...inner.files.keys()].map(async (name) => ({ name, data: await inner.read(name) })));
    // A fork beside each of as many files as an archive holds.
    const forks = Array.from({ length: ARCHIVE_MAX_ENTRIES }, (_, i) => ({ name: `__MACOSX/Privacy laws.stuga/Laws/._${i}.md`, data: text("fork") }));
    const mac = zipFiles([...files.map((f) => ({ ...f, name: `Privacy laws.stuga/${f.name}` })), ...forks], "stored");
    expect(openZip(mac, { maxEntries: Infinity }).files.size).toBeGreaterThan(ARCHIVE_MAX_ENTRIES);
    expect((await readArchive(mac, LIMITS)).manifest.workspace.name).toBe("Privacy laws");

    const extras = Array.from({ length: ARCHIVE_MAX_ENTRIES - files.length + 1 }, (_, i) => ({ name: `Extra/${i}.md`, data: text("") }));
    expect(await refusal(zipFiles([...files, ...extras], "stored"))).toBe(`the archive holds ${ARCHIVE_MAX_ENTRIES + 1} files, more than ${ARCHIVE_MAX_ENTRIES}`);
  });

  it("refuses an archive holding more rows than an archive can, counting every table", async () => {
    const tables = (count: number) =>
      build((m, f) => {
        const obligations = m.items[3];
        for (let t = 0; t < count; t++) {
          const file = `Obligations/Bulk ${t}.jsonl`;
          obligations.tables.push({ name: `Bulk ${t}`, file, columns: [], views: [], pages: [] });
          f[file] = Array.from({ length: 50_000 }, (_, i) => `{"_id":"r${i}"}\n`).join("");
        }
      });
    // Ten full tables and the two rows already there.
    expect(await refusal(tables(10))).toBe(`Obligations/Bulk 9.jsonl: takes the archive past ${ARCHIVE_MAX_ROWS} rows`);
    expect((await readArchive(tables(9), LIMITS)).index.tables.size).toBe(11);
  });

  it.each<[string, (m: Json, f: Record<string, string | Uint8Array>) => void, RegExp]>([
    ["a newer version", (m) => void (m.version = 2), /^stuga\.json: version: the archive is version 2, from a newer Stuga/],
    ["a bad setting", (m) => void (m.items[0].agent_mode = "sometimes"), /^stuga\.json: items\[0\]\.agent_mode: must be one of review, auto$/],
    ["a manifest that is not JSON", (_m, f) => void (f[MANIFEST_NAME] = "{"), /^stuga\.json: is not JSON$/],
    ["a missing body", (_m, f) => void delete f["Laws/GDPR.md"], /^Laws\/GDPR\.md: is missing; stuga\.json names it$/],
    ["a body that is not UTF-8", (_m, f) => void (f["Laws/GDPR.md"] = new Uint8Array([0x23, 0x20, 0xff])), /^Laws\/GDPR\.md: is not UTF-8 text$/],
    ["a row that does not read", (_m, f) => void (f["Obligations/Main.jsonl"] += `{"_id":"x","Hours":"many"}\n`), /^Obligations\/Main\.jsonl:3: Hours: /],
    ["a page of a row the table lacks", (m) => void (m.items[3].tables[0].pages[0].row = "nope"), /^Obligations\/pages\/gdpr-breach\.md: is the page of row "nope"/],
    ["a view on a row the table lacks", (m) => void (m.items[3].tables[0].views[1].filter.value = "nope"), /view "One row" filters on row "nope"/],
    ["a link to nothing", (_m, f) => void (f["Laws/GDPR.md"] = "# GDPR\n\n[x](Nowhere.md)\n"), /^Laws\/GDPR\.md: link "Nowhere\.md" leads to "Laws\/Nowhere\.md", which is not in the archive$/],
    ["a link to a missing view", (_m, f) => void (f["Laws/GDPR.md"] = "# GDPR\n\n[x](../Obligations#view=Late)\n"), /table "Main" has no view "Late"/],
    ["a link to a missing row", (_m, f) => void (f["Laws/GDPR.md"] = "# GDPR\n\n[x](../Obligations#row=late)\n"), /table "Main" has no row "late"/],
    ["a link out of the archive", (_m, f) => void (f["Laws/GDPR.md"] = "# GDPR\n\n[x](../../x.md)\n"), /climbs out of the archive/],
    ["a missing image", (_m, f) => void delete f[IMAGE], new RegExp(`shows ${IMAGE}, which is missing`)],
    ["an image named for other bytes", (_m, f) => void (f[IMAGE] = new Uint8Array([...PNG, 7])), /is named for other bytes than it holds$/],
    ["an image of another type", (_m, f) => void (f[IMAGE] = text("GIF89a.")), /: is image\/gif, not the type its name says$/],
    ["a file that is no image", (_m, f) => void (f[IMAGE] = text("<svg/>")), /unsupported image type/],
  ])("refuses %s, naming where", async (_case, edit, message) => {
    expect(await refusal(build(edit))).toMatch(message);
  });

  it("refuses an image past the node's upload limit, and anything that is not a zip of an archive", async () => {
    expect(await refusal(build(), { maxImageBytes: 8 })).toBe(`${IMAGE}: is 16 bytes; this node takes images up to 8`);
    expect(await refusal(text("hello"))).toMatch(/not a zip archive/);
    expect(await refusal(zipFiles([{ name: "notes.md", data: text("# Notes\n") }], "deflate"))).toBe(
      "stuga.json: is missing, so this is not a Stuga workspace archive",
    );
  });
});
