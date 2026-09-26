import { CITATIONS_MAX, CITED_EDITS_MAX } from "@stuga/agent-surface/catalog";
import { SAFE_IMAGE_MIMES } from "@stuga/protocol/api/media";
import { getStugaSchema, markdownToDoc } from "@stuga/crdt-ops";
import { describe, expect, it } from "vitest";
import { parseColumnSpecs } from "../databases/propose.js";
import { MAX_IMPORT_MARKDOWN_BYTES } from "@stuga/protocol/text/markdown-import";
import { MAX_UPLOAD_BYTES_CEILING } from "../media/media.js";
import {
  ARCHIVE_MAX_BODY_BYTES,
  ARCHIVE_MAX_MEDIA_BYTES,
  ARCHIVE_RESERVED_NAMES,
  ARCHIVE_VERSION,
  ArchiveError,
  SAMPLE_MAX_CITATIONS,
  SAMPLE_MAX_EDITS,
  archiveCellValue,
  archiveHref,
  archiveIndex,
  archiveName,
  archiveNameRoom,
  archivePathProblem,
  archiveTitle,
  bodyFile,
  bodyMarkdown,
  derivedTitle,
  formatTableRows,
  isArchiveHref,
  mediaPath,
  parseManifest,
  parseMediaPath,
  parseSamplesIndex,
  parseTableRows,
  resolveArchiveHref,
  type ArchiveTable,
} from "./format.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const settings = (title: string) => ({
  title,
  title_source: "heading",
  agent_mode: "review",
  locked: false,
  search_hidden: false,
  agent_instructions: "",
});

/** One of everything the format carries. */
function sample(): Json {
  return {
    format: "stuga-workspace",
    version: 1,
    generator: "stuga 0.2.0",
    exported_at: "2026-09-25T10:00:00Z",
    workspace: { name: "Privacy laws", agent_instructions: "Cite the article." },
    start: "Start here.md",
    items: [
      { kind: "doc", path: "Start here.md", parent: null, ...settings("Start here") },
      { kind: "folder", path: "Laws", parent: null, title: "Laws", agent_instructions: "Quote the official text." },
      {
        kind: "doc",
        path: "Laws/个人信息保护法.md",
        parent: "Laws",
        ...settings("中华人民共和国个人信息保护法"),
        agent_mode: "auto",
        locked: true,
        comments: [
          { num: 1, parent: null, author_name: "Liv", created_at: "2026-09-20T08:30:00.123+02:00", resolved: false, quote: "第一条", body: "Check this." },
          { num: 2, parent: 1, author_name: "Liv", created_at: "2026-09-20T09:00:00Z", resolved: true, quote: null, body: "Done." },
        ],
      },
      {
        kind: "database",
        path: "Obligations",
        parent: null,
        ...settings("Obligations"),
        title_source: "user",
        search_hidden: true,
        tables: [
          {
            name: "Obligations",
            file: "Obligations/Obligations.jsonl",
            columns: [
              { name: "Law", type: "text" },
              { name: "Topic", type: "single_select", choices: ["Consent", "Breach notification"] },
              { name: "Deadline (hours)", type: "number", description: "Hours after discovery." },
              { name: "Checked", type: "checkbox" },
              { name: "In force", type: "date" },
            ],
            views: [
              {
                name: "Breach",
                kind: "table",
                position: 0,
                filter: { and: [{ column: "Topic", op: "eq", value: "Breach notification" }, { or: [{ column: "Checked", op: "eq", value: true }, { column: "_doc_id", op: "not_empty" }] }] },
                sorts: [{ column: "Deadline (hours)", dir: "asc" }, { column: "_created_at", dir: "desc" }],
                group_by: "Law",
                hidden_columns: ["In force"],
                config: { widths: { Law: 240 } },
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
          edits: [{ old_string: "Welcome", new_string: "Welcome[^1]" }],
          citations: [{ n: 1, doc: "Laws/个人信息保护法.md", heading_path: "第一章", content: "第一条" }],
        },
        { kind: "row", database: "Obligations", table: "Obligations", row: "gdpr-breach", values: { "Deadline (hours)": 72, Checked: true } },
        { kind: "comment", doc: "Obligations/pages/gdpr-breach.md", body: "{{me}}, please check the deadline.", quote: "72 hours" },
      ],
    },
  };
}

function refusal(raw: unknown): ArchiveError {
  try {
    parseManifest(raw);
  } catch (err) {
    if (err instanceof ArchiveError) return err;
    throw err;
  }
  throw new Error("the manifest was accepted");
}

/** A copy of the sample with one change. */
function changed(edit: (m: Json) => void): Json {
  const m = sample();
  edit(m);
  return m;
}

const obligations = (m: Json): Json => m.items[3].tables[0];

describe("parseManifest", () => {
  it("returns a valid manifest with every field it knows", () => {
    const m = parseManifest(sample());
    expect(m.workspace).toEqual({ name: "Privacy laws", agent_instructions: "Cite the article." });
    expect(m.start).toBe("Start here.md");
    expect(m.items.map((i) => i.kind)).toEqual(["doc", "folder", "doc", "database"]);
    const db = m.items[3]!;
    expect(db.kind === "database" && db.tables[0]!.views[0]!.filter).toEqual(sample().items[3].tables[0].views[0].filter);
    expect(m.sample?.steps.map((s) => s.kind)).toEqual(["edit", "row", "comment"]);
  });

  it("leaves out fields it does not know, at every level", () => {
    const m = parseManifest(
      changed((m) => {
        m.future = 1;
        m.workspace.icon = "x";
        m.items[0].color = "red";
        obligations(m).columns[0].width = 10;
      }),
    );
    expect(m).not.toHaveProperty("future");
    expect(m.workspace).not.toHaveProperty("icon");
    expect(m.items[0]).not.toHaveProperty("color");
    const db = m.items[3]!;
    expect(db.kind === "database" && db.tables[0]!.columns[0]).toEqual({ name: "Law", type: "text" });
  });

  it("refuses a newer version before reading anything else", () => {
    const err = refusal({ format: "stuga-workspace", version: ARCHIVE_VERSION + 1 });
    expect(err.at).toBe("version");
    expect(err.reason).toContain("newer Stuga");
  });

  it("accepts the smallest archive: a workspace with nothing in it", () => {
    const m = parseManifest({ format: "stuga-workspace", version: 1, generator: "x", exported_at: "2026-09-25T10:00:00Z", workspace: { name: "W", agent_instructions: "" }, items: [] });
    expect(m.items).toEqual([]);
    expect(m).not.toHaveProperty("start");
  });

  const refusals: Array<[string, (m: Json) => void, string, string]> = [
    ["another format", (m) => (m.format = "zip"), "format", "not a Stuga workspace archive"],
    ["a version below 1", (m) => (m.version = 0), "version", "whole number"],
    ["a version given as text", (m) => (m.version = "1"), "version", "whole number"],
    ["no generator", (m) => delete m.generator, "generator", "is required"],
    ["a day that does not exist", (m) => (m.exported_at = "2026-02-30T10:00:00Z"), "exported_at", "ISO 8601"],
    ["a time without a zone", (m) => (m.exported_at = "2026-09-25T10:00:00"), "exported_at", "ISO 8601"],
    ["year 0, which Postgres does not read", (m) => (m.exported_at = "0000-01-01T00:00:00Z"), "exported_at", "ISO 8601"],
    ["an offset without a colon", (m) => (m.exported_at = "2026-09-25T10:00:00+0530"), "exported_at", "ISO 8601"],
    ["a name with a line separator", (m) => (m.workspace.name = "Privacy\u2028laws"), "workspace.name", "line break"],
    ["a padded workspace name", (m) => (m.workspace.name = " Laws"), "workspace.name", "start or end with a space"],
    ["a workspace name over 100", (m) => (m.workspace.name = "x".repeat(101)), "workspace.name", "longer than 100"],
    ["workspace instructions over the cap", (m) => (m.workspace.agent_instructions = "x".repeat(20_001)), "workspace.agent_instructions", "longer than 20000"],
    ["an unknown kind", (m) => (m.items[0].kind = "board"), "items[0].kind", "folder, doc, database"],
    ["a path that climbs", (m) => (m.items[0].path = "../x.md"), "items[0].path", "starts with a dot"],
    ["an absolute path", (m) => (m.items[0].path = "/x.md"), "items[0].path", "empty segment"],
    ["a backslash", (m) => (m.items[0].path = "a\\b.md"), "items[0].path", "control character"],
    ["a NUL", (m) => (m.items[0].path = "a\u0000.md"), "items[0].path", "control character"],
    ["a direction mark", (m) => (m.items[0].path = "evil\u202edm.exe.md"), "items[0].path", "direction mark"],
    ["a Windows device name", (m) => (m.items[0].path = "CON.md"), "items[0].path", "device name"],
    ["a device name before spaces and an extension", (m) => (m.items[0].path = "NUL .md"), "items[0].path", "device name"],
    ["a trailing dot", (m) => ((m.items[1].path = "Laws."), (m.items[1].title = "Laws.")), "items[1].path", "ends with a dot"],
    ["a name a Docker build leaves out", (m) => (m.items[1].path = "node_modules"), "items[1].path", "Docker build"],
    ["a decomposed name", (m) => (m.items[0].path = "Cafe\u0301.md"), "items[0].path", "NFC"],
    ["a segment over 200 bytes", (m) => (m.items[0].path = `${"法".repeat(67)}.md`), "items[0].path", "longer than 200 bytes"],
    ["a parent listed after its child", (m) => m.items.splice(1, 2, m.items[2], m.items[1]), "items[1].parent", "not a folder listed before"],
    ["a parent that is not a folder", (m) => (m.items[2].parent = "Obligations"), "items[2].parent", "not a folder listed before"],
    ["a path outside its parent", (m) => (m.items[2].path = "个人信息保护法.md"), "items[2].path", "directly in its parent"],
    ["the top-level media folder", (m) => ((m.items[1].path = "Media"), (m.items[2].parent = "Media"), (m.items[2].path = "Media/x.md")), "items[1].path", "keeps for itself"],
    ["a document that is no .md file", (m) => (m.items[0].path = "Start here.txt"), "items[0].path", "must be a .md file"],
    ["a title over 200", (m) => (m.items[0].title = "x".repeat(201)), "items[0].title", "longer than 200"],
    ["a title with a line break", (m) => (m.items[0].title = "a\nb"), "items[0].title", "line break"],
    ["a title with a control character", (m) => (m.items[0].title = "a\u0007b"), "items[0].title", "control character"],
    ["a title with a C1 line break", (m) => (m.items[0].title = "a\u0085b"), "items[0].title", "line break"],
    ["an empty title", (m) => (m.items[0].title = ""), "items[0].title", "must not be empty"],
    ["an unknown title source", (m) => (m.items[0].title_source = "file"), "items[0].title_source", "heading, user"],
    ["an unknown agent mode", (m) => (m.items[0].agent_mode = "off"), "items[0].agent_mode", "review, auto"],
    ["a lock given as text", (m) => (m.items[0].locked = "true"), "items[0].locked", "true or false"],
    ["no search_hidden", (m) => delete m.items[0].search_hidden, "items[0].search_hidden", "true or false"],
    ["comments out of order", (m) => (m.items[2].comments[1].num = 1), "items[2].comments[1].num", "num order"],
    ["a reply to a reply", (m) => m.items[2].comments.push({ ...m.items[2].comments[1], num: 3, parent: 2 }), "items[2].comments[2].parent", "first comment of a thread"],
    ["a reply with a quote", (m) => (m.items[2].comments[1].quote = "x"), "items[2].comments[1].quote", "first comment"],
    ["a comment body over the cap", (m) => (m.items[2].comments[0].body = "x".repeat(20_001)), "items[2].comments[0].body", "longer than 20000"],
    ["a quote over the cap", (m) => (m.items[2].comments[0].quote = "x".repeat(2_001)), "items[2].comments[0].quote", "longer than 2000"],
    ["a padded comment body", (m) => (m.items[2].comments[0].body = "x\n"), "items[2].comments[0].body", "start or end with a space"],
    // An override would reverse the " · imported" the app shows after the name.
    ["a direction mark in an author's name", (m) => (m.items[2].comments[0].author_name = "Liv\u202e"), "items[2].comments[0].author_name", "direction mark"],
    ["an isolate in an author's name", (m) => (m.items[2].comments[0].author_name = "\u2067Liv"), "items[2].comments[0].author_name", "direction mark"],
    ["a tab in an author's name", (m) => (m.items[2].comments[0].author_name = "Liv\tH"), "items[2].comments[0].author_name", "a tab"],
    ["an author's name that shows nothing", (m) => (m.items[2].comments[0].author_name = "\u200b"), "items[2].comments[0].author_name", "visible character"],
    ["a comment time that is no time", (m) => (m.items[2].comments[0].created_at = "yesterday"), "items[2].comments[0].created_at", "ISO 8601"],
    ["an offset Postgres does not read", (m) => (m.items[2].comments[0].created_at = "2026-09-25T10:00:00+16:00"), "items[2].comments[0].created_at", "within ±15:59"],
    ["an offset past -15:59", (m) => (m.items[2].comments[0].created_at = "2026-09-25T10:00:00-20:00"), "items[2].comments[0].created_at", "within ±15:59"],
    ["too many tables", (m) => (m.items[3].tables = Array.from({ length: 21 }, (_, i) => ({ name: `T${i}`, file: `Obligations/T${i}.jsonl`, columns: [], views: [], pages: [] }))), "items[3].tables", "max 20"],
    ["two tables named alike", (m) => (m.items[3].tables[1].name = "OBLIGATIONS"), "items[3].tables[1].name", "listed twice"],
    ["a rows file outside the database", (m) => (obligations(m).file = "Obligations.jsonl"), "items[3].tables[0].file", "directly in the database's folder"],
    ["a rows file deeper in the database", (m) => (obligations(m).file = "Obligations/rows/Obligations.jsonl"), "items[3].tables[0].file", "directly in the database's folder"],
    ["a rows file that is no .jsonl", (m) => (obligations(m).file = "Obligations/Obligations.csv"), "items[3].tables[0].file", ".jsonl file"],
    ["too many columns", (m) => (obligations(m).columns = Array.from({ length: 65 }, (_, i) => ({ name: `c${i}`, type: "text" }))), "items[3].tables[0].columns", "max 64"],
    ["a column type it does not know", (m) => (obligations(m).columns[0].type = "url"), "items[3].tables[0].columns[0].type", "text, number"],
    ["a column named like a row's own field", (m) => (obligations(m).columns[0].name = "_id"), "items[3].tables[0].columns[0].name", "row's own field"],
    ["two columns named alike", (m) => (obligations(m).columns[1].name = "law"), "items[3].tables[0].columns[1].name", "listed twice"],
    ["a padded column name", (m) => (obligations(m).columns[0].name = "Law "), "items[3].tables[0].columns[0].name", "start or end with a space"],
    ["a select without choices", (m) => delete obligations(m).columns[1].choices, "items[3].tables[0].columns[1].choices", "non-empty choices"],
    ["choices repeated", (m) => (obligations(m).columns[1].choices = ["a", "a"]), "items[3].tables[0].columns[1].choices", "duplicate choice"],
    ["choices on a text column", (m) => (obligations(m).columns[0].choices = ["a"]), "items[3].tables[0].columns[0].choices", "only a single_select"],
    ["a description over 500", (m) => (obligations(m).columns[2].description = "x".repeat(501)), "items[3].tables[0].columns[2].description", "longer than 500"],
    ["two views named alike", (m) => obligations(m).views.push({ ...obligations(m).views[0], name: "breach" }), "items[3].tables[0].views[1].name", "listed twice"],
    ["a view kind it does not know", (m) => (obligations(m).views[0].kind = "board"), "items[3].tables[0].views[0].kind", "must be one of table"],
    ["a sort on no column", (m) => (obligations(m).views[0].sorts[0].column = "Nope"), "items[3].tables[0].views[0].sorts[0].column", "must name a column"],
    ["a column sorted twice", (m) => (obligations(m).views[0].sorts[1].column = "Deadline (hours)"), "items[3].tables[0].views[0].sorts[1].column", "once in the sort order"],
    ["a sort without a direction", (m) => delete obligations(m).views[0].sorts[0].dir, "items[3].tables[0].views[0].sorts[0].dir", "asc, desc"],
    ["a row's own field hidden", (m) => (obligations(m).views[0].hidden_columns = ["_id"]), "items[3].tables[0].views[0].hidden_columns[0]", "must name a column"],
    ["a column hidden twice", (m) => (obligations(m).views[0].hidden_columns = ["Law", "Law"]), "items[3].tables[0].views[0].hidden_columns[1]", "listed twice"],
    ["a group grouped by no column", (m) => (obligations(m).views[0].group_by = "Nope"), "items[3].tables[0].views[0].group_by", "must name a column"],
    ["a filter with no condition", (m) => (obligations(m).views[0].filter = { and: [] }), "items[3].tables[0].views[0].filter", "at least one condition"],
    ["filter groups four deep", (m) => (obligations(m).views[0].filter = { and: [{ or: [{ and: [{ or: [{ column: "Law", op: "empty" }] }] }] }] }), "items[3].tables[0].views[0].filter.and[0].or[0].and[0]", "at most 3 deep"],
    ["a filter of 21 conditions", (m) => (obligations(m).views[0].filter = { or: [{ and: Array(10).fill({ column: "Law", op: "empty" }) }, { and: Array(11).fill({ column: "Law", op: "empty" }) }] }), "items[3].tables[0].views[0].filter.or[1].and[10]", "at most 20 conditions"],
    ["a group that is both and and or", (m) => (obligations(m).views[0].filter = { and: [], or: [] }), "items[3].tables[0].views[0].filter", "either and or or"],
    ["a filter op it does not know", (m) => (obligations(m).views[0].filter = { column: "Law", op: "like", value: "x" }), "items[3].tables[0].views[0].filter.op", "contains"],
    ["a value on empty", (m) => (obligations(m).views[0].filter = { column: "Law", op: "empty", value: "x" }), "items[3].tables[0].views[0].filter.value", "takes no value"],
    ["a comparison without a value", (m) => (obligations(m).views[0].filter = { column: "Law", op: "eq" }), "items[3].tables[0].views[0].filter.value", "needs a string"],
    ["a text value on a number column", (m) => (obligations(m).views[0].filter = { column: "Deadline (hours)", op: "gt", value: "soon" }), "items[3].tables[0].views[0].filter.value", "is not a number"],
    ["a page id in a filter", (m) => (obligations(m).views[0].filter = { column: "_doc_id", op: "eq", value: "doc_1" }), "items[3].tables[0].views[0].filter.op", "_doc_id only takes"],
    ["a row id that is no row key", (m) => (obligations(m).views[0].filter = { column: "_id", op: "eq", value: "row 1" }), "items[3].tables[0].views[0].filter.value", "row key"],
    ["a config over 16 KiB", (m) => (obligations(m).views[0].config = { x: "x".repeat(16 * 1024) }), "items[3].tables[0].views[0].config", "larger than"],
    ["a config nested past what JSON can write", (m) => (obligations(m).views[0].config = JSON.parse(`${'{"a":'.repeat(20_000)}1${"}".repeat(20_000)}`)), "items[3].tables[0].views[0].config", "nested too deeply"],
    ["a view without config", (m) => delete obligations(m).views[0].config, "items[3].tables[0].views[0].config", "must be an object"],
    ["a page row that is no row key", (m) => (obligations(m).pages[0].row = "gdpr breach"), "items[3].tables[0].pages[0].row", "row key"],
    ["two pages for one row", (m) => obligations(m).pages.push({ ...obligations(m).pages[0], file: "Obligations/pages/other.md" }), "items[3].tables[0].pages[1].row", "has one page"],
    ["a page outside its database", (m) => (obligations(m).pages[0].file = "gdpr-breach.md"), "items[3].tables[0].pages[0].file", "inside the database's folder"],
    ["a page inside another page's path", (m) => obligations(m).pages.push({ ...obligations(m).pages[0], row: "other", file: "Obligations/pages/gdpr-breach.md/x.md" }), "items[3].tables[0].pages[0].file", "lies inside it"],
    ["a start that is no document", (m) => (m.start = "Obligations"), "start", "not a document"],
    ["a start that is a row page", (m) => (m.start = "Obligations/pages/gdpr-breach.md"), "start", "not a document"],
    ["an edit with no edits", (m) => (m.sample.steps[0].edits = []), "sample.steps[0].edits", "at least one edit"],
    ["an edit with an empty old_string", (m) => (m.sample.steps[0].edits[0].old_string = ""), "sample.steps[0].edits[0].old_string", "must not be empty"],
    [
      "new text larger than a body",
      (m) => m.sample.steps[0].edits.push({ old_string: "Read", new_string: "é".repeat(2_100_000) }),
      "sample.steps[0].edits",
      "add up to 4200011 bytes (max 4194304)",
    ],
    ["an edit to a database", (m) => (m.sample.steps[0].doc = "Obligations"), "sample.steps[0].doc", "not a document or row page"],
    ["a source cited twice", (m) => m.sample.steps[0].citations.push(m.sample.steps[0].citations[0]), "sample.steps[0].citations[1].n", "cited twice"],
    ["a citation with no content", (m) => delete m.sample.steps[0].citations[0].content, "sample.steps[0].citations[0].content", "is required"],
    ["a row step on no table", (m) => (m.sample.steps[1].table = "Nope"), "sample.steps[1].table", "must name a table"],
    ["a row step on no database", (m) => (m.sample.steps[1].database = "Laws"), "sample.steps[1].database", "not a database"],
    ["a row step on no column", (m) => (m.sample.steps[1].values = { Nope: 1 }), "sample.steps[1].values", "not a column"],
    ["a row step with a bad cell", (m) => (m.sample.steps[1].values = { Checked: 1 }), "sample.steps[1].values.Checked", "true or false"],
    ["a row step that changes nothing", (m) => (m.sample.steps[1].values = {}), "sample.steps[1].values", "at least one cell"],
    ["a placeholder it does not know", (m) => (m.sample.steps[2].body = "{{you}}, look"), "sample.steps[2].body", "only one"],
    ["a step kind it does not know", (m) => (m.sample.steps[0].kind = "delete"), "sample.steps[0].kind", "edit, row, comment"],
  ];

  it.each(refusals)("refuses %s", (_name, edit, at, reason) => {
    const err = refusal(changed(edit));
    expect(err.at).toBe(at);
    expect(err.reason).toContain(reason);
  });

  it("names the other item when two paths differ only in case", () => {
    const err = refusal(changed((m) => m.items.push({ kind: "doc", path: "start HERE.md", parent: null, ...settings("x") })));
    expect(err.at).toBe("items[4].path");
    expect(err.reason).toContain("also the path of items[0].path");
    // A Mac folds σ and ς to one letter; lower case alone keeps them apart.
    const greek = refusal(changed((m) => m.items.push({ kind: "doc", path: "ας.md", parent: null, ...settings("x") }, { kind: "doc", path: "ασ.md", parent: null, ...settings("y") })));
    expect(greek.at).toBe("items[5].path");
    // A Mac folds ẞ, ß and ss to one name.
    const sharp = refusal(changed((m) => m.items.push({ kind: "doc", path: "Straße.md", parent: null, ...settings("x") }, { kind: "doc", path: "STRAẞE.md", parent: null, ...settings("y") })));
    expect(sharp.at).toBe("items[5].path");
  });

  it("refuses two spellings of a folder a row page's file lies in", () => {
    const err = refusal(changed((m) => obligations(m).pages.push({ ...obligations(m).pages[0], row: "pipl-consent", file: "Obligations/Pages/pipl-consent.md" })));
    expect(err.at).toBe("items[3].tables[0].pages[1].file");
    expect(err.reason).toBe('"Obligations/Pages/pipl-consent.md" lies in "Obligations/Pages", but another path lies in "Obligations/pages"; paths must differ in more than letter case');
    expect(() => parseManifest(changed((m) => obligations(m).pages.push({ ...obligations(m).pages[0], row: "pipl-consent", file: "Obligations/pages/pipl-consent.md" })))).not.toThrow();
  });

  it("reads a time with Z or an offset within ±15:59, from year 1", () => {
    for (const time of ["2026-09-25T10:00:00+15:59", "2026-09-25T10:00:00.123456789-15:59", "0001-01-01T00:00:00Z", "2026-09-25T24:00:00Z"]) {
      const laws = parseManifest(changed((m) => (m.items[2].comments[0].created_at = time))).items[2]!;
      expect(laws.kind === "doc" && laws.comments?.[0]?.created_at).toBe(time);
    }
  });

  it("takes a tab in a title or a name, and reads an empty quote as none", () => {
    const m = parseManifest(
      changed((m) => {
        m.items[0].title = "Name\tAge";
        obligations(m).columns[0].name = "Law\tcode";
        obligations(m).views[0].group_by = "Law\tcode";
        m.items[2].comments[0].quote = "";
      }),
    );
    expect(m.items[0]).toMatchObject({ title: "Name\tAge" });
    const laws = m.items[2]!;
    expect(laws.kind === "doc" && laws.comments?.[0]?.quote).toBeNull();
  });

  it("names the segment at fault once", () => {
    expect(refusal(changed((m) => (m.items[0].path = "CON.md"))).reason).toBe('"CON.md" is a device name on Windows');
    expect(archivePathProblem("a/../b.md")).toBe('has "..", which starts with a dot');
    expect(resolveArchiveHref("a.md", "x/%2Eb.md")).toEqual({ ok: false, reason: 'leads to "x/.b.md", a path that has ".b.md", which starts with a dot' });
  });

  it("refuses folders nested more than 32 deep", () => {
    const items = Array.from({ length: 33 }, (_, i) => {
      const path = Array.from({ length: i + 1 }, (_, j) => `f${j}`).join("/");
      return { kind: "folder", path, parent: i === 0 ? null : path.slice(0, path.lastIndexOf("/")), title: `f${i}`, agent_instructions: "" };
    });
    const err = refusal(changed((m) => (m.items = items)));
    expect(err.at).toBe("items[32].path");
    expect(err.reason).toContain("at most 32 deep");
  });

  it("indexes every body, database, folder and rows file by path", () => {
    const index = archiveIndex(parseManifest(sample()));
    expect([...index.bodies.keys()]).toEqual(["Start here.md", "Laws/个人信息保护法.md", "Obligations/pages/gdpr-breach.md"]);
    expect(index.bodies.get("Obligations/pages/gdpr-breach.md")).toMatchObject({ kind: "page", table: { name: "Obligations" } });
    expect([...index.databases.keys()]).toEqual(["Obligations"]);
    expect([...index.folders.keys()]).toEqual(["Laws"]);
    expect([...index.tables.keys()]).toEqual(["Obligations/Obligations.jsonl", "Obligations/Sources.jsonl"]);
  });

  it("accepts no column parseColumnSpecs would refuse", () => {
    const specs: unknown[][] = [
      [{ name: "A", type: "text" }],
      [{ name: "A", type: "text" }, { name: "a", type: "number" }],
      [{ name: " A", type: "text" }],
      [{ name: "", type: "text" }],
      [{ name: "x".repeat(201), type: "text" }],
      [{ name: "A", type: "url" }],
      [{ name: "A", type: "single_select" }],
      [{ name: "A", type: "single_select", choices: ["x", 1] }],
      [{ name: "A", type: "text", description: 5 }],
      [{ name: "A", type: "text", description: "x".repeat(501) }],
      Array.from({ length: 65 }, (_, i) => ({ name: `c${i}`, type: "text" })),
    ];
    const accepted = specs.filter((columns) => {
      try {
        parseManifest(changed((m) => ((obligations(m).columns = columns), (obligations(m).views = []), (m.sample.steps = []))));
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted).toEqual([specs[0]]);
    for (const columns of [...accepted, sample().items[3].tables[0].columns]) expect(parseColumnSpecs(columns).ok).toBe(true);
  });

  it("caps sample edits as the propose route caps an agent's, and images as the media store does", () => {
    expect(SAMPLE_MAX_EDITS).toBe(CITED_EDITS_MAX);
    expect(SAMPLE_MAX_CITATIONS).toBe(CITATIONS_MAX);
    expect(ARCHIVE_MAX_MEDIA_BYTES).toBe(MAX_UPLOAD_BYTES_CEILING);
  });
});

describe("archivePathProblem", () => {
  it.each(["a.md", "Laws/个人信息保护法.md", "قوانين/قانون.md", "Q3 (draft) & notes #2.md", "a/b/c/d.jsonl", "README.md", "data.md", "Datasets", "Data", "x/Backups", "NUL x.md", "Con _.NET.md", "CONIN.md"])(
    "accepts %s",
    (path) => expect(archivePathProblem(path)).toBeNull(),
  );

  it.each([
    ["", "is empty"],
    ["a//b.md", "empty segment"],
    ["a/", "empty segment"],
    [".hidden.md", "starts with a dot"],
    ["a/../b.md", "starts with a dot"],
    ["a:b.md", "< > :"],
    ["a|b.md", "< > :"],
    ["a\tb.md", "control character"],
    [" a.md", "starts or ends with a space"],
    ["a /b.md", "starts or ends with a space"],
    ["nul", "device name"],
    ["Lpt1.txt", "device name"],
    ["NUL .md", "device name"],
    ["Com1  .tar.gz", "device name"],
    ["CONIN$.md", "device name"],
    ["conout$", "device name"],
    ["x/dist/y.md", "Docker build"],
    ["x/backups", "Docker build"],
    ["a\u061cb.md", "direction mark"],
    ["a.tsbuildinfo", "Docker build"],
    ["a\ud800.md", "not valid Unicode"],
    [`${"a/".repeat(600)}b.md`, "longer than 1024 bytes"],
  ])("refuses %j", (path, reason) => expect(archivePathProblem(path)).toContain(reason));
});

describe("archiveName", () => {
  it("turns any title into a name every path rule accepts", () => {
    const titles = [
      "Q3: plan / draft?",
      "  .hidden notes.  ",
      "...",
      "",
      "CON",
      "con.txt",
      "nul",
      "Con .NET",
      "CONOUT$",
      "data",
      "build.tsbuildinfo",
      "a\u0000b\u202ec",
      "e\u0301 and \ud800",
      "总\u3000则",
      "法".repeat(300),
      "<>:\"/\\|?*",
    ];
    for (const extension of ["", ".md", ".jsonl"]) {
      const taken = new Set<string>();
      const names = titles.map((title) => archiveName(title, taken, extension));
      for (const name of names) expect(archivePathProblem(name), name).toBeNull();
      expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    }
  });

  it("keeps a plain title as it is, and tells alike titles apart ignoring case", () => {
    const taken = new Set(ARCHIVE_RESERVED_NAMES);
    expect(archiveName("个人信息保护法", taken, ".md")).toBe("个人信息保护法.md");
    expect(archiveName("Notes", taken, ".md")).toBe("Notes.md");
    expect(archiveName("notes", taken, ".md")).toBe("notes (2).md");
    expect(archiveName("NOTES", taken, ".md")).toBe("NOTES (3).md");
    expect(archiveName("Media", taken)).toBe("Media (2)");
    expect(archiveName("Q3: plan / draft", taken, ".md")).toBe("Q3 plan draft.md");
    expect(archiveName("CON", taken, ".md")).toBe("CON_.md");
    expect(archiveName("Con .NET", taken, ".md")).toBe("Con _.NET.md");
    expect(archiveName("Straße", taken, ".md")).toBe("Straße.md");
    expect(archiveName("STRAẞE", taken, ".md")).toBe("STRAẞE (2).md");
    expect(archiveName("data", taken)).toBe("data_");
    expect(archiveName("  ", taken, ".md")).toBe("Untitled.md");
  });

  it("keeps every path of the deepest tree within 1,024 bytes, however long its titles", () => {
    // 32 folders, a database in the deepest, and its row's page one folder down: 35 names deep.
    const long = "法".repeat(200);
    let parent = "";
    const items: Json[] = [];
    for (let depth = 0; depth < 32; depth++) {
      const path = (parent ? `${parent}/` : "") + archiveName(long, new Set(ARCHIVE_RESERVED_NAMES), "", archiveNameRoom(parent, 35 - depth));
      items.push({ kind: "folder", path, parent: parent || null, title: "f", agent_instructions: "" });
      parent = path;
    }
    const db = `${parent}/${archiveName(long, new Set(), "", archiveNameRoom(parent, 3))}`;
    const pages = `${db}/${archiveName(long, new Set(), "", archiveNameRoom(db, 2))}`;
    const table = { name: "T", file: `${db}/${archiveName(long, new Set(), ".jsonl", archiveNameRoom(db, 1))}`, columns: [], views: [], pages: [{ row: "r1", file: `${pages}/${archiveName(long, new Set(), ".md", archiveNameRoom(pages, 1))}`, ...settings("r1") }] };
    items.push({ kind: "database", path: db, parent, ...settings("DB"), tables: [table] });
    expect(() => parseManifest({ ...changed((m) => delete m.sample), start: undefined, items })).not.toThrow();
    // A shallow item keeps a long name.
    expect(archiveNameRoom("", 1)).toBe(200);
  });
});

describe("archiveTitle", () => {
  it("writes any title as one line of at most 200 characters", () => {
    expect(archiveTitle("Name\tAge")).toBe("Name\tAge");
    expect(archiveTitle("Acme\nBerlin\r\u0007")).toBe("Acme Berlin  ");
    expect(archiveTitle("Acme\u0085Berlin\u2028Paris\u2029")).toBe("Acme Berlin Paris ");
    expect(archiveTitle(`${"x".repeat(199)}😀`)).toBe(`${"x".repeat(199)}\ufffd`);
    expect(archiveTitle("x".repeat(500))).toHaveLength(200);
    expect(archiveTitle("")).toBe("Untitled");
    for (const title of ["a\nb", `${"x".repeat(199)}😀`, "\u0000", "a\u0085b\u2028c\u009f"]) {
      expect(() => parseManifest(changed((m) => (m.items[0].title = archiveTitle(title))))).not.toThrow();
    }
  });
});

describe("rows", () => {
  const table: ArchiveTable = {
    name: "T",
    file: "DB/T.jsonl",
    columns: [
      { name: "Name", type: "text" },
      { name: "Count", type: "number" },
      { name: "Done", type: "checkbox" },
      { name: "Due", type: "date" },
      { name: "Stage", type: "single_select", choices: ["Draft", "Final"] },
    ],
    views: [],
    pages: [],
  };

  const refused = (file: string): ArchiveError => {
    try {
      parseTableRows(file, table);
    } catch (err) {
      if (err instanceof ArchiveError) return err;
      throw err;
    }
    throw new Error("the rows were accepted");
  };

  it("reads each line as a row, with a checkbox stored as 0/1 and absent cells left out", () => {
    const file = '{"_id":"r1","Name":"Liv","Count":2.5,"Done":true,"Due":"2026-09-25","Stage":"Final"}\n{"_id":"r-2","Done":false,"Name":null}\n';
    expect(parseTableRows(file, table)).toEqual([
      { key: "r1", values: { Name: "Liv", Count: 2.5, Done: 1, Due: "2026-09-25", Stage: "Final" } },
      { key: "r-2", values: { Done: 0, Name: null } },
    ]);
    expect(parseTableRows("", table)).toEqual([]);
  });

  it("writes the file it reads, canonically", () => {
    const file = '{"_id":"r1","Name":"Liv","Count":2.5,"Done":true,"Due":"2026-09-25","Stage":"Final"}\n{"_id":"r-2","Done":false}\n';
    expect(formatTableRows(table, parseTableRows(file, table))).toBe(file);
    expect(formatTableRows(table, [{ key: "r3", values: { Stage: "Draft", Name: "x", Count: null } }])).toBe('{"_id":"r3","Name":"x","Stage":"Draft"}\n');
  });

  it.each([
    ['{"_id":"r1"}', "DB/T.jsonl", "end with a newline"],
    ['{"_id":"r1"}\r\n', "DB/T.jsonl:1", "not \\r\\n"],
    ['{"_id":"r1"}\n\n', "DB/T.jsonl:2", "is blank"],
    ["{_id:r1}\n", "DB/T.jsonl:1", "is not JSON"],
    ['["r1"]\n', "DB/T.jsonl:1", "must be an object"],
    ['{"Name":"x"}\n', "DB/T.jsonl:1: _id", "must be a row key"],
    ['{"_id":"r 1"}\n', "DB/T.jsonl:1: _id", "must be a row key"],
    ['{"_id":"r1"}\n{"_id":"r1"}\n', "DB/T.jsonl:2: _id", "used by an earlier row"],
    ['{"_id":"r1","Owner":"x"}\n', "DB/T.jsonl:1: Owner", "not a column"],
    ['{"_id":"r1","Done":1}\n', "DB/T.jsonl:1: Done", "true or false"],
    ['{"_id":"r1","Count":"3"}\n', "DB/T.jsonl:1: Count", "finite number"],
    ['{"_id":"r1","Due":"2026-02-30"}\n', "DB/T.jsonl:1: Due", "real calendar date"],
    ['{"_id":"r1","Stage":"Done"}\n', "DB/T.jsonl:1: Stage", "choices"],
    ['{"_id":"r1","Name":{"a":1}}\n', "DB/T.jsonl:1: Name", "expected a string"],
    [`{"_id":"r1","Name":"${"x".repeat(16_385)}"}\n`, "DB/T.jsonl:1: Name", "too long"],
  ])("refuses %j", (file, at, reason) => {
    const err = refused(file);
    expect(err.at).toBe(at);
    expect(err.reason).toContain(reason);
  });

  it("refuses more rows than a table holds", () => {
    const file = Array.from({ length: 50_001 }, (_, i) => `{"_id":"r${i}"}\n`).join("");
    expect(refused(file).reason).toContain("max 50000");
  });

  it("keeps a column named like an object's own fields", () => {
    const odd: ArchiveTable = {
      ...table,
      columns: [
        { name: "__proto__", type: "text" },
        { name: "constructor", type: "checkbox" },
        { name: "toString", type: "text" },
      ],
    };
    const file = '{"_id":"a","__proto__":"secret","toString":"x"}\n{"_id":"b","constructor":true}\n';
    const rows = parseTableRows(file, odd);
    expect(Object.keys(rows[0]!.values)).toEqual(["__proto__", "toString"]);
    expect(rows[0]!.values.constructor).toBeUndefined();
    expect(formatTableRows(odd, rows)).toBe(file);
    const step = parseManifest(
      changed((m) => {
        obligations(m).columns.push({ name: "__proto__", type: "text" });
        m.sample.steps[1].values = JSON.parse('{"__proto__":"x"}');
      }),
    ).sample!.steps[1]!;
    expect(step.kind === "row" && Object.entries(step.values)).toEqual([["__proto__", "x"]]);
  });

  it("spells a checkbox cell as true or false", () => {
    expect(archiveCellValue({ name: "D", type: "checkbox" }, true)).toEqual({ ok: true, value: 1 });
    expect(archiveCellValue({ name: "D", type: "checkbox" }, 0)).toEqual({ ok: false, reason: "expected true or false" });
    expect(archiveCellValue({ name: "D", type: "number" }, null)).toEqual({ ok: true, value: null });
  });
});

describe("links", () => {
  it("tells archive links from the rest", () => {
    for (const href of ["Laws/a.md", "../a.md", "a.md#view=x", "."]) expect(isArchiveHref(href)).toBe(true);
    for (const href of ["https://example.com", "mailto:liv@example.com", "mention:u_liv", "/doc/abc", "//host/x", "#top", ""]) {
      expect(isArchiveHref(href)).toBe(false);
    }
  });

  it("resolves a link against the body that holds it", () => {
    expect(resolveArchiveHref("Laws/a.md", "b.md")).toEqual({ ok: true, target: { path: "Laws/b.md" } });
    expect(resolveArchiveHref("Laws/a.md", "../Start%20here.md")).toEqual({ ok: true, target: { path: "Start here.md" } });
    expect(resolveArchiveHref("Start here.md", "Laws/")).toEqual({ ok: true, target: { path: "Laws" } });
    expect(resolveArchiveHref("DB/pages/r1.md", "./../../Laws/%E4%B8%AA.md")).toEqual({ ok: true, target: { path: "Laws/个.md" } });
    expect(resolveArchiveHref("a.md", "DB#table=Main&view=Open%20(all)&row=r1")).toEqual({
      ok: true,
      target: { path: "DB", table: "Main", view: "Open (all)", row: "r1" },
    });
  });

  it.each([
    ["../a.md", "climbs out"],
    ["a.md?x=1", "?query"],
    ["a\\b.md", "backslash"],
    ["a%2Fb.md", "encoded-slash"],
    ["a%zz.md", "malformed"],
    [".", "top of the archive"],
    ["DB#sort=x", "table=, view= and row="],
    ["DB#view=a&view=b", "view twice"],
    ["DB#view=", "empty view"],
    ["%2Ehidden.md", "starts with a dot"],
  ])("refuses %j", (href, reason) => {
    const out = resolveArchiveHref("a.md", href);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain(reason);
  });

  it.each([
    ["a.md", { path: "b.md" }, "b.md"],
    ["Laws/a.md", { path: "Start here.md" }, "../Start%20here.md"],
    ["Start here.md", { path: "Laws/个人信息保护法.md" }, "Laws/个人信息保护法.md"],
    ["DB/pages/r1.md", { path: "DB" }, ".."],
    ["DB/pages/r1.md", { path: "DB/pages" }, "."],
    ["x.md", { path: "Q3 (draft) & #2 [v1] 100%.md" }, "Q3%20%28draft%29%20%26%20%232%20%5Bv1%5D%20100%25.md"],
    ["x.md", { path: "总\u3000则.md" }, "总%E3%80%80则.md"],
    ["x.md", { path: "DB", table: "Main", view: "Open (all) & more", row: "r1" }, "DB#table=Main&view=Open%20%28all%29%20%26%20more&row=r1"],
  ])("from %s to %j writes %s, which resolves back", (from, target, href) => {
    expect(archiveHref(from, target)).toBe(href);
    expect(resolveArchiveHref(from, href)).toEqual({ ok: true, target });
  });
});

describe("media and bodies", () => {
  const hash = "a".repeat(64);

  it("names an image by its hash and type", () => {
    expect(mediaPath(hash, "image/jpeg")).toBe(`media/${hash}.jpg`);
    for (const mime of SAFE_IMAGE_MIMES) expect(parseMediaPath(mediaPath(hash, mime))).toEqual({ sha256: hash, mime });
    for (const path of [`media/${hash}.svg`, `media/${hash.toUpperCase()}.png`, `media/x/${hash}.png`, `${hash}.png`, `media/${hash}.jpeg`]) {
      expect(parseMediaPath(path)).toBeNull();
    }
  });

  it("keeps a body's Markdown with one closing newline", () => {
    expect(bodyFile("# A")).toBe("# A\n");
    expect(bodyFile("")).toBe("");
    expect(bodyMarkdown("# A\n", "a.md")).toBe("# A");
    expect(bodyMarkdown("", "a.md")).toBe("");
    expect(() => bodyMarkdown("# A", "a.md")).toThrow("a.md: must end with a newline");
  });

  it("derives a body's title as a flush does: its first non-empty line, where blocks and hard breaks end lines", () => {
    const title = (markdown: string) => derivedTitle(markdownToDoc(markdown, getStugaSchema()));
    expect(title("# The *x* Flag\n\nBody")).toBe("The x Flag");
    expect(title("First\\\nsecond")).toBe("First");
    expect(title("\n\n- One\n- Two")).toBe("One");
    expect(title("")).toBe("");
    expect(title(`# ${"a".repeat(300)}`)).toBe("a".repeat(200));
  });

  it("holds a body file to Stuga's cap on a body, and its closing newline", () => {
    expect(new TextEncoder().encode(bodyFile("x".repeat(MAX_IMPORT_MARKDOWN_BYTES))).length).toBe(ARCHIVE_MAX_BODY_BYTES);
  });
});

describe("parseSamplesIndex", () => {
  const index = (): Json => ({
    format: "stuga-samples",
    version: 1,
    tag: "v2026.09.25",
    samples: [
      {
        id: "privacy-laws",
        title: "Privacy laws",
        description: "Six data-protection laws in their own languages.",
        name: "Privacy laws",
        langs: ["en", "zh", "ja", "ko", "ar", "th"],
        file: "privacy-laws.stuga.zip",
        sha256: "0".repeat(64),
        bytes: 123_456,
        archive_version: 1,
      },
    ],
  });

  const refusedIndex = (edit: (i: Json) => void): ArchiveError => {
    const raw = index();
    edit(raw);
    try {
      parseSamplesIndex(raw);
    } catch (err) {
      if (err instanceof ArchiveError) return err;
      throw err;
    }
    throw new Error("the index was accepted");
  };

  it("reads a valid index, and leaves out unread a sample in a newer archive version or too large to import", () => {
    const raw = index();
    raw.tag = "v2026.09.25.2";
    raw.samples[0].extra = true;
    raw.samples.unshift({ ...index().samples[0], title: 5, archive_version: 2 }, { ...index().samples[0], title: 5, bytes: 50 * 1024 * 1024 + 1 });
    const parsed = parseSamplesIndex(raw);
    expect(parsed.tag).toBe("v2026.09.25.2");
    expect(parsed.samples).toEqual(index().samples);
  });

  it("reads the first 100 samples it can import", () => {
    const raw = index();
    raw.samples = Array.from({ length: 102 }, (_, i) => ({ ...index().samples[0], id: `s${i}`, file: `s${i}.stuga.zip`, archive_version: i === 0 ? 2 : 1 }));
    raw.samples[101].id = "Not an id";
    expect(parseSamplesIndex(raw).samples.map((s) => s.id)).toEqual(Array.from({ length: 100 }, (_, i) => `s${i + 1}`));
  });

  it.each<[string, (i: Json) => void, string, string]>([
    ["another format", (i) => (i.format = "x"), "format", "stuga-samples"],
    ["a newer version", (i) => (i.version = 2), "version", "reads version 1"],
    ["a tag that is no day", (i) => (i.tag = "v2026.02.30"), "tag", "vYYYY.MM.DD"],
    ["a tag numbered 0", (i) => (i.tag = "v2026.09.25.0"), "tag", "vYYYY.MM.DD"],
    ["a tag without v", (i) => (i.tag = "2026.09.25"), "tag", "vYYYY.MM.DD"],
    ["samples that are no list", (i) => (i.samples = {}), "samples", "must be an array"],
  ])("refuses an index with %s", (_name, edit, at, reason) => {
    const err = refusedIndex(edit);
    expect(err.at).toBe(at);
    expect(err.reason).toContain(reason);
  });

  it.each<[string, (i: Json) => void, string, string]>([
    ["an entry that is no object", (i) => (i.samples[0] = "privacy-laws"), "samples[0]", "object"],
    ["an id with capitals", (i) => (i.samples[0].id = "Privacy"), "samples[0].id", "a-z, 0-9"],
    ["an id over 40", (i) => (i.samples[0].id = "a".repeat(41)), "samples[0].id", "a-z, 0-9"],
    ["an id starting with -", (i) => (i.samples[0].id = "-x"), "samples[0].id", "a-z, 0-9"],
    ["an id listed twice", (i) => i.samples.push(i.samples[0]), "samples[1].id", "listed twice"],
    ["a title over 60", (i) => (i.samples[0].title = "x".repeat(61)), "samples[0].title", "longer than 60"],
    ["a description over 60", (i) => (i.samples[0].description = "x".repeat(61)), "samples[0].description", "longer than 60"],
    ["a name over 100", (i) => (i.samples[0].name = "x".repeat(101)), "samples[0].name", "longer than 100"],
    ["no languages", (i) => (i.samples[0].langs = []), "samples[0].langs", "at least one"],
    ["a language twice", (i) => (i.samples[0].langs = ["en", "en"]), "samples[0].langs", "each language once"],
    ["a region in a language", (i) => (i.samples[0].langs = ["zh-CN"]), "samples[0].langs[0]", "primary language tag"],
    ["a file named for another id", (i) => (i.samples[0].file = "other.stuga.zip"), "samples[0].file", "privacy-laws.stuga.zip"],
    ["a file elsewhere", (i) => (i.samples[0].file = "https://example.com/privacy-laws.stuga.zip"), "samples[0].file", "privacy-laws.stuga.zip"],
    ["a short hash", (i) => (i.samples[0].sha256 = "abc"), "samples[0].sha256", "64 lowercase hex"],
    ["a size that is no whole number", (i) => (i.samples[0].bytes = "1 MB"), "samples[0].bytes", "whole number"],
    ["an archive version 0", (i) => (i.samples[0].archive_version = 0), "samples[0].archive_version", "whole number"],
  ])("leaves out, saying why, a sample with %s, and reads the others", (_name, edit, at, reason) => {
    const raw = index();
    edit(raw);
    // One a newer node lists after it, unchanged.
    raw.samples.push({ ...index().samples[0], id: "handbook", file: "handbook.stuga.zip" });
    const heard: ArchiveError[] = [];
    const parsed = parseSamplesIndex(raw, (err) => void heard.push(err));
    expect(heard).toHaveLength(1);
    expect(heard[0]!.at).toBe(at);
    expect(heard[0]!.reason).toContain(reason);
    expect(parsed.samples.map((s) => s.id)).toEqual(at === "samples[1].id" ? ["privacy-laws", "handbook"] : ["handbook"]);
  });
});
