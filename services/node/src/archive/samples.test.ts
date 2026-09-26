/** The samples index and archives as the node reads them, and Sample agent's replay of a sample's steps. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({ ...(await orig<typeof import("@stuga/db")>()), getDirectoryRow: vi.fn() }));
vi.mock("../auth/context.js", async (orig) => ({ ...(await orig<typeof import("../auth/context.js")>()), workspaceContextFor: vi.fn() }));
vi.mock("../http/dispatch.js", () => ({ routeWorkspaceRequest: vi.fn() }));

const { getDirectoryRow } = await import("@stuga/db");
const { workspaceContextFor } = await import("../auth/context.js");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
const {
  SAMPLES_INDEX_TTL_MS,
  SAMPLES_RETRY_MS,
  SampleDownloadError,
  createSampleCatalog,
  replaySampleSteps,
  sampleArchiveUrl,
  sampleStepReplay,
  samplesIndexUrl,
} = await import("./samples.js");
import type { AccountCtx, Ctx } from "../auth/context.js";
import { archiveIndex, parseManifest, type SampleStep } from "./format.js";
import type { ImportedIds } from "./import.js";
import type { SampleAgentClient } from "./samples.js";
import { manifest, sha256, text } from "./testing/fixture.js";

const BASE = "https://github.com/stuga-dev/samples/releases";
const ARCHIVE = text("PK a sample archive");

function entry(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Title ${id}`,
    description: `About ${id}`,
    name: `Name ${id}`,
    langs: ["en"],
    file: `${id}.stuga.zip`,
    sha256: sha256(ARCHIVE),
    bytes: ARCHIVE.byteLength,
    archive_version: 1,
    ...extra,
  };
}

const INDEX = {
  format: "stuga-samples",
  version: 1,
  tag: "v2026.09.25",
  samples: [entry("team-handbook"), entry("from-the-future", { archive_version: 2 }), entry("privacy-laws", { langs: ["en", "zh"] })],
};

/** A server holding `files` by URL; each request is recorded. */
function server(files: Record<string, unknown>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = files[url];
    if (body === undefined) return new Response("not found", { status: 404 });
    if (body instanceof Error) throw body;
    return new Response(body instanceof Uint8Array ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body));
  });
  return { calls, fetchFn: fetchFn as unknown as typeof globalThis.fetch };
}

let clock: number;
const now = () => clock;

beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("where the node looks", () => {
  it("builds the index's and each archive's URL itself, from the base, the tag and the id", () => {
    expect(samplesIndexUrl(BASE)).toBe("https://github.com/stuga-dev/samples/releases/latest/download/index.json");
    expect(sampleArchiveUrl(BASE, "v2026.09.25.2", "privacy-laws")).toBe(
      "https://github.com/stuga-dev/samples/releases/download/v2026.09.25.2/privacy-laws.stuga.zip",
    );
    expect(sampleArchiveUrl("http://mirror.lan/samples", "v2026.09.25", "team-handbook")).toBe(
      "http://mirror.lan/samples/download/v2026.09.25/team-handbook.stuga.zip",
    );
  });
});

describe("the samples index", () => {
  it("reads the index and keeps the samples this node can import, in order, sending nothing about itself", async () => {
    const { calls, fetchFn } = server({ [samplesIndexUrl(BASE)]: INDEX });
    const index = await createSampleCatalog(BASE, { fetch: fetchFn, now }).index();
    expect(index?.tag).toBe("v2026.09.25");
    expect(index?.samples.map((s) => s.id)).toEqual(["team-handbook", "privacy-laws"]);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]!.init?.headers)).toEqual(new Headers({ accept: "application/json", "user-agent": "stuga-node" }));
    expect(calls[0]!.init?.body).toBeUndefined();
  });

  it("leaves out, and logs, a sample written for a newer node's rules, and keeps the rest", async () => {
    const newer = { ...INDEX, samples: [entry("team-handbook", { description: "x".repeat(80) }), entry("privacy-laws", { langs: ["pt-br"] }), entry("research")] };
    const { fetchFn } = server({ [samplesIndexUrl(BASE)]: newer });
    const catalog = createSampleCatalog(BASE, { fetch: fetchFn, now });
    expect((await catalog.index())?.samples.map((s) => s.id)).toEqual(["research"]);
    expect(catalog.lastLookFailed()).toBe(false);
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ["left a sample out of the samples index", { reason: `${samplesIndexUrl(BASE)}: samples[0].description: is longer than 60 characters` }],
      ["left a sample out of the samples index", { reason: `${samplesIndexUrl(BASE)}: samples[1].langs[0]: must be a primary language tag such as en or zh` }],
    ]);
  });

  it("answers from memory for an hour, then looks again", async () => {
    const { calls, fetchFn } = server({ [samplesIndexUrl(BASE)]: INDEX });
    const catalog = createSampleCatalog(BASE, { fetch: fetchFn, now });
    await catalog.index();
    clock += SAMPLES_INDEX_TTL_MS - 1;
    await catalog.index();
    expect(calls).toHaveLength(1);
    clock += 1;
    await catalog.index();
    expect(calls).toHaveLength(2);
  });

  it("has callers that ask at once share one look", async () => {
    const { calls, fetchFn } = server({ [samplesIndexUrl(BASE)]: INDEX });
    const catalog = createSampleCatalog(BASE, { fetch: fetchFn, now });
    const [a, b, c] = await Promise.all([catalog.index(), catalog.index(), catalog.index()]);
    expect(calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("keeps the copy it has when a later look fails, and waits a minute before the next", async () => {
    const files: Record<string, unknown> = { [samplesIndexUrl(BASE)]: INDEX };
    const { calls, fetchFn } = server(files);
    const catalog = createSampleCatalog(BASE, { fetch: fetchFn, now });
    const first = await catalog.index();
    expect(catalog.lastLookFailed()).toBe(false);

    files[samplesIndexUrl(BASE)] = new TypeError("fetch failed");
    clock += SAMPLES_INDEX_TTL_MS;
    expect(await catalog.index()).toBe(first);
    expect(catalog.lastLookFailed()).toBe(true);
    clock += SAMPLES_RETRY_MS - 1;
    expect(await catalog.index()).toBe(first);
    expect(calls).toHaveLength(2);

    files[samplesIndexUrl(BASE)] = { ...INDEX, tag: "v2026.10.01" };
    clock += 1;
    expect((await catalog.index())?.tag).toBe("v2026.10.01");
    expect(catalog.lastLookFailed()).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it.each([
    ["the server cannot be reached", new TypeError("fetch failed")],
    ["the server answers 404", undefined],
    ["it is not JSON", text("<html>")],
    ["it is no samples index", { ...INDEX, format: "stuga-workspace" }],
    ["it names a tag that is no day", { ...INDEX, tag: "v2026.02.31" }],
    ["its samples are no list", { ...INDEX, samples: { "team-handbook": entry("team-handbook") } }],
    ["it is past the index's byte cap", { ...INDEX, padding: "x".repeat(256 * 1024) }],
  ])("has no samples to offer when %s and there is no copy", async (_case, body) => {
    const { fetchFn } = server(body === undefined ? {} : { [samplesIndexUrl(BASE)]: body });
    expect(await createSampleCatalog(BASE, { fetch: fetchFn, now }).index()).toBeNull();
  });
});

describe("a sample's archive", () => {
  async function catalogWith(archive: Uint8Array | Error | undefined, listed = entry("privacy-laws")) {
    const url = sampleArchiveUrl(BASE, INDEX.tag, "privacy-laws");
    const { calls, fetchFn } = server({ [samplesIndexUrl(BASE)]: { ...INDEX, samples: [listed] }, ...(archive ? { [url]: archive } : {}) });
    const catalog = createSampleCatalog(BASE, { fetch: fetchFn, now });
    const index = (await catalog.index())!;
    return { calls, url, download: () => catalog.download(index, index.samples[0]!) };
  }

  it("is downloaded from the index's release and checked against its size and SHA-256", async () => {
    const { calls, url, download } = await catalogWith(ARCHIVE);
    expect(await download()).toEqual(ARCHIVE);
    expect(calls.at(-1)!.url).toBe(url);
  });

  it.each([
    ["shorter than listed", text("PK short"), /bytes, not the/],
    ["longer than listed", text("PK a sample archive, and more"), /more than/],
    ["other bytes of the listed size", text("PK a sample archivE"), /SHA-256/],
    ["missing", undefined, /answered 404/],
    ["out of reach", new TypeError("fetch failed"), /could not reach/],
  ])("is refused when %s", async (_case, archive, reason) => {
    const { download } = await catalogWith(archive);
    const failure = download();
    await expect(failure).rejects.toBeInstanceOf(SampleDownloadError);
    await expect(failure).rejects.toThrow(reason);
  });
});

// ---- Sample agent ------------------------------------------------------------------------------

const index = archiveIndex(parseManifest(manifest()));

const ids: ImportedIds = {
  folders: new Map([["Laws", "f_laws"]]),
  docs: new Map([
    ["Start here.md", "d_start"],
    ["Laws/GDPR.md", "d_gdpr"],
    ["Obligations/pages/gdpr-breach.md", "d_page"],
  ]),
  databases: new Map([
    [
      "Obligations",
      {
        docId: "d_db",
        tables: new Map([
          [
            "Main",
            {
              tableId: "tbl_main",
              columns: new Map([
                ["Law", "col_law"],
                ["Topic", "col_topic"],
                ["Hours", "col_hours"],
                ["Checked", "col_checked"],
                ["Due", "col_due"],
              ]),
              views: new Map(),
              rows: new Map([
                ["gdpr-breach", "row_1"],
                ["pipl-consent", "row_2"],
              ]),
            },
          ],
        ]),
      },
    ],
  ]),
};

const EDIT: SampleStep = {
  kind: "edit",
  doc: "Laws/GDPR.md",
  edits: [
    { old_string: "Back to", new_string: "Return to[^1]" },
    // Only there once the edit before it lands.
    { old_string: "Return to[^1] [the start]", new_string: "Return to[^1] [the start page]" },
  ],
  citations: [{ n: 1, doc: "Obligations/pages/gdpr-breach.md", heading_path: "GDPR breach", content: "Notify within 72 hours." }],
};
const ROW: SampleStep = { kind: "row", database: "Obligations", table: "Main", row: "pipl-consent", values: { Hours: 48, Checked: true, Due: null } };
const COMMENT: SampleStep = { kind: "comment", doc: "Start here.md", body: "{{me}}, I proposed a change. Ask {{me}} again.", quote: "Read" };

function fakeClient(body = "# GDPR\n\nBack to [the start](/doc/d_start).\n") {
  const calls: unknown[][] = [];
  const client: SampleAgentClient & { modes: { edit: string; row: string } } = {
    modes: { edit: "proposed", row: "proposed" },
    markdown: vi.fn(async (docId: string) => (calls.push(["markdown", docId]), body)),
    proposeEdits: vi.fn(async (...args: unknown[]) => (calls.push(["edit", ...args]), client.modes.edit)),
    proposeRowUpdate: vi.fn(async (...args: unknown[]) => (calls.push(["row", ...args]), client.modes.row)),
    comment: vi.fn(async (...args: unknown[]) => void calls.push(["comment", ...args])),
  };
  return { client, calls };
}

describe("Sample agent's replay", () => {
  it("proposes each step where the import put what it names, in order", async () => {
    const { client, calls } = fakeClient();
    await replaySampleSteps(client, [EDIT, ROW, COMMENT], { ids, index, me: "liv" });
    expect(calls).toEqual([
      ["markdown", "d_gdpr"],
      [
        "edit",
        "d_gdpr",
        EDIT.kind === "edit" && EDIT.edits,
        [{ n: 1, doc_id: "d_page", title: "GDPR breach", heading_path: "GDPR breach", content: "Notify within 72 hours." }],
      ],
      ["row", "d_db", "tbl_main", "row_2", { col_hours: 48, col_checked: 1, col_due: null }],
      ["comment", "d_start", "@liv, I proposed a change. Ask @liv again.", "Read"],
    ]);
  });

  it("gives a citation with no heading none, and a comment with no quote no anchor", async () => {
    const { client, calls } = fakeClient();
    const edit: SampleStep = {
      kind: "edit",
      doc: "Laws/GDPR.md",
      edits: [{ old_string: "Back", new_string: "Go back" }],
      citations: [{ n: 1, doc: "Start here.md", content: "Read" }],
    };
    await replaySampleSteps(client, [edit, { kind: "comment", doc: "Laws/GDPR.md", body: "Plain." }], { ids, index, me: "liv" });
    expect(calls[1]![3]).toEqual([{ n: 1, doc_id: "d_start", title: "Start here", heading_path: null, content: "Read" }]);
    expect(calls[2]).toEqual(["comment", "d_gdpr", "Plain.", null]);
  });

  it.each([
    ["nowhere", "Forward to", /nowhere/],
    ["more than once", "t", /more than once/],
  ])("fails, proposing nothing, when an old_string occurs %s in the body", async (_case, old_string, reason) => {
    const { client } = fakeClient();
    const step: SampleStep = { kind: "edit", doc: "Laws/GDPR.md", edits: [{ old_string, new_string: "x" }] };
    await expect(replaySampleSteps(client, [step], { ids, index, me: "liv" })).rejects.toThrow(reason);
    expect(client.proposeEdits).not.toHaveBeenCalled();
  });

  it("fails when a proposal changes nothing or does not wait for review", async () => {
    const { client } = fakeClient();
    client.modes.edit = "noop";
    await expect(replaySampleSteps(client, [EDIT], { ids, index, me: "liv" })).rejects.toThrow("step 1: the edit to Laws/GDPR.md was noop, not proposed");
    client.modes.edit = "auto_applied";
    await expect(replaySampleSteps(client, [EDIT], { ids, index, me: "liv" })).rejects.toThrow(/auto_applied, not proposed/);
    client.modes.row = "applied";
    await expect(replaySampleSteps(client, [COMMENT, ROW], { ids, index, me: "liv" })).rejects.toThrow(
      'step 2: the change to row "pipl-consent" of Obligations was applied, not proposed',
    );
  });

  it("stops at the first write the node refuses", async () => {
    const { client } = fakeClient();
    vi.mocked(client.proposeRowUpdate).mockRejectedValue(new Error("PATCH …/rows: view-only access"));
    await expect(replaySampleSteps(client, [ROW, COMMENT], { ids, index, me: "liv" })).rejects.toThrow("view-only access");
    expect(client.comment).not.toHaveBeenCalled();
  });
});

describe("the import's sample-steps hook", () => {
  const importer = { sql: {}, env: {}, surface: "web", alias: "u_liv", displayName: "Liv", isAgent: false, requestId: "req-1" } as unknown as AccountCtx;
  const agentCtx = { alias: "agent-sample", workspaceId: "ws-new", isAgent: true } as unknown as Ctx;
  let requests: Array<{ method: string; path: string; body: unknown }>;

  beforeEach(() => {
    requests = [];
    vi.mocked(getDirectoryRow).mockResolvedValue({ display_name: "Liv", username: "liv", email: null });
    vi.mocked(workspaceContextFor).mockResolvedValue(agentCtx);
    vi.mocked(routeWorkspaceRequest).mockImplementation(async (ctx, req) => {
      expect(ctx).toBe(agentCtx);
      const url = new URL(req.url);
      requests.push({ method: req.method, path: url.pathname, body: req.method === "GET" ? undefined : await req.json() });
      if (url.pathname.endsWith("/markdown")) return Response.json({ markdown: "# GDPR\n\nBack to [the start](/doc/d_start).\n" });
      if (url.pathname.endsWith("/comments")) return Response.json({ num: 1 }, { status: 201 });
      return Response.json({ mode: "proposed" });
    });
  });

  it("acts as Sample agent, an agent with no key acting for the importer, through the routes an agent calls", async () => {
    await sampleStepReplay(importer, "ws-new", index)([EDIT, ROW, COMMENT], ids);
    const account = { alias: "agent-sample", displayName: "Sample agent", isAgent: true, onBehalfOf: "u_liv" };
    const request = { sql: importer.sql, env: importer.env, surface: "web", requestId: "req-1" };
    expect(workspaceContextFor).toHaveBeenCalledWith({ account: { ...account, ...request }, workspaces: null, readOnly: false }, "ws-new");
    expect(requests).toEqual([
      { method: "GET", path: "/api/docs/d_gdpr/markdown", body: undefined },
      {
        method: "POST",
        path: "/api/docs/d_gdpr/propose",
        body: { action: "cited_edits", edits: expect.any(Array), citations: [expect.objectContaining({ doc_id: "d_page" })] },
      },
      {
        method: "PATCH",
        path: "/api/databases/d_db/tables/tbl_main/rows",
        body: { updates: [{ _id: "row_2", values: { col_hours: 48, col_checked: 1, col_due: null } }] },
      },
      { method: "POST", path: "/api/docs/d_start/comments", body: { body: "@liv, I proposed a change. Ask @liv again.", anchor_quote: "Read" } },
    ]);
  });

  it("waits out the database actor's per-minute budget, as the import's writes do, and tries the step again", async () => {
    let refused = false;
    vi.mocked(routeWorkspaceRequest).mockImplementation(async (_ctx, req) => {
      requests.push({ method: req.method, path: new URL(req.url).pathname, body: await req.json() });
      if (refused) return Response.json({ mode: "proposed" });
      refused = true;
      return Response.json({ error: "too many mutations (max 120/min per actor)" }, { status: 429 });
    });
    const waits: number[] = [];
    await sampleStepReplay(importer, "ws-new", index, { sleep: async (ms) => void waits.push(ms) })([ROW], ids);
    expect(waits).toEqual([61_000]);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "PATCH /api/databases/d_db/tables/tbl_main/rows",
      "PATCH /api/databases/d_db/tables/tbl_main/rows",
    ]);
  });

  it("fails with what the route said when it refuses a write", async () => {
    vi.mocked(routeWorkspaceRequest).mockResolvedValue(Response.json({ error: "document d_gdpr is locked; unlock it to make changes" }, { status: 423 }));
    await expect(sampleStepReplay(importer, "ws-new", index)([COMMENT], ids)).rejects.toThrow(
      "POST /api/docs/d_start/comments: document d_gdpr is locked; unlock it to make changes",
    );
  });

  it("fails when Sample agent cannot act in the workspace", async () => {
    vi.mocked(workspaceContextFor).mockResolvedValue(null);
    await expect(sampleStepReplay(importer, "ws-new", index)([COMMENT], ids)).rejects.toThrow("Sample agent cannot act in the new workspace");
    expect(routeWorkspaceRequest).not.toHaveBeenCalled();
  });
});
