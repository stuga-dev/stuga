import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocRow } from "@stuga/db";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";

// A remote fetch vets the addresses a host resolves to, so the fictional hosts need a public answer.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("@stuga/db", () => ({
  getDoc: vi.fn(),
  getFolderAncestors: vi.fn(async () => []),
  getWorkspace: vi.fn(async () => null),
}));

const { getDoc } = await import("@stuga/db");
const {
  proposeBody,
  proposeDocEdit,
  readDocMarkdownWithProjection,
  readDocRuns,
  LEDGER_UNAVAILABLE_MESSAGE,
  NOOP_MESSAGE,
  STALE_MESSAGE,
  parseCitedEdits,
} = await import("./edits.js");
import type { Ctx } from "../auth/context.js";
import { DEFAULT_MAX_BODY_BYTES } from "../media/media.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;

const DOC = {
  doc_id: "d1",
  workspace_id: "ws1",
  owner: "user:human-1",
  title: "Roadmap",
  doc_type: "prose",
  trashed: false,
  locked: false,
  acl_principals: ["agent:agent-1", "user:human-1"],
  acl_writers: ["agent:agent-1", "user:human-1"],
};

const RUN: AgentRunSummary = {
  id: "run_0123456789ab",
  doc_id: "d1",
  source: "connector",
  agent: "Scout (Connector)",
  agent_alias: "agent-1",
  reviewer: "human-1",
  status: "open",
  hunks: [{ id: "h1", old_string: "a", new_string: "b", status: "pending", review: "review" }],
  acknowledged: false,
  auto_applied: false,
  review_mode: "review",
  created_at: 1,
  updated_at: 2,
};

/** An actor fetcher that records every request's URL and body. */
function fakeActor(respond: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return respond(url, init);
  });
  return { calls, fetch };
}

function makeCtx(fetcher: ReturnType<typeof fakeActor>["fetch"], overrides: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "agent-1",
    displayName: "Scout (Connector)",
    isAgent: true,
    onBehalfOf: "human-1",
    principals: ["agent:agent-1"],
    workspaceId: "ws1",
    role: "member",
    env: {
      docs: { get: () => ({ fetch: fetcher }) },
    },
    ...overrides,
  } as unknown as Ctx;
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  mockGetDoc.mockReset();
  mockGetDoc.mockResolvedValue({ ...DOC });
});

describe("proposeDocEdit gates", () => {
  const unusedActor = () => jsonRes({ mode: "noop" });

  it.each([
    ["missing", null, `document d1 not found`, 404],
    ["trashed", { ...DOC, trashed: true }, `document d1 not found`, 404],
    ["another workspace", { ...DOC, workspace_id: "ws2" }, `document d1 not found`, 404],
    ["view-only", { ...DOC, acl_writers: ["user:human-1"] }, `no write access to d1`, 403],
    ["locked", { ...DOC, locked: true }, `document d1 is locked; unlock it to make changes`, 423],
  ])("refuses a %s document", async (_label, doc, message, status) => {
    mockGetDoc.mockResolvedValue(doc);
    const actor = fakeActor(unusedActor);
    const out = await proposeDocEdit(makeCtx(actor.fetch), {
      docId: "d1",
      action: "write",
      text: "hi",
      source: "connector",
    });
    expect(out).toEqual({ kind: "error", message, status });
    expect(actor.fetch).not.toHaveBeenCalled();
  });

  it("requires text for write and a non-empty find for str_replace", async () => {
    const actor = fakeActor(unusedActor);
    const ctx = makeCtx(actor.fetch);
    await expect(proposeDocEdit(ctx, { docId: "d1", action: "write", source: "stdio" })).resolves.toMatchObject({
      kind: "error",
      message: "write requires `text`",
    });
    await expect(
      proposeDocEdit(ctx, { docId: "d1", action: "str_replace", find: "", replace: "x", source: "stdio" }),
    ).resolves.toMatchObject({ kind: "error", message: "str_replace requires a non-empty `find`" });
    expect(actor.fetch).not.toHaveBeenCalled();
  });

  it("enforces the size cap in UTF-8 bytes, not characters", async () => {
    const actor = fakeActor(unusedActor);
    const huge = "€".repeat(1_500_000);
    const out = await proposeDocEdit(makeCtx(actor.fetch), {
      docId: "d1",
      action: "write",
      text: huge,
      source: "connector",
    });
    expect(out).toMatchObject({ kind: "error", status: 413 });
    expect(actor.fetch).not.toHaveBeenCalled();
  });
});

describe("proposeDocEdit outcome mapping", () => {
  it("maps a parked proposal and sends the run identity the actor needs", async () => {
    const actor = fakeActor(() => jsonRes({ mode: "proposed", run: RUN, pending: 2 }));
    const out = await proposeDocEdit(makeCtx(actor.fetch), {
      docId: "d1",
      action: "str_replace",
      find: "old",
      replace: "new",
      replaceAll: true,
      source: "connector",
    });
    expect(out).toMatchObject({
      kind: "proposed",
      run: RUN,
      pending: 2,
      review: "review",
      reason: "this document waits for review",
    });
    expect(actor.calls[0]!.url).toBe("http://actor/runs/propose?docId=d1");
    expect(actor.calls[0]!.body).toEqual({
      action: "str_replace",
      heading: null,
      find: "old",
      replace: "new",
      replace_all: true,
      source: "connector",
      review: "review",
      agent: "Scout (Connector)",
      agent_alias: "agent-1",
      client: null,
      model: null,
      reviewer: "human-1",
      workspace_id: "ws1",
      doc_title: "Roadmap",
    });
  });

  it("maps an auto-apply, defaulting a missing seq", async () => {
    const applied = { ...RUN, status: "open" as const, auto_applied: true };
    const withSeq = fakeActor(() => jsonRes({ mode: "auto_applied", run: applied, seq: 42 }));
    await expect(
      proposeDocEdit(makeCtx(withSeq.fetch), { docId: "d1", action: "write", text: "hi", source: "stdio" }),
    ).resolves.toMatchObject({ kind: "auto_applied", run: applied, seq: 42, review: "review" });

    const noSeq = fakeActor(() => jsonRes({ mode: "auto_applied", run: applied }));
    await expect(
      proposeDocEdit(makeCtx(noSeq.fetch), { docId: "d1", action: "write", text: "hi", source: "stdio" }),
    ).resolves.toMatchObject({ kind: "auto_applied", run: applied, seq: 0, review: "review" });
  });

  it("maps a no-op", async () => {
    const actor = fakeActor(() => jsonRes({ mode: "noop" }));
    await expect(
      proposeDocEdit(makeCtx(actor.fetch), { docId: "d1", action: "write", text: "hi", source: "stdio" }),
    ).resolves.toEqual({ kind: "noop" });
    expect(NOOP_MESSAGE).toContain("no changes");
  });

  it("maps the three 409s: stale (retryable), not_found, ambiguous", async () => {
    const stale = fakeActor(() => jsonRes({ error: "stale", message: "document changed; re-read and retry" }, 409));
    await expect(
      proposeDocEdit(makeCtx(stale.fetch), { docId: "d1", action: "write", text: "hi", source: "stdio" }),
    ).resolves.toEqual({ kind: "error", message: STALE_MESSAGE, retryable: true, status: 409 });

    const notFound = fakeActor(() => jsonRes({ error: "not_found" }, 409));
    await expect(
      proposeDocEdit(makeCtx(notFound.fetch), { docId: "d1", action: "str_replace", find: "x", source: "stdio" }),
    ).resolves.toEqual({ kind: "error", message: "`find` not found in the document", status: 409 });

    const ambiguous = fakeActor(() => jsonRes({ error: "ambiguous", count: 3 }, 409));
    await expect(
      proposeDocEdit(makeCtx(ambiguous.fetch), { docId: "d1", action: "str_replace", find: "x", source: "stdio" }),
    ).resolves.toEqual({
      kind: "error",
      message: "`find` matches 3 times — set replace_all:true or make it unique",
      status: 409,
    });
  });

  it("passes the actor's late lock and ledger refusals through instead of flattening them to 502", async () => {
    const locked = fakeActor(() => jsonRes({ error: "locked" }, 423));
    await expect(
      proposeDocEdit(makeCtx(locked.fetch), { docId: "d1", action: "write", text: "hi", source: "stdio" }),
    ).resolves.toEqual({
      kind: "error",
      message: "document d1 is locked; unlock it to make changes",
      status: 423,
    });

    const unavailable = fakeActor(() => jsonRes({ error: "run_unavailable" }, 503));
    await expect(
      proposeDocEdit(makeCtx(unavailable.fetch), { docId: "d1", action: "write", text: "hi", source: "stdio" }),
    ).resolves.toEqual({ kind: "error", message: LEDGER_UNAVAILABLE_MESSAGE, status: 503 });
  });

  it("never reports success for an unusable actor response", async () => {
    const broken = fakeActor(() => new Response("nope", { status: 200 }));
    await expect(
      proposeDocEdit(makeCtx(broken.fetch), { docId: "d1", action: "write", text: "hi", source: "stdio" }),
    ).resolves.toMatchObject({ kind: "error", status: 502 });

    const down = fakeActor(() => new Response("boom", { status: 500 }));
    await expect(
      proposeDocEdit(makeCtx(down.fetch), { docId: "d1", action: "write", text: "hi", source: "stdio" }),
    ).resolves.toEqual({ kind: "error", message: "propose failed (500)", status: 502 });
  });
});

describe("readDocMarkdownWithProjection", () => {
  it("projects an agent's pending hunks and reports the run", async () => {
    const actor = fakeActor(() => jsonRes({ markdown: "# projected", run_id: RUN.id, pending: 2 }));
    await expect(readDocMarkdownWithProjection(makeCtx(actor.fetch), "d1")).resolves.toEqual({
      markdown: "# projected",
      doc: DOC,
      runId: RUN.id,
      pending: 2,
    });
    expect(actor.calls[0]!.url).toBe("http://actor/markdown?docId=d1&agent=agent-1");
  });

  it("gives a human the real document, with no agent param", async () => {
    const actor = fakeActor(() => jsonRes({ markdown: "# live" }));
    const ctx = makeCtx(actor.fetch, { isAgent: false, alias: "human-1", principals: ["user:human-1"] });
    await expect(readDocMarkdownWithProjection(ctx, "d1")).resolves.toEqual({ markdown: "# live", doc: DOC });
    expect(actor.calls[0]!.url).toBe("http://actor/markdown?docId=d1");
  });

  it("returns null when the doc is out of reach", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, acl_principals: ["user:someone-else"] });
    const actor = fakeActor(() => jsonRes({ markdown: "secret" }));
    await expect(readDocMarkdownWithProjection(makeCtx(actor.fetch), "d1")).resolves.toBeNull();
    expect(actor.fetch).not.toHaveBeenCalled();
  });
});

describe("readDocRuns", () => {
  it("returns the ledger, or an empty list when the actor has none", async () => {
    const withRuns = fakeActor(() => jsonRes({ runs: [RUN] }));
    await expect(readDocRuns(makeCtx(withRuns.fetch), "d1")).resolves.toEqual([RUN]);
    expect(withRuns.calls[0]!.url).toBe("http://actor/runs?docId=d1");

    const empty = fakeActor(() => jsonRes({}));
    await expect(readDocRuns(makeCtx(empty.fetch), "d1")).resolves.toEqual([]);
  });

  it("returns null without access", async () => {
    mockGetDoc.mockResolvedValue(null);
    const actor = fakeActor(() => jsonRes({ runs: [] }));
    await expect(readDocRuns(makeCtx(actor.fetch), "d1")).resolves.toBeNull();
  });
});

describe("proposeDocEdit with cited_edits", () => {
  const panelCtx = (fetcher: ReturnType<typeof fakeActor>["fetch"]) =>
    makeCtx(fetcher, {
      alias: "panel:human-1",
      displayName: "AI co-author",
      isAgent: true,
      onBehalfOf: "human-1",
      principals: ["user:human-1"],
    });

  it("forwards the panel identity and reviewer to the actor", async () => {
    const actor = fakeActor(() => jsonRes({ mode: "proposed", run: { ...RUN, source: "panel" }, pending: 2 }));
    const out = await proposeDocEdit(panelCtx(actor.fetch), {
      docId: "d1",
      action: "cited_edits",
      edits: [{ old_string: "a", new_string: "b" }],
      citations: [{ n: 1, doc_id: "src", title: "Source", content: "" }],
      source: "panel",
    });
    expect(out).toMatchObject({ kind: "proposed", pending: 2 });
    expect(actor.calls[0]!.body).toMatchObject({
      action: "cited_edits",
      source: "panel",
      agent: "AI co-author",
      agent_alias: "panel:human-1",
      reviewer: "human-1",
      edits: [{ old_string: "a", new_string: "b" }],
      citations: [{ n: 1, doc_id: "src", title: "Source", content: "" }],
    });
  });

  it("requires a non-empty edit list", async () => {
    const actor = fakeActor(() => jsonRes({ mode: "noop" }));
    await expect(
      proposeDocEdit(panelCtx(actor.fetch), { docId: "d1", action: "cited_edits", edits: [], source: "panel" }),
    ).resolves.toMatchObject({ kind: "error", message: "cited_edits requires `edits`" });
    expect(actor.fetch).not.toHaveBeenCalled();
  });

  it("still runs the whole gate stack", async () => {
    const actor = fakeActor(() => jsonRes({ mode: "noop" }));
    mockGetDoc.mockResolvedValue({ ...DOC, locked: true });
    await expect(
      proposeDocEdit(panelCtx(actor.fetch), {
        docId: "d1",
        action: "cited_edits",
        edits: [{ old_string: "a", new_string: "b" }],
        source: "panel",
      }),
    ).resolves.toMatchObject({ kind: "error", status: 423 });
    expect(actor.fetch).not.toHaveBeenCalled();
  });

  it("maps the actor's result-size refusal onto the size error", async () => {
    const actor = fakeActor(() => jsonRes({ error: "too_large" }, 413));
    await expect(
      proposeDocEdit(panelCtx(actor.fetch), {
        docId: "d1",
        action: "cited_edits",
        edits: [{ old_string: "a", new_string: "b" }],
        source: "panel",
      }),
    ).resolves.toMatchObject({ kind: "error", status: 413 });
  });
});

describe("proposeDocEdit hosts the agent's images", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const puts: string[] = [];

  function mediaCtx(fetcher: ReturnType<typeof fakeActor>["fetch"]): Ctx {
    return makeCtx(fetcher, {
      env: {
        docs: { get: () => ({ fetch: fetcher }) },
        publicOrigin: "https://stuga.example.test",
        settings: { current: () => ({ maxBodyBytes: DEFAULT_MAX_BODY_BYTES }) },
        media: {
          head: async () => null,
          put: async (k: string) => {
            puts.push(k);
          },
        },
      },
    } as unknown as Partial<Ctx>);
  }

  beforeEach(() => {
    puts.length = 0;
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(PNG, { status: 200 }));
  });

  it("rewrites a write body before the actor ever sees it", async () => {
    const actor = fakeActor(() => jsonRes({ mode: "proposed", run: RUN, pending: 1 }));
    const out = await proposeDocEdit(mediaCtx(actor.fetch), {
      docId: "d1",
      action: "write",
      text: "# Report\n\n![chart](https://cdn.example.com/c.png)\n",
      source: "connector",
    });
    const body = actor.calls[0]!.body as { text: string };
    expect(body.text).toMatch(/!\[chart\]\(\/api\/docs\/d1\/media\/[0-9a-f]{64}\)/);
    expect(body.text).not.toContain("cdn.example.com");
    expect(puts).toHaveLength(1);
    expect(out).toMatchObject({ kind: "proposed" });
    expect((out as { mediaNote?: string }).mediaNote).toMatch(/Hosted 1 image/);
  });

  it("rewrites a str_replace replacement but never the `find`", async () => {
    const actor = fakeActor(() => jsonRes({ mode: "auto_applied", run: RUN, seq: 7 }));
    await proposeDocEdit(mediaCtx(actor.fetch), {
      docId: "d1",
      action: "str_replace",
      find: "![old](https://cdn.example.com/old.png)",
      replace: "![new](https://cdn.example.com/new.png)",
      source: "connector",
    });
    const body = actor.calls[0]!.body as { find: string; replace: string };
    // `find` must match the live document byte for byte.
    expect(body.find).toBe("![old](https://cdn.example.com/old.png)");
    expect(body.replace).toMatch(/^!\[new\]\(\/api\/docs\/d1\/media\/[0-9a-f]{64}\)$/);
  });

  it("rewrites each cited edit's new_string", async () => {
    const actor = fakeActor(() => jsonRes({ mode: "proposed", run: RUN, pending: 1 }));
    await proposeDocEdit(mediaCtx(actor.fetch), {
      docId: "d1",
      action: "cited_edits",
      edits: [{ old_string: "anchor", new_string: "anchor\n\n![x](https://cdn.example.com/x.png)" }],
      citations: [],
      source: "panel",
    });
    const body = actor.calls[0]!.body as { edits: Array<{ new_string: string }> };
    expect(body.edits[0]!.new_string).toMatch(/\/api\/docs\/d1\/media\/[0-9a-f]{64}/);
  });

  it("accepts a data: URI that would otherwise be dropped, and beats the size gate", async () => {
    const actor = fakeActor(() => jsonRes({ mode: "proposed", run: RUN, pending: 1 }));
    const bytes = new Uint8Array(450_000);
    bytes.set(PNG.subarray(0, 8));
    let raw = "";
    for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const huge = btoa(raw);
    const out = await proposeDocEdit(mediaCtx(actor.fetch), {
      docId: "d1",
      action: "write",
      text: `![x](data:image/png;base64,${huge})`,
      source: "connector",
    });
    expect(out.kind).toBe("proposed");
    expect((actor.calls[0]!.body as { text: string }).text).toMatch(/^!\[x\]\(\/api\/docs\/d1\/media\/[0-9a-f]{64}\)$/);
  });

  it("does not fail the edit when the image cannot be downloaded", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("gone", { status: 404 }));
    const actor = fakeActor(() => jsonRes({ mode: "proposed", run: RUN, pending: 1 }));
    const out = await proposeDocEdit(mediaCtx(actor.fetch), {
      docId: "d1",
      action: "write",
      text: "![x](https://cdn.example.com/gone.png)",
      source: "connector",
    });
    expect(out.kind).toBe("proposed");
    expect((actor.calls[0]!.body as { text: string }).text).toContain("https://cdn.example.com/gone.png");
    expect((out as { mediaNote?: string }).mediaNote).toMatch(/Couldn’t download/);
  });

  it("never fetches for a caller the gates already refused", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockGetDoc.mockResolvedValue({ ...DOC, acl_writers: ["user:human-1"] });
    const actor = fakeActor(() => jsonRes({ mode: "noop" }));
    const out = await proposeDocEdit(mediaCtx(actor.fetch), {
      docId: "d1",
      action: "write",
      text: "![x](https://cdn.example.com/x.png)",
      source: "connector",
    });
    expect(out).toMatchObject({ kind: "error", status: 403 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("proposeDocEdit writes the audit ledger", () => {
  const jobsSend = vi.fn(async (_msg: Record<string, unknown>) => {});
  const ctxWithJobs = (fetcher: ReturnType<typeof fakeActor>["fetch"], surface: Ctx["surface"]) =>
    makeCtx(fetcher, {
      surface,
      env: { docs: { get: () => ({ fetch: fetcher }) }, jobs: { send: jobsSend } },
    } as unknown as Partial<Ctx>);

  beforeEach(() => jobsSend.mockClear());

  it("records a proposed edit with the agent's identity and the run id", async () => {
    const actor = fakeActor(() => jsonRes({ mode: "proposed", run: RUN, pending: 2 }));
    await proposeDocEdit(ctxWithJobs(actor.fetch, "mcp"), {
      docId: "d1",
      action: "str_replace",
      find: "a",
      replace: "b",
      source: "connector",
    });
    expect(jobsSend).toHaveBeenCalledTimes(1);
    expect(jobsSend.mock.calls[0]![0]).toMatchObject({
      kind: "audit",
      workspaceId: "ws1",
      actor: "agent-1",
      actorKind: "agent",
      onBehalfOf: "human-1",
      source: "mcp",
      action: "doc.propose",
      targetKind: "doc",
      targetId: "d1",
      detail: { run_id: RUN.id, mode: "proposed" },
    });
  });

  it("records an auto-applied edit too", async () => {
    const actor = fakeActor(() => jsonRes({ mode: "auto_applied", run: RUN, seq: 7 }));
    await proposeDocEdit(ctxWithJobs(actor.fetch, "api-key"), {
      docId: "d1",
      action: "write",
      text: "hello",
      source: "stdio",
    });
    expect(jobsSend).toHaveBeenCalledTimes(1);
    expect(jobsSend.mock.calls[0]![0]).toMatchObject({
      kind: "audit",
      source: "api-key",
      detail: { mode: "auto_applied", seq: 7 },
    });
  });

  it("records nothing for a refused proposal", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, locked: true });
    const actor = fakeActor(() => jsonRes({ mode: "noop" }));
    await proposeDocEdit(ctxWithJobs(actor.fetch, "mcp"), { docId: "d1", action: "write", text: "x", source: "connector" });
    expect(jobsSend).not.toHaveBeenCalled();
  });

  it("never fails the propose when the queue is down", async () => {
    jobsSend.mockRejectedValueOnce(new Error("queue down"));
    const actor = fakeActor(() => jsonRes({ mode: "proposed", run: RUN, pending: 1 }));
    const out = await proposeDocEdit(ctxWithJobs(actor.fetch, "mcp"), {
      docId: "d1",
      action: "write",
      text: "x",
      source: "connector",
    });
    expect(out.kind).toBe("proposed");
  });
});

describe("cited_edits and run labels", () => {
  const proposed = () => jsonRes({ mode: "proposed", run: RUN, pending: 1 });

  it("forwards the agent's client and model labels to the actor, null when it sent none", async () => {
    const actor = fakeActor(proposed);
    await proposeDocEdit(makeCtx(actor.fetch, { client: "deepseek-harness", model: "deepseek-v4-flash" }), {
      docId: "d1",
      action: "write",
      text: "hi",
      source: "stdio",
    });
    expect(actor.calls[0]!.body).toMatchObject({ client: "deepseek-harness", model: "deepseek-v4-flash" });

    const bare = fakeActor(proposed);
    await proposeDocEdit(makeCtx(bare.fetch), { docId: "d1", action: "write", text: "hi", source: "stdio" });
    expect(bare.calls[0]!.body).toMatchObject({ client: null, model: null });
  });

  it("sends cited_edits through with its edits and citations", async () => {
    const actor = fakeActor(proposed);
    const out = await proposeDocEdit(makeCtx(actor.fetch), {
      docId: "d1",
      action: "cited_edits",
      edits: [{ old_string: "old", new_string: "new [^1]" }],
      citations: [{ n: 1, doc_id: "d9", title: "Source", heading_path: null, content: "the passage" }],
      source: "stdio",
    });
    expect(out).toMatchObject({ kind: "proposed", pending: 1 });
    expect(actor.calls[0]!.body).toMatchObject({
      action: "cited_edits",
      edits: [{ old_string: "old", new_string: "new [^1]" }],
      citations: [{ n: 1, doc_id: "d9", title: "Source" }],
    });
  });

  it("refuses cited_edits with no edits before touching the actor", async () => {
    const actor = fakeActor(proposed);
    const out = await proposeDocEdit(makeCtx(actor.fetch), {
      docId: "d1",
      action: "cited_edits",
      edits: [],
      source: "stdio",
    });
    expect(out).toMatchObject({ kind: "error", message: "cited_edits requires `edits`", status: 400 });
    expect(actor.fetch).not.toHaveBeenCalled();
  });
});

describe("proposeBody", () => {
  const url = "https://stuga.test/doc/d1";
  // The authorized row rides on the outcome for the caller; it never reaches the wire body.
  const doc = { doc_id: "d1" } as DocRow;

  it("carries the media note on both success shapes", () => {
    const note = "Hosted 1 image in this workspace.";
    expect(
      proposeBody({ kind: "proposed", run: RUN, pending: 2, mediaNote: note, review: "review", reason: "waits", doc }, url),
    ).toEqual({ mode: "proposed", run: RUN, pending: 2, review: "review", reason: "waits", media_note: note });
    expect(
      proposeBody({ kind: "auto_applied", run: RUN, seq: 3, mediaNote: note, review: "auto", reason: "at once", doc }, url),
    ).toEqual({ mode: "auto_applied", run: RUN, seq: 3, review: "auto", reason: "at once", review_url: url, media_note: note });
  });

  it("leaves the note out when no image was touched, and answers a no-op with its message", () => {
    expect(proposeBody({ kind: "proposed", run: RUN, pending: 1, review: "review", reason: "r", doc }, url)).not.toHaveProperty("media_note");
    expect(proposeBody({ kind: "noop" }, url)).toEqual({ mode: "noop", message: NOOP_MESSAGE });
  });
});

describe("parseCitedEdits", () => {
  it("accepts a well-formed proposal and caps citation text", () => {
    const out = parseCitedEdits(
      [{ old_string: "a", new_string: "b" }],
      [{ n: 1, doc_id: "d9", title: "T".repeat(300), heading_path: "H", content: "c".repeat(5000) }],
    );
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.edits).toEqual([{ old_string: "a", new_string: "b" }]);
    expect(out.citations[0]!.title).toHaveLength(200);
    expect(out.citations[0]!.content).toHaveLength(1000);
    expect(out.citations[0]!.heading_path).toBe("H");
  });

  it("gives a citation without an excerpt an empty one", () => {
    const out = parseCitedEdits([{ old_string: "a", new_string: "b" }], [{ n: 1, doc_id: "d9", title: "T" }]);
    expect(out).toMatchObject({ citations: [{ n: 1, doc_id: "d9", title: "T", heading_path: null, content: "" }] });
  });

  it("treats absent citations as none", () => {
    expect(parseCitedEdits([{ old_string: "a", new_string: "" }], undefined)).toEqual({
      edits: [{ old_string: "a", new_string: "" }],
      citations: [],
    });
  });

  it.each([
    ["no edits", [], undefined, "cited_edits requires a non-empty `edits` array"],
    ["an empty anchor", [{ old_string: "", new_string: "b" }], undefined, "each edit needs a non-empty `old_string` and a string `new_string`"],
    ["a non-object edit", ["a"], undefined, "each edit must be an object with `old_string` and `new_string`"],
    [
      "too many edits",
      Array.from({ length: 201 }, () => ({ old_string: "a", new_string: "b" })),
      undefined,
      "cited_edits accepts at most 200 edits",
    ],
    ["a citation without n", [{ old_string: "a", new_string: "b" }], [{ doc_id: "d", title: "t" }], "each citation needs a positive integer `n`"],
    ["a citation without doc_id", [{ old_string: "a", new_string: "b" }], [{ n: 1, title: "t" }], "each citation needs a `doc_id`"],
    ["citations that are not a list", [{ old_string: "a", new_string: "b" }], "nope", "`citations` must be an array"],
  ])("refuses %s", (_label, edits, citations, message) => {
    expect(parseCitedEdits(edits, citations)).toEqual({ error: message });
  });
});
