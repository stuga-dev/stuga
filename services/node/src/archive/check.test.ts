import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpsError } from "../ops/outcome.js";
import { checkArchive, directoryFiles, lineDiff, runArchiveCommand, type ArchiveFiles } from "./check.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0]);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const IMAGE = `media/${sha256(PNG)}.png`;

const settings = (title: string) => ({
  title,
  title_source: "heading",
  agent_mode: "review",
  locked: false,
  search_hidden: false,
  agent_instructions: "",
});

function manifest(): Json {
  return {
    format: "stuga-workspace",
    version: 1,
    generator: "stuga 0.2.0",
    exported_at: "2026-09-25T10:00:00Z",
    workspace: { name: "Privacy laws", agent_instructions: "" },
    start: "Start here.md",
    items: [
      { kind: "doc", path: "Start here.md", parent: null, ...settings("Start here") },
      { kind: "folder", path: "Laws", parent: null, title: "Laws", agent_instructions: "" },
      { kind: "doc", path: "Laws/个人信息保护法.md", parent: "Laws", ...settings("中华人民共和国个人信息保护法") },
      {
        kind: "database",
        path: "Obligations",
        parent: null,
        ...settings("Obligations"),
        tables: [
          {
            name: "Obligations",
            file: "Obligations/Obligations.jsonl",
            columns: [
              { name: "Law", type: "text" },
              { name: "Topic", type: "single_select", choices: ["Consent", "Breach notification"] },
              { name: "Deadline (hours)", type: "number" },
              { name: "Checked", type: "checkbox" },
            ],
            views: [
              {
                name: "Breach",
                kind: "table",
                position: 0,
                filter: { column: "Topic", op: "eq", value: "Breach notification" },
                sorts: [],
                group_by: null,
                hidden_columns: [],
                config: {},
              },
            ],
            pages: [{ row: "gdpr-breach", file: "Obligations/pages/gdpr-breach.md", ...settings("GDPR: breach notification") }],
          },
          { name: "Sources", file: "Obligations/Sources.jsonl", columns: [], views: [], pages: [] },
        ],
      },
    ],
    sample: {
      steps: [
        {
          kind: "edit",
          doc: "Start here.md",
          edits: [{ old_string: "Welcome to the sample.", new_string: "Welcome to the sample.[^1]" }],
          citations: [{ n: 1, doc: "Laws/个人信息保护法.md", content: "为了保护个人信息权益" }],
        },
        { kind: "row", database: "Obligations", table: "Obligations", row: "gdpr-breach", values: { Checked: true } },
        { kind: "comment", doc: "Obligations/pages/gdpr-breach.md", body: "{{me}}, is 72 right?", quote: "72 hours" },
      ],
    },
  };
}

/** An archive that passes, as file contents by path. */
function archive(): Record<string, string | Uint8Array> {
  return {
    "stuga.json": JSON.stringify(manifest(), null, 2),
    "Start here.md":
      "# Start here\n\nWelcome to the sample. Read [the law](Laws/个人信息保护法.md) and the [breach rows](Obligations#view=Breach&row=gdpr-breach).\n\n" +
      `![Chart](${IMAGE})\n`,
    "Laws/个人信息保护法.md": "# 中华人民共和国个人信息保护法\n\n第一条\u3000为了保护个人信息权益。\n\nSee [Start here](../Start%20here.md).\n",
    "Obligations/Obligations.jsonl":
      '{"_id":"gdpr-breach","Law":"GDPR","Topic":"Breach notification","Deadline (hours)":72,"Checked":false}\n{"_id":"pipl-consent","Law":"PIPL","Topic":"Consent"}\n',
    "Obligations/Sources.jsonl": "",
    "Obligations/pages/gdpr-breach.md": "# GDPR: breach notification\n\nNotify within 72 hours.\n",
    [IMAGE]: PNG,
    "README.md": "Kept beside the archive.\n",
  };
}

function memoryFiles(contents: Record<string, string | Uint8Array>): ArchiveFiles {
  const bytes = new Map(Object.entries(contents).map(([path, c]) => [path, typeof c === "string" ? new TextEncoder().encode(c) : c]));
  return {
    sizes: new Map([...bytes].map(([path, b]) => [path, b.length])),
    others: new Map(),
    read: async (path) => bytes.get(path)!,
  };
}

/** Check the passing archive with one change; its problems as `at: message` lines. */
async function problems(edit: (files: Record<string, string | Uint8Array>, m: Json) => void): Promise<string[]> {
  const files = archive();
  const m = manifest();
  edit(files, m);
  files["stuga.json"] ??= JSON.stringify(m);
  if (files["stuga.json"] === "") delete files["stuga.json"];
  const result = await checkArchive(memoryFiles(files));
  return result.issues.map((i) => `${i.at}: ${i.message}`);
}

/** The same edit, with the manifest rewritten from `m`. */
const withManifest = (edit: (files: Record<string, string | Uint8Array>, m: Json) => void) =>
  problems((files, m) => {
    edit(files, m);
    files["stuga.json"] = JSON.stringify(m);
  });

describe("checkArchive", () => {
  it("passes an archive that holds what it says, and counts it", async () => {
    const result = await checkArchive(memoryFiles(archive()));
    expect(result.issues).toEqual([]);
    expect(result.counts).toEqual({ items: 4, bodies: 3, rows: 2, images: 1, steps: 3 });
  });

  it("stops at a manifest that is missing, not JSON, or refused", async () => {
    expect(await problems((files) => (files["stuga.json"] = ""))).toEqual([
      "stuga.json: is missing, so this is not an archive's top folder; check the folder the archive unzips to",
    ]);
    expect(await problems((files) => (files["stuga.json"] = "{"))).toEqual([expect.stringMatching(/^stuga\.json: is not JSON/)]);
    expect(await withManifest((_f, m) => (m.items[0].locked = "no"))).toEqual(["stuga.json: items[0].locked: must be true or false"]);
    expect(await withManifest((_f, m) => (m.version = 2))).toEqual([expect.stringMatching(/^stuga\.json: version: the archive is version 2/)]);
  });

  it("finds a named file that is missing, and one stored under a decomposed name", async () => {
    expect(await problems((files) => delete files["Obligations/pages/gdpr-breach.md"])).toContain(
      "Obligations/pages/gdpr-breach.md: is missing; stuga.json names it",
    );
    const nfd = await withManifest((files, m) => {
      files["Café.md"] = files["Start here.md"]!;
      delete files["Start here.md"];
      files["Cafe\u0301.md"] = files["Café.md"];
      delete files["Café.md"];
      m.items[0].path = "Café.md";
      m.start = "Café.md";
      m.sample.steps[0].doc = "Café.md";
    });
    expect(nfd).toContain("Café.md: is stored under a decomposed Unicode name; rename it to its NFC form");
  });

  it("refuses files the manifest does not name, but not images or a README", async () => {
    expect(await problems((files) => (files["notes.txt"] = "x"))).toEqual(["notes.txt: is not part of the archive: stuga.json names no such file"]);
    expect(await problems((files) => (files["Laws/README.md"] = "x"))).toEqual([
      "Laws/README.md: is not part of the archive: stuga.json names no such file",
    ]);
  });

  it("shows how Stuga would write a body that is not canonical", async () => {
    const result = await checkArchive(
      memoryFiles({ ...archive(), "Obligations/pages/gdpr-breach.md": "# GDPR: breach notification\n\n- Notify within 72 hours.\n- Keep a record.  \n" }),
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ at: "Obligations/pages/gdpr-breach.md", message: expect.stringContaining("as Stuga writes it") });
    expect(result.issues[0]!.diff).toBe(
      ["@@ line 3 @@", " # GDPR: breach notification", " ", "-- Notify within 72 hours.", "-- Keep a record.··", "+* Notify within 72 hours.", "+", "+* Keep a record."].join("\n"),
    );
  });

  it("reads a file past a byte order mark, and names the mark", async () => {
    expect(await problems((files) => (files["stuga.json"] = `\ufeff${JSON.stringify(manifest())}`))).toEqual([
      "stuga.json: starts with a byte order mark; save it as UTF-8 without one",
    ]);
    expect(await problems((files) => (files["Obligations/Sources.jsonl"] = '\ufeff{"_id":"s1"}\n'))).toEqual([
      "Obligations/Sources.jsonl: starts with a byte order mark; save it as UTF-8 without one",
    ]);
  });

  it("wants a body to end with one newline", async () => {
    expect(await problems((files) => (files["Laws/个人信息保护法.md"] = (files["Laws/个人信息保护法.md"] as string).trimEnd()))).toEqual([
      "Laws/个人信息保护法.md: must end with a newline",
    ]);
  });

  it("holds a heading title to the manifest, and leaves a title someone gave alone", async () => {
    expect(await withManifest((_f, m) => (m.items[0].title = "Welcome"))).toEqual([
      'Start here.md: its first line gives the title "Start here", but stuga.json says "Welcome"',
    ]);
    expect(await withManifest((_f, m) => ((m.items[0].title = "Welcome"), (m.items[0].title_source = "user")))).toEqual([]);
  });

  it("holds a heading title to the first line as a title is written: a tab kept, a split pair U+FFFD", async () => {
    const tab = await withManifest((files, m) => {
      files["Start here.md"] = (files["Start here.md"] as string).replace("# Start here", "# Start\there");
      m.items[0].title = "Start\there";
    });
    expect(tab).toEqual([]);
    const long = `${"x".repeat(199)}😀`;
    const split = await withManifest((files, m) => {
      files["Start here.md"] = (files["Start here.md"] as string).replace("# Start here", `# ${long}`);
      m.items[0].title = `${"x".repeat(199)}\ufffd`;
    });
    expect(split).toEqual([]);
  });

  it("reads a title from the text, not the Markdown", async () => {
    const out = await withManifest((files, m) => {
      files["Start here.md"] = (files["Start here.md"] as string).replace("# Start here", "# Start **here** \\[v1\\]");
      m.items[0].title = "Start here [v1]";
    });
    expect(out).toEqual([]);
  });

  it.each<[string, string, string]>([
    ["a mention", "[@Liv](mention:u_liv)", "holds a mention; an archive writes a person as plain @name text"],
    ["a link into the source node", "[x](/doc/abc)", 'links to "/doc/abc" on the node it came from'],
    ["a link to nothing", "[x](Laws/missing.md)", 'link "Laws/missing.md" leads to "Laws/missing.md", which is not in the archive'],
    ["a link that climbs out", "[x](../x.md)", 'link "../x.md" climbs out of the archive'],
    ["a view on a document", "[x](Laws/个人信息保护法.md#view=Breach)", "only a database link takes table, view or row"],
    ["a view that is not there", "[x](Obligations#view=Open)", 'table "Obligations" has no view "Open"'],
    ["a row that is not there", "[x](Obligations#row=nope)", 'table "Obligations" has no row "nope"'],
    ["a table that is not there", "[x](Obligations#table=Other&row=r1)", 'database "Obligations" has no table "Other"'],
    ["an image in a data: URI", "![x](data:image/png;base64,iVBORw0KGgo=)", "holds an image as a data: URI"],
    ["an image from the source node", "![x](/api/docs/d1/media/abc)", 'shows "/api/docs/d1/media/abc" from the node it came from'],
    ["an image that is no media file", "![x](Laws/个人信息保护法.md)", "which is no media/<sha256>.<ext> file"],
    ["an image that is missing", `![x](media/${"b".repeat(64)}.png)`, `shows media/${"b".repeat(64)}.png, which is missing`],
  ])("refuses %s in a body", async (_name, markdown, message) => {
    const out = await problems((files) => (files["Start here.md"] = `# Start here\n\nWelcome to the sample.\n\n![Chart](${IMAGE})\n\n${markdown}\n`));
    expect(out.join("\n")).toContain(message);
  });

  it("leaves links and images on the web alone, and follows a link to a folder or a row's page", async () => {
    const out = await problems(
      (files) =>
        (files["Obligations/pages/gdpr-breach.md"] =
          "# GDPR: breach notification\n\nNotify within 72 hours. [EUR-Lex](https://eur-lex.europa.eu) [laws](../../Laws/) [table](..#table=Sources) [page](gdpr-breach.md)\n\n![logo](https://example.com/logo.png)\n"),
    );
    expect(out).toEqual([]);
  });

  it("holds an image to the upload limit every node takes", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    expect(await problems((files) => (files[IMAGE] = big))).toEqual([`${IMAGE}: is ${big.length} bytes (max 10485760, the upload limit a node starts with)`]);
  });

  it("holds each image to its name and to a body that shows it", async () => {
    const gif = `media/${sha256(GIF)}.gif`;
    expect(await problems((files) => (files[gif] = GIF))).toEqual([`${gif}: is not shown by any body`]);
    expect(await problems((files) => (files[`media/${sha256(GIF)}.png`] = GIF))).toContain(
      `media/${sha256(GIF)}.png: is named for other bytes; these are ${gif}`,
    );
    expect(await problems((files) => (files[IMAGE] = GIF))).toContain(`${IMAGE}: is named for other bytes; these are ${gif}`);
    expect(await problems((files) => (files["media/logo.png"] = PNG))).toContain("media/logo.png: is not named media/<sha256>.<png|jpg|gif|webp>");
    expect(await problems((files) => (files[IMAGE] = new Uint8Array([1, 2, 3])))).toContain(`${IMAGE}: is not a PNG, JPEG, GIF or WebP image`);
  });

  it("reads every row, and holds pages and filters to the rows there are", async () => {
    expect(await problems((files) => (files["Obligations/Sources.jsonl"] = "{}\n"))).toEqual([
      "Obligations/Sources.jsonl:1: _id: must be a row key: letters, digits, . _ and -",
    ]);
    expect(await problems((files) => (files["Obligations/Obligations.jsonl"] = '{"_id":"pipl-consent","Law":"PIPL"}\n'))).toEqual([
      'Obligations/pages/gdpr-breach.md: is the page of row "gdpr-breach", which Obligations/Obligations.jsonl does not hold',
      'Start here.md: link "Obligations#view=Breach&row=gdpr-breach": table "Obligations" has no row "gdpr-breach"',
      'stuga.json: sample.steps[1].row: "gdpr-breach" is not a row of Obligations/Obligations.jsonl',
    ]);
    expect(await withManifest((_f, m) => (m.items[3].tables[0].views[0].filter = { column: "_id", op: "eq", value: "gone" }))).toEqual([
      'Obligations/Obligations.jsonl: view "Breach" filters on row "gone", which the file does not hold',
    ]);
    // Ten full tables beside the two rows there are.
    const full = Array.from({ length: 50_000 }, (_, i) => `{"_id":"r${i}"}\n`).join("");
    const crowded = await withManifest((files, m) => {
      for (let t = 0; t < 10; t++) {
        m.items[3].tables.push({ name: `Bulk ${t}`, file: `Obligations/Bulk ${t}.jsonl`, columns: [], views: [], pages: [] });
        files[`Obligations/Bulk ${t}.jsonl`] = full;
      }
    });
    expect(crowded).toEqual(["archive: holds 500002 rows (max 500000)"]);
  });

  it("finds each sample edit's old_string once, in the body as the steps before it leave it", async () => {
    expect(await withManifest((_f, m) => (m.sample.steps[0].edits[0].old_string = "Welcome to Stuga."))).toContain(
      "stuga.json: sample.steps[0].edits[0].old_string: does not occur in Start here.md",
    );
    expect(await withManifest((_f, m) => (m.sample.steps[0].edits[0].old_string = "the "))).toContain(
      "stuga.json: sample.steps[0].edits[0].old_string: occurs 3 times in Start here.md; it must occur once",
    );
    const chained = await withManifest((_f, m) =>
      m.sample.steps.push({
        kind: "edit",
        doc: "Start here.md",
        edits: [{ old_string: "sample.[^1] Read", new_string: "sample.[^1] Now read" }],
        citations: [{ n: 1, doc: "Laws/个人信息保护法.md", content: "第一条" }],
      }),
    );
    expect(chained).toEqual([]);
    const stale = await withManifest((_f, m) =>
      m.sample.steps.push({ kind: "edit", doc: "Start here.md", edits: [{ old_string: "sample. Read", new_string: "x" }] }),
    );
    expect(stale).toEqual(["stuga.json: sample.steps[3].edits[0].old_string: does not occur in Start here.md as the earlier edits leave it"]);
  });

  it("replays an edit as the propose route does: renumbered, then as Stuga writes it", async () => {
    const step = (edits: Json[], citations?: Json[]) => ({ kind: "edit", doc: "Start here.md", edits, ...(citations ? { citations } : {}) });
    const cite = { n: 1, doc: "Laws/个人信息保护法.md", content: "第一条" };
    const page = { kind: "edit", doc: "Obligations/pages/gdpr-breach.md", edits: [{ old_string: "72 hours.", new_string: "72 hours. " }] };
    expect(await withManifest((_f, m) => (m.sample.steps = [page]))).toEqual([
      "stuga.json: sample.steps[0].edits: changes nothing once Stuga writes it, so an import would have nothing to propose",
    ]);
    const emphasis = await withManifest(
      (_f, m) =>
        (m.sample.steps = [
          step([{ old_string: "Welcome to the sample.", new_string: "Welcome to the __sample__." }]),
          step([{ old_string: "the __sample__", new_string: "the __demo__" }]),
        ]),
    );
    expect(emphasis).toEqual(["stuga.json: sample.steps[1].edits[0].old_string: does not occur in Start here.md as the earlier edits leave it"]);
    const renumbered = await withManifest((files, m) => {
      files["Start here.md"] = (files["Start here.md"] as string).replace("Welcome to the sample.", "Welcome.[^1] To the sample.") + "\n[^1]: Note.\n";
      m.sample.steps = [
        step([{ old_string: "To the sample.", new_string: "To the sample.[^1]" }], [cite]),
        step([{ old_string: "sample.[^1]", new_string: "sample, again.[^1]" }], [cite]),
      ];
    });
    expect(renumbered).toEqual(["stuga.json: sample.steps[1].edits[0].old_string: does not occur in Start here.md as the earlier edits leave it"]);
  });

  it("wants each marker in a new_string to be a citation of the step", async () => {
    const out = await withManifest((files, m) => {
      files["Start here.md"] = (files["Start here.md"] as string).replace("Welcome to the sample.", "Welcome to the sample.[^1]") + "\n[^1]: Note.\n";
      m.sample.steps = [{ kind: "edit", doc: "Start here.md", edits: [{ old_string: "sample.[^1]", new_string: "sample, revised.[^1]" }] }];
    });
    expect(out).toEqual([
      "stuga.json: sample.steps[0].edits[0].new_string: holds [^1], which no citation of this step has; Stuga renumbers it, and it would show no source",
    ]);
  });

  it("keeps an old_string out of the destinations an import rewrites", async () => {
    const out = await withManifest((files, m) => {
      files["Start here.md"] = (files["Start here.md"] as string).replace("Welcome to the sample.", "Welcome to the sample doc.");
      m.sample.steps = [
        { kind: "edit", doc: "Start here.md", edits: [{ old_string: "个人信息保护法.md) and", new_string: "个人信息保护法.md) or" }] },
        { kind: "edit", doc: "Start here.md", edits: [{ old_string: "doc", new_string: "workspace" }] },
      ];
    });
    expect(out).toEqual([
      "stuga.json: sample.steps[0].edits[0].old_string: could fall in a link or image destination, which an import rewrites to a node URL with random ids",
      "stuga.json: sample.steps[1].edits[0].old_string: could fall in a link or image destination, which an import rewrites to a node URL with random ids",
    ]);
  });

  it("keeps an old_string out of the destinations as an import writes them, whatever ids it mints", async () => {
    const edit = (old_string: string) =>
      withManifest((files, m) => {
        files["Start here.md"] = (files["Start here.md"] as string).replace("Welcome to the sample.", "Welcome to the sample. Each row is a law, from 72 sources.");
        m.sample.steps = [{ kind: "edit", doc: "Start here.md", edits: [{ old_string, new_string: "x" }] }];
      });
    const falls = "stuga.json: sample.steps[0].edits[0].old_string: could fall in a link or image destination, which an import rewrites to a node URL with random ids";
    // Imported, the link reads (/doc/<id>?table=tbl_<id>&view=view_<id>&row=row_<id>), and the image (/api/docs/<id>/media/<sha256>).
    for (const old of ["row", "table", "media", IMAGE.slice(6, 30), "72", "Each"]) expect(await edit(old), old).toEqual([falls]);
    for (const old of ["row is", "from 72 sources", "Each row"]) expect(await edit(old), old).toEqual([]);
  });

  it("holds an edit to the sizes the propose route takes", async () => {
    const grown = "x".repeat(4 * 1024 * 1024 - 10);
    const out = await withManifest((_f, m) => (m.sample.steps = [{ kind: "edit", doc: "Obligations/pages/gdpr-breach.md", edits: [{ old_string: "72 hours.", new_string: grown }] }]));
    const size = "# GDPR: breach notification\n\nNotify within ".length + grown.length;
    expect(out).toEqual([`stuga.json: sample.steps[0].edits: leave Obligations/pages/gdpr-breach.md ${size} bytes, more than a proposed body may be (4194304)`]);
    const body = `# GDPR: breach notification\n\n${"x".repeat(4 * 1024 * 1024 - 29)}`;
    expect(await problems((files) => (files["Obligations/pages/gdpr-breach.md"] = `${body}\n`))).toEqual([
      'stuga.json: sample.steps[2].quote: does not occur in Obligations/pages/gdpr-breach.md',
    ]);
  });

  it("keeps sample edits off archive links, which an import rewrites", async () => {
    const out = await withManifest((_f, m) => (m.sample.steps[0].edits[0] = { old_string: "Read [the law](Laws/个人信息保护法.md)", new_string: "Read it" }));
    expect(out[0]).toBe(
      'stuga.json: sample.steps[0].edits[0].old_string: holds the archive link "Laws/个人信息保护法.md"; an import rewrites links, so an edit leaves them alone',
    );
  });

  it("holds each citation to a marker in the edit and to text in the cited body", async () => {
    expect(await withManifest((_f, m) => (m.sample.steps[0].edits[0].new_string = "Welcome."))).toEqual([
      "stuga.json: sample.steps[0].citations[0].n: no new_string of this step holds [^1]",
    ]);
    expect(await withManifest((_f, m) => (m.sample.steps[0].citations[0].content = "第二条"))).toEqual([
      "stuga.json: sample.steps[0].citations[0].content: does not occur in Laws/个人信息保护法.md",
    ]);
    expect(await withManifest((_f, m) => (m.sample.steps[0].citations[0].content = "Start here"))).toEqual([]);
  });

  it("wants a sample comment's quote to occur once, so the web can place it", async () => {
    expect(await withManifest((_f, m) => (m.sample.steps[2].quote = "96 hours"))).toEqual([
      "stuga.json: sample.steps[2].quote: does not occur in Obligations/pages/gdpr-breach.md",
    ]);
    expect(await withManifest((_f, m) => (m.sample.steps[2].quote = "i"))).toEqual([
      "stuga.json: sample.steps[2].quote: occurs 6 times in Obligations/pages/gdpr-breach.md; it must occur once to be placed",
    ]);
    expect(await withManifest((_f, m) => (m.sample.steps[2].quote = "breach notification Notify"))).toEqual([]);
  });
});

describe("lineDiff", () => {
  it("shows the lines that differ with two lines of context", () => {
    expect(lineDiff("a\nb\nc\nd\ne\nf", "a\nb\nc\nD\ne\nf")).toBe(["@@ line 4 @@", " b", " c", "-d", "+D", " e", " f"].join("\n"));
    expect(lineDiff("\ufeff# A\r", "# A")).toBe(["@@ line 1 @@", "-\\ufeff# A\\u000d", "+# A"].join("\n"));
  });

  it("stops after the lines it may show", () => {
    const out = lineDiff(Array(50).fill("x").join("\n"), Array(50).fill("y").join("\n"), 10);
    expect(out.split("\n")).toHaveLength(11);
    expect(out).toMatch(/… 91 more lines$/);
  });
});

describe("the archive check command", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  async function unzipped(contents: Record<string, string | Uint8Array>): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "stuga-archive-"));
    for (const [path, content] of Object.entries(contents)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    return dir;
  }

  async function run(argv: string[]): Promise<{ code: number; out: string }> {
    let out = "";
    const code = await runArchiveCommand(argv, (text) => void (out += text));
    return { code, out };
  }

  it("lists a folder's files, skipping dot files and naming a link", async () => {
    const root = await unzipped({ ...archive(), ".DS_Store": "x", ".git/config": "x" });
    await symlink(join(root, "README.md"), join(root, "Laws", "link.md"));
    const files = await directoryFiles(root);
    expect([...files.sizes.keys()].sort()).toEqual(Object.keys(archive()).sort());
    expect([...files.others]).toEqual([["Laws/link.md", "is a symbolic link; an archive holds only files"]]);
    expect(files.sizes.get(IMAGE)).toBe(PNG.length);
  });

  it("exits 0 for an archive that passes", async () => {
    const root = await unzipped(archive());
    const { code, out } = await run(["check", root]);
    expect(code).toBe(0);
    expect(out).toBe(`${root} passes: 4 items, 3 bodies, 2 rows, 1 image, 3 sample steps\n`);
  });

  it("prints a name's control and direction characters escaped", async () => {
    const root = await unzipped({ ...archive(), "\u001b[31mRED\u202e": "x" });
    const text = await run(["check", root]);
    expect(text.out.split("\n")[0]).toBe("\\u001b[31mRED\\u202e: is not part of the archive: stuga.json names no such file");
    const json = await run(["check", root, "--json"]);
    expect(json.out).not.toContain("\u001b");
    expect(json.out).not.toContain("\u202e");
    expect(JSON.parse(json.out).issues[0].at).toBe("\u001b[31mRED\u202e");
  });

  it("exits 2 and prints each problem, and one JSON object with --json", async () => {
    const root = await unzipped({ ...archive(), "notes.txt": "x", "Obligations/pages/gdpr-breach.md": "# GDPR: breach notification\n\n- Notify within 72 hours.\n" });
    const text = await run(["check", root]);
    expect(text.code).toBe(2);
    expect(text.out.split("\n")).toEqual([
      "Obligations/pages/gdpr-breach.md: is not Markdown as Stuga writes it, so an import would change it",
      "    @@ line 3 @@",
      "     # GDPR: breach notification",
      "     ",
      "    -- Notify within 72 hours.",
      "    +* Notify within 72 hours.",
      "notes.txt: is not part of the archive: stuga.json names no such file",
      `2 problems in ${root} (4 items, 3 bodies, 2 rows, 1 image, 3 sample steps)`,
      "",
    ]);
    const json = await run(["check", root, "--json"]);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, counts: { items: 4 }, issues: [{ at: "Obligations/pages/gdpr-breach.md" }, { at: "notes.txt" }] });
  });

  it("refuses what it cannot check with exit 2", async () => {
    const root = await unzipped({ "a.stuga.zip": "PK" });
    for (const argv of [["check"], ["verify", root], ["check", root, "--fix"], ["check", join(root, "missing")], ["check", join(root, "a.stuga.zip")]]) {
      const err = await runArchiveCommand(argv, () => {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OpsError);
      expect((err as OpsError).exitCode).toBe(2);
    }
  });
});
