/**
 * A small workspace archive with one of everything an import writes: a folder, two documents, a
 * database of two tables with views and a row page, an image, comments, links of every kind, and a
 * mention. For tests only.
 */
import { createHash } from "node:crypto";
import { zipFiles } from "../../lib/zip.js";
import { MANIFEST_NAME } from "../format.js";

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const text = (s: string): Uint8Array => new TextEncoder().encode(s);
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
export const IMAGE = `media/${sha256(PNG)}.png`;
export const LIMITS = { maxImageBytes: 10 * 1024 * 1024 };

export const settings = (title: string, extra: Json = {}): Json => ({
  title,
  title_source: "heading",
  agent_mode: "review",
  locked: false,
  search_hidden: false,
  agent_instructions: "",
  ...extra,
});

/** A workspace with one of each: a folder, two documents, a database of two tables with views and a row page, an image, comments. */
export function manifest(): Json {
  return {
    format: "stuga-workspace",
    version: 1,
    generator: "stuga test",
    exported_at: "2026-09-25T10:00:00Z",
    workspace: { name: "Privacy laws", agent_instructions: "Answer with citations." },
    start: "Start here.md",
    items: [
      { kind: "doc", path: "Start here.md", parent: null, ...settings("Start here") },
      { kind: "folder", path: "Laws", parent: null, title: "Laws", agent_instructions: "Quote the official text." },
      {
        kind: "doc",
        path: "Laws/GDPR.md",
        parent: "Laws",
        ...settings("Regulation (EU) 2016/679", {
          title_source: "user",
          agent_mode: "auto",
          locked: true,
          search_hidden: true,
          agent_instructions: "Quote articles.",
          comments: [
            { num: 3, parent: null, author_name: "Liv", created_at: "2026-03-01T09:30:00Z", resolved: true, quote: "the start", body: "Link the start?" },
            { num: 5, parent: 3, author_name: "Liv", created_at: "2026-03-02T09:30:00Z", resolved: false, quote: null, body: "Done." },
          ],
        }),
      },
      {
        kind: "database",
        path: "Obligations",
        parent: null,
        ...settings("Obligations", {
          locked: true,
          agent_instructions: "One row per law and topic.",
          comments: [{ num: 1, parent: null, author_name: "Liv", created_at: "2026-03-03T09:30:00Z", resolved: false, quote: null, body: "Check the hours." }],
        }),
        tables: [
          {
            name: "Main",
            file: "Obligations/Main.jsonl",
            columns: [
              { name: "Law", type: "text" },
              { name: "Topic", type: "single_select", choices: ["Breach", "Consent"] },
              { name: "Hours", type: "number", description: "Hours to notify." },
              { name: "Checked", type: "checkbox" },
              { name: "Due", type: "date" },
            ],
            views: [
              {
                name: "Breach",
                kind: "table",
                position: 0,
                filter: { and: [{ column: "Topic", op: "eq", value: "Breach" }, { column: "Checked", op: "eq", value: true }] },
                sorts: [{ column: "Hours", dir: "desc" }],
                group_by: "Law",
                hidden_columns: ["Checked"],
                config: { width: 2 },
              },
              {
                name: "One row",
                kind: "table",
                position: 1,
                filter: { column: "_id", op: "eq", value: "gdpr-breach" },
                sorts: [{ column: "_created_at", dir: "asc" }],
                group_by: null,
                hidden_columns: [],
                config: {},
              },
            ],
            pages: [{ row: "gdpr-breach", file: "Obligations/pages/gdpr-breach.md", ...settings("GDPR breach") }],
          },
          { name: "Sources", file: "Obligations/Sources.jsonl", columns: [{ name: "URL", type: "text" }], views: [], pages: [] },
        ],
      },
    ],
  };
}

export function files(): Record<string, string | Uint8Array> {
  return {
    "Start here.md": [
      "# Start here",
      "",
      "Read [the laws](Laws/) and [GDPR](Laws/GDPR.md), then [the obligations](Obligations), [breaches](Obligations#view=Breach), " +
        "[one row](Obligations#table=Main&row=gdpr-breach) and [its page](Obligations/pages/gdpr-breach.md). " +
        "Ask [@Liv](mention:u_liv) or see [the site](https://example.com/a).",
      "",
      `![Chart](${IMAGE})`,
      "",
    ].join("\n"),
    "Laws/GDPR.md": `# GDPR\n\nBack to [the start](../Start%20here.md).\n\n![Chart](../${IMAGE})\n`,
    "Obligations/Main.jsonl": [
      `{"_id":"gdpr-breach","Law":"GDPR","Topic":"Breach","Hours":72,"Checked":true,"Due":"2026-10-01"}`,
      `{"_id":"pipl-consent","Law":"PIPL","Topic":"Consent","Checked":false}`,
      "",
    ].join("\n"),
    "Obligations/Sources.jsonl": "",
    "Obligations/pages/gdpr-breach.md": "# GDPR breach\n\nNotify within 72 hours.\n",
    [IMAGE]: PNG,
  };
}

/** The archive zipped, after `edit` changes its manifest or files. */
export function build(edit?: (m: Json, f: Record<string, string | Uint8Array>) => void): Uint8Array {
  const m = manifest();
  const f = files();
  edit?.(m, f);
  const all = { [MANIFEST_NAME]: JSON.stringify(m), ...f };
  return zipFiles(Object.entries(all).map(([name, data]) => ({ name, data: typeof data === "string" ? text(data) : data })), "deflate");
}
