/** GET /api/workspaces/:id/export: who may export, which workspace, and what the response carries. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getWorkspace: vi.fn(async () => ({ workspace_id: "ws1", name: "Liv's 团队", agent_instructions: "" })),
  listFolders: vi.fn(async () => []),
  listExportDocs: vi.fn(async () => []),
  getDoc: vi.fn(async () => null),
  listComments: vi.fn(async () => []),
  listDocsWithCommentsOver: vi.fn(async () => []),
  resolveHumanAuth: vi.fn(async (_sql: unknown, alias: string) => ({
    user: { alias },
    membership: { workspace_id: "ws1", role: "owner" },
    groupIds: [],
  })),
}));

const db = await import("@stuga/db");

const { Readable, Writable } = await import("node:stream");
const { pipeline } = await import("node:stream/promises");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
const { openZip } = await import("../lib/zip.js");
const { parseManifest } = await import("./format.js");
const { EXPORT_IDLE_MS, attachment } = await import("./export-route.js");
const { ARCHIVE_WORK_MAX_MS } = await import("@stuga/protocol/domain/workspaces");
const { createServingGate } = await import("../http/serving-gate.js");
const { archiveWorkUnderWay, holdArchiveWork } = await import("./under-way.js");
import type { DocRow } from "@stuga/db";
import type { Ctx } from "../auth/context.js";

const jobsSend = vi.fn(async (_message: Record<string, unknown>) => {});
/** A body several times what the response buffers, and one deflate cannot shrink below it. */
const BIG = `# Notes\n\n${Array.from({ length: 200_000 }, (_, i) => `${i.toString(36)}${Math.random().toString(36).slice(2)}`).join(" ")}`;
/** What a document's actor answers when the export reads it. */
let docAnswer: (docId: string) => Response | Promise<Response>;

function proseDoc(doc_id: string, title: string): DocRow {
  return {
    doc_id,
    workspace_id: "ws1",
    doc_type: "prose",
    title,
    title_source: "heading",
    parent_id: null,
    page_of: null,
    trashed: false,
    acl_principals: ["user:u_liv"],
    locked: false,
    search_hidden: false,
    agent_mode: "review",
    agent_instructions: "",
  } as unknown as DocRow;
}

/** The workspace holds `docs`, each readable. */
function holding(docs: DocRow[]): void {
  vi.mocked(db.listExportDocs).mockResolvedValueOnce(docs);
  vi.mocked(db.getDoc).mockImplementation(async (_sql, id) => docs.find((d) => d.doc_id === id) ?? null);
}

const audits = () => jobsSend.mock.calls.map(([m]) => m).filter((m) => m.kind === "audit");

function ctxOf(patch: Partial<{ isAgent: boolean; role: string; workspaceId: string; alias: string }> = {}): Ctx {
  return {
    sql: {},
    surface: "web",
    alias: "u_liv",
    displayName: "Liv",
    isAgent: false,
    principals: ["user:u_liv", "org:ws1"],
    workspaceId: "ws1",
    role: "owner",
    env: {
      publicOrigin: "https://node.test",
      extraOrigins: [],
      jobs: { send: jobsSend },
      docs: { get: (id: string) => ({ fetch: async () => docAnswer(id) }) },
    },
    ...(patch.isAgent ? { onBehalfOf: "u_liv" } : {}),
    ...patch,
  } as unknown as Ctx;
}

const exportFrom = (ctx: Ctx, id = "ws1") => routeWorkspaceRequest(ctx, new Request(`https://node.test/api/workspaces/${id}/export`));

beforeEach(() => {
  vi.useRealTimers();
  jobsSend.mockClear();
  vi.mocked(db.getDoc).mockReset().mockResolvedValue(null);
  docAnswer = () => Response.json({ markdown: BIG });
});

describe("workspace export route", () => {
  it("refuses an agent, even its owner's", async () => {
    const res = await exportFrom(ctxOf({ isAgent: true }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "agents cannot manage workspaces" });
  });

  it("refuses a member who is not an owner or admin", async () => {
    const res = await exportFrom(ctxOf({ role: "member" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "only a workspace owner or admin can export the workspace" });
  });

  it("refuses a workspace other than the one the request's context is for", async () => {
    // The role the gate checked is ws1's, so an export of ws2 through it is refused.
    const res = await exportFrom(ctxOf({ role: "admin" }), "ws2");
    expect(res.status).toBe(400);
    expect(jobsSend).not.toHaveBeenCalled();
  });

  it("streams an admin the archive, named for the workspace, and audits it once written", async () => {
    const res = await exportFrom(ctxOf({ role: "admin" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Livs.stuga.zip"; filename*=UTF-8''Liv%27s%20%E5%9B%A2%E9%98%9F.stuga.zip`,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const archive = openZip(bytes);
    const manifest = parseManifest(JSON.parse(new TextDecoder().decode(await archive.read("stuga.json"))));
    expect(manifest.workspace.name).toBe("Liv's 团队");
    expect(manifest.items).toEqual([]);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      action: "workspace.export",
      targetKind: "workspace",
      targetId: "ws1",
      detail: { docs: 0, databases: 0, bytes: bytes.byteLength },
    });
  });
});

describe("workspace export stream", () => {
  it("waits for a slow client, as the server pipes it, and finishes", async () => {
    holding([proseDoc("d1", "Notes")]);
    const res = await exportFrom(ctxOf());
    const chunks: Buffer[] = [];
    const slow = new Writable({
      highWaterMark: 64 * 1024,
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        setTimeout(done, 1);
      },
    });
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), slow);
    const archive = openZip(Buffer.concat(chunks));
    expect(new TextDecoder().decode(await archive.read("Notes.md"))).toBe(`${BIG}\n`);
    expect(audits()).toHaveLength(1);
  });

  it("breaks the download, rather than end it as if whole, and audits it unfinished when the archive cannot be finished", async () => {
    const failed = vi.spyOn(console, "error").mockImplementation(() => {});
    holding([proseDoc("d1", "Notes"), proseDoc("d2", "Plan")]);
    // Plan's actor answers while the export is planned, and no longer once Notes is written.
    const reads = new Map<string, number>();
    docAnswer = (id) => {
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return id === "d2" && reads.get("d1") === 2 ? new Response("down", { status: 503 }) : Response.json({ markdown: BIG });
    };
    const res = await exportFrom(ctxOf());
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow('could not read "Plan"');
    await vi.waitFor(() => expect(audits()).toHaveLength(1));
    const [audit] = audits() as Array<{ detail: { finished?: boolean; bytes: number } }>;
    expect(audit!.detail.finished).toBe(false);
    expect(audit!.detail.bytes).toBeGreaterThan(0);
    expect(failed).toHaveBeenCalledWith("workspace export failed", { workspaceId: "ws1", error: 'could not read "Plan"' });
    failed.mockRestore();
  });

  it("stops writing when the client goes away, audits what was sent as unfinished, and reports no failure", async () => {
    const failed = vi.spyOn(console, "error").mockImplementation(() => {});
    holding([proseDoc("d1", "Notes"), proseDoc("d2", "Plan"), proseDoc("d3", "Diary")]);
    const res = await exportFrom(ctxOf());
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.value?.byteLength).toBeGreaterThan(0);
    await reader.cancel();
    await vi.waitFor(() => expect(audits()).toHaveLength(1));
    expect(audits()[0]).toMatchObject({ detail: { finished: false } });
    expect(failed).not.toHaveBeenCalled();
    failed.mockRestore();
  });

  it("is work a backup waits for until the archive is written, or the client goes away", async () => {
    holding([proseDoc("d1", "Notes")]);
    const read = await exportFrom(ctxOf());
    expect(archiveWorkUnderWay()).toBe(true);
    await read.arrayBuffer();
    await vi.waitFor(() => expect(archiveWorkUnderWay()).toBe(false));

    holding([proseDoc("d1", "Notes"), proseDoc("d2", "Plan")]);
    const left = await exportFrom(ctxOf());
    const reader = left.body!.getReader();
    await reader.read();
    expect(archiveWorkUnderWay()).toBe(true);
    await reader.cancel();
    await vi.waitFor(() => expect(archiveWorkUnderWay()).toBe(false));

    expect((await exportFrom(ctxOf({ role: "member" }))).status).toBe(403);
    expect(archiveWorkUnderWay()).toBe(false);
  });

  it("keeps a pause for a backup waiting until the archive is written, since it is read from the actors as it is sent", async () => {
    holding([proseDoc("d1", "Notes")]);
    const gate = createServingGate();
    gate.open({ handler: () => exportFrom(ctxOf()), upgrade: async () => new Response(null) });
    const res = await gate.handler(new Request("https://node.test/api/workspaces/ws1/export"));
    gate.pause("maintenance");
    expect(await gate.drain(20)).toBe(false);
    const drained = gate.drain(10_000);
    await res.arrayBuffer();
    expect(await drained).toBe(true);
  });
});

describe("how long and how many exports run", () => {
  /** Fake time moves a second at a time, the export's own work in between, until `done`. */
  async function until(done: () => boolean, most: number): Promise<number> {
    let waited = 0;
    while (!done() && waited < most) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(1_000);
      waited += 1_000;
    }
    return waited;
  }

  it("lets a person run one export at a time, and the node three", async () => {
    // Open to everyone in the workspace, so each exporter's archive holds it and waits for them to read.
    const notes = (): DocRow[] => [{ ...proseDoc("d1", "Notes"), acl_principals: ["org:ws1"] }];
    holding(notes());
    const liv = await exportFrom(ctxOf());
    expect(liv.status).toBe(200);
    const again = await exportFrom(ctxOf());
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "you are already exporting a workspace; try again when it is done" });

    const others = [];
    for (const alias of ["u_ada", "u_bo"]) {
      holding(notes());
      others.push(await exportFrom(ctxOf({ alias })));
    }
    expect(others.map((r) => r.status)).toEqual([200, 200]);
    const fourth = await exportFrom(ctxOf({ alias: "u_cy" }));
    expect(fourth.status).toBe(409);
    expect(await fourth.json()).toEqual({ error: "other workspaces are being exported on this node; try again when one is done" });

    await liv.body!.cancel();
    await vi.waitFor(() => expect(audits()).toHaveLength(1));
    holding(notes());
    const next = await exportFrom(ctxOf({ alias: "u_cy" }));
    expect(next.status).toBe(200);
    await Promise.all([next, ...others].map((r) => r.body!.cancel()));
    await vi.waitFor(() => expect(archiveWorkUnderWay()).toBe(false));
  });

  it("starts none while a backup waits for the imports and exports under way", async () => {
    holdArchiveWork(true);
    try {
      const res = await exportFrom(ctxOf());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "the node is waiting to back up; try again once it has" });
      expect(archiveWorkUnderWay()).toBe(false);
    } finally {
      holdArchiveWork(false);
    }
    const res = await exportFrom(ctxOf());
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it("stops, and breaks the download, once the client has read nothing for a minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const failed = vi.spyOn(console, "error").mockImplementation(() => {});
    holding([proseDoc("d1", "Notes")]);
    const res = await exportFrom(ctxOf());
    const reader = res.body!.getReader();
    await reader.read();
    expect(await until(() => audits().length > 0, 10 * 60_000)).toBeGreaterThanOrEqual(EXPORT_IDLE_MS);
    expect(audits()[0]).toMatchObject({ detail: { finished: false } });
    await expect(reader.read()).rejects.toThrow("the client read nothing for 60 seconds");
    expect(archiveWorkUnderWay()).toBe(false);
    expect(failed).toHaveBeenCalledWith("workspace export failed", { workspaceId: "ws1", error: "the client read nothing for 60 seconds" });
    failed.mockRestore();
  });

  it("goes on for a client that reads a little at a time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    holding([proseDoc("d1", "Notes")]);
    const res = await exportFrom(ctxOf());
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      chunks.push(next.value);
      await vi.advanceTimersByTimeAsync(EXPORT_IDLE_MS / 2);
    }
    // Well past a minute in all, and past it again and again while the export waited for a read.
    expect(chunks.length * (EXPORT_IDLE_MS / 2)).toBeGreaterThan(10 * EXPORT_IDLE_MS);
    expect(new TextDecoder().decode(await openZip(Buffer.concat(chunks)).read("Notes.md"))).toBe(`${BIG}\n`);
    expect(audits()[0]).toMatchObject({ detail: { docs: 1 } });
    expect(audits()[0]).not.toMatchObject({ detail: { finished: false } });
  });

  it("stops an export not written within 50 minutes, at 50 minutes, whatever the writing waits on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const failed = vi.spyOn(console, "error").mockImplementation(() => {});
    holding([proseDoc("d1", "Notes"), proseDoc("d2", "Plan")]);
    // Plan's actor answers at once while the export is planned, and never once Notes is written.
    const reads = new Map<string, number>();
    docAnswer = (id) => {
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return id !== "d2" || reads.get(id) === 1 ? Response.json({ markdown: "# Short" }) : new Promise<Response>(() => {});
    };
    const res = await exportFrom(ctxOf());
    const read = res.arrayBuffer().then(
      () => "finished",
      (err: unknown) => (err as Error).message,
    );
    const waited = await until(() => audits().length > 0, 2 * ARCHIVE_WORK_MAX_MS);
    expect(waited).toBeGreaterThanOrEqual(ARCHIVE_WORK_MAX_MS);
    expect(waited).toBeLessThanOrEqual(ARCHIVE_WORK_MAX_MS + 1_000);
    const why = `the export did not finish within ${ARCHIVE_WORK_MAX_MS / 60_000} minutes`;
    expect(await read).toBe(why);
    expect(audits()[0]).toMatchObject({ detail: { finished: false } });
    expect(failed).toHaveBeenCalledWith("workspace export failed", { workspaceId: "ws1", error: why });
    expect(archiveWorkUnderWay()).toBe(false);
    // The person's and the node's places are free again.
    docAnswer = () => Response.json({ markdown: "# Short" });
    holding([proseDoc("d1", "Notes")]);
    const next = await exportFrom(ctxOf());
    expect(next.status).toBe(200);
    await next.body!.cancel();
    failed.mockRestore();
  });
});

describe("attachment", () => {
  it("names the file in UTF-8, with an ASCII name beside it", () => {
    expect(attachment("Plans (2026)*")).toBe(`attachment; filename="Plans 2026.stuga.zip"; filename*=UTF-8''Plans%20%282026%29%2A.stuga.zip`);
    expect(attachment("個人情報")).toBe(`attachment; filename="workspace.stuga.zip"; filename*=UTF-8''%E5%80%8B%E4%BA%BA%E6%83%85%E5%A0%B1.stuga.zip`);
    expect(attachment("a/b\\c")).toContain(`filename*=UTF-8''a-b-c.stuga.zip`);
  });
});
