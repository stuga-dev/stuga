/**
 * POST /api/workspaces/import: the archive is checked before a workspace exists, the workspace is
 * listed only once the import is done, and a failed import, or one a stopped node left, leaves none behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  provisionWorkspace: vi.fn(),
  deleteWorkspaceCascade: vi.fn(),
  getWorkspace: vi.fn(),
  finishWorkspaceImport: vi.fn(),
  listUnfinishedImports: vi.fn(),
}));
vi.mock("../archive/import.js", async (orig) => ({
  ...(await orig<typeof import("../archive/import.js")>()),
  importWorkspaceArchive: vi.fn(),
}));

const { provisionWorkspace, deleteWorkspaceCascade, getWorkspace, finishWorkspaceImport, listUnfinishedImports } = await import("@stuga/db");
const { ImportStepError, importWorkspaceArchive } = await import("../archive/import.js");
const { importWorkspace, purgeUnfinishedImports } = await import("./workspaces.js");
const { archiveWorkUnderWay, holdArchiveWork } = await import("../archive/under-way.js");
const { APP_ROUTES } = await import("../http/routes.js");
const { matchRoute } = await import("../http/router.js");
import { zipFiles } from "../lib/zip.js";
import { DEFAULT_MAX_BODY_BYTES } from "../media/media.js";
import type { AccountCtx } from "../auth/context.js";

const mockProvision = provisionWorkspace as unknown as ReturnType<typeof vi.fn>;
const mockCascade = deleteWorkspaceCascade as unknown as ReturnType<typeof vi.fn>;
const mockGetWorkspace = getWorkspace as unknown as ReturnType<typeof vi.fn>;
const mockImport = importWorkspaceArchive as unknown as ReturnType<typeof vi.fn>;
const mockFinish = finishWorkspaceImport as unknown as ReturnType<typeof vi.fn>;
const mockUnfinished = listUnfinishedImports as unknown as ReturnType<typeof vi.fn>;

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

function archive(start = true): Uint8Array {
  const manifest = {
    format: "stuga-workspace",
    version: 1,
    generator: "stuga test",
    exported_at: "2026-09-25T10:00:00Z",
    workspace: { name: "Team handbook", agent_instructions: "" },
    ...(start ? { start: "Start here.md" } : {}),
    items: [
      {
        kind: "doc",
        path: "Start here.md",
        parent: null,
        title: "Start here",
        title_source: "heading",
        agent_mode: "review",
        locked: false,
        search_hidden: false,
        agent_instructions: "",
      },
    ],
  };
  return zipFiles(
    [
      { name: "stuga.json", data: text(JSON.stringify(manifest)) },
      { name: "Start here.md", data: text("# Start here\n") },
    ],
    "deflate",
  );
}

const jobs: Array<Record<string, unknown>> = [];
let actorCalls: string[];
let mediaPrefixes: string[];

function ctxOf(alias = "u_liv"): AccountCtx {
  const ns = () => ({ get: () => ({ fetch: async (url: string) => (actorCalls.push(url), new Response("{}")) }) });
  return {
    sql: {},
    surface: "web",
    alias,
    displayName: "Liv",
    isAgent: false,
    requestId: "req-1",
    env: {
      sql: {},
      settings: { current: () => ({ maxBodyBytes: DEFAULT_MAX_BODY_BYTES }) },
      jobs: { send: vi.fn(async (m: Record<string, unknown>) => void jobs.push(m)) },
      docs: ns(),
      databases: ns(),
      media: {
        list: async ({ prefix }: { prefix: string }) => (mediaPrefixes.push(prefix), { objects: [], truncated: false }),
        delete: async () => {},
      },
    },
  } as unknown as AccountCtx;
}

async function post(body: Uint8Array, query = "", alias = "u_liv"): Promise<Response> {
  const path = `/api/workspaces/import${query}`;
  const req = new Request(`https://node.test${path}`, { method: "POST", headers: { "content-type": "application/zip" }, body: body as Uint8Array<ArrayBuffer> });
  return importWorkspace({ ctx: ctxOf(alias), req, url: new URL(req.url), match: ["/api/workspaces/import"] });
}

beforeEach(() => {
  vi.clearAllMocks();
  jobs.length = 0;
  actorCalls = [];
  mediaPrefixes = [];
  mockProvision.mockImplementation(async (_sql: unknown, input: { workspaceId: string; name: string; defaultDocAccess?: string }) => ({
    workspace_id: input.workspaceId,
    name: input.name,
    default_doc_access: input.defaultDocAccess ?? "workspace_edit",
    agent_instructions: "",
    created_at: "2026-01-01T00:00:00.000Z",
  }));
  mockCascade.mockResolvedValue({ docs: [{ doc_id: "d1", doc_type: "prose" }] });
  mockGetWorkspace.mockResolvedValue(null);
  mockImport.mockResolvedValue({ ids: {}, startDocId: "d1", counts: { folders: 0, docs: 1, databases: 0, pages: 0, rows: 0, images: 0, comments: 0 } });
  mockFinish.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("POST /api/workspaces/import", () => {
  it("creates the workspace, imports into it as its owner, and answers as a create does plus the document to open", async () => {
    // As the import left it: with the archive's instructions.
    mockGetWorkspace.mockImplementation(async (_sql: unknown, id: string) => ({
      workspace_id: id,
      name: "Handbook",
      default_doc_access: "private",
      agent_instructions: "Answer with citations.",
      created_at: "2026-01-01T00:00:00.000Z",
    }));
    const res = await post(archive(), "?name=%20Handbook%20&default_doc_access=private");
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["agent_instructions", "created_at", "default_doc_access", "name", "role", "start_doc_id", "workspace_id"]);
    expect(body).toMatchObject({ name: "Handbook", role: "owner", default_doc_access: "private", start_doc_id: "d1", agent_instructions: "Answer with citations." });
    // Marked in the transaction that makes it, so no list shows it until the import is done.
    expect(mockProvision.mock.calls[0]![1]).toMatchObject({ name: "Handbook", owner: "u_liv", defaultDocAccess: "private", importing: true });
    expect(mockFinish).toHaveBeenCalledWith(expect.anything(), body.workspace_id);
    expect(mockFinish.mock.invocationCallOrder[0]).toBeGreaterThan(mockImport.mock.invocationCallOrder[0]!);
    const [ctx, workspaceId, contents] = mockImport.mock.calls[0]!;
    expect((ctx as AccountCtx).alias).toBe("u_liv");
    expect(workspaceId).toBe(body.workspace_id);
    expect((contents as { manifest: { start: string } }).manifest.start).toBe("Start here.md");
    expect(jobs.filter((m) => m.kind === "audit")).toEqual([
      expect.objectContaining({ workspaceId: body.workspace_id, action: "workspace.import", targetLabel: "Handbook", detail: expect.objectContaining({ docs: 1 }) }),
    ]);
    expect(mockCascade).not.toHaveBeenCalled();
  });

  it("takes the archive's name when none is given, and names no document to open when the archive names none", async () => {
    mockImport.mockResolvedValue({ ids: {}, startDocId: null, counts: {} });
    const res = await post(archive(false));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("Team handbook");
    expect("start_doc_id" in body).toBe(false);
    expect(mockProvision.mock.calls[0]![1].defaultDocAccess).toBeUndefined();
  });

  it("refuses an archive it cannot read, saying why, before any workspace exists", async () => {
    const res = await post(text("not a zip"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^cannot import this archive: .*not a zip archive/);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("refuses an unknown default access and an empty body, before reading anything", async () => {
    expect((await post(archive(), "?default_doc_access=public")).status).toBe(400);
    expect((await post(new Uint8Array())).status).toBe(400);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("deletes the workspace again when a write fails, and answers without the detail, which goes to the log", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockImport.mockRejectedValue(new ImportStepError("Laws/GDPR.md", new Error("the actor is gone")));
    const res = await post(archive());
    expect(res.status).toBe(500);
    const answer = JSON.stringify(await res.json());
    expect(answer).not.toContain("actor");
    const workspaceId = mockProvision.mock.calls[0]![1].workspaceId as string;
    expect(mockCascade).toHaveBeenCalledWith(expect.anything(), workspaceId);
    expect(actorCalls).toEqual(["http://actor/destroy?docId=d1"]);
    expect(mediaPrefixes).toEqual([`media/${workspaceId}/`]);
    expect(logged).toHaveBeenCalledWith("workspace import failed", expect.objectContaining({ workspaceId, step: "Laws/GDPR.md", error: "Laws/GDPR.md: the actor is gone" }));
    expect(jobs.filter((m) => m.kind === "audit")).toEqual([]);
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it("deletes the workspace again when its import cannot be marked done, since it would be deleted at the next start", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFinish.mockRejectedValue(new Error("connection lost"));
    const res = await post(archive());
    expect(res.status).toBe(500);
    expect(mockCascade).toHaveBeenCalledWith(expect.anything(), mockProvision.mock.calls[0]![1].workspaceId);
    expect(jobs.filter((m) => m.kind === "audit")).toEqual([]);
  });

  it("runs one import per person and three on the node, and takes the next once one is done", async () => {
    const finish: Array<() => void> = [];
    mockImport.mockImplementation(() => new Promise((resolve) => finish.push(() => resolve({ ids: {}, startDocId: null, counts: {} }))));
    const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
    const first = post(archive());
    await vi.waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    // A backup waits while any is under way.
    expect(archiveWorkUnderWay()).toBe(true);
    const again = await post(archive());
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toBe("you are already importing a workspace; try again when it is done");

    // Someone else's import is not held up by Liv's.
    const others = [post(archive(), "", "u_ada"), post(archive(), "", "u_bo")];
    await vi.waitFor(() => expect(mockImport).toHaveBeenCalledTimes(3));
    const fourth = await post(archive(), "", "u_cy");
    expect(fourth.status).toBe(409);
    expect(await errorOf(fourth)).toBe("other workspaces are being imported on this node; try again when one is done");
    expect(mockProvision).toHaveBeenCalledTimes(3);

    finish.shift()!();
    expect((await first).status).toBe(201);
    const next = post(archive(), "", "u_cy");
    await vi.waitFor(() => expect(mockImport).toHaveBeenCalledTimes(4));
    for (const done of finish) done();
    expect((await Promise.all([...others, next])).map((r) => r.status)).toEqual([201, 201, 201]);
    expect(archiveWorkUnderWay()).toBe(false);
  });

  it("starts none while a backup waits for the imports and exports under way", async () => {
    holdArchiveWork(true);
    try {
      const res = await post(archive());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "the node is waiting to back up; try again once it has" });
      expect(mockProvision).not.toHaveBeenCalled();
      expect(archiveWorkUnderWay()).toBe(false);
    } finally {
      holdArchiveWork(false);
    }
    expect((await post(archive())).status).toBe(201);
  });

  it("stops an import still writing after 50 minutes, before the web app gives up waiting, and deletes its workspace", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let signal!: AbortSignal;
    mockImport.mockImplementation(
      (_ctx: unknown, _id: unknown, _contents: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal = opts.signal;
          signal.addEventListener("abort", () => reject(new ImportStepError("Start here.md", signal.reason)));
        }),
    );
    const answer = post(archive());
    await vi.waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(50 * 60_000 - 1_000);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await answer;
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "the import did not finish within 50 minutes, so the workspace was not created" });
    expect(mockCascade).toHaveBeenCalledWith(expect.anything(), mockProvision.mock.calls[0]![1].workspaceId);
    expect(mockFinish).not.toHaveBeenCalled();
    // Its place is free again.
    mockImport.mockResolvedValue({ ids: {}, startDocId: null, counts: {} });
    expect((await post(archive())).status).toBe(201);
  });

  it("is a person's call on their account, before any workspace is theirs", () => {
    const found = matchRoute(APP_ROUTES, "POST", "/api/workspaces/import");
    expect(found?.route).toMatchObject({ auth: "account", humanOnly: expect.any(String), handler: importWorkspace });
  });
});

describe("purgeUnfinishedImports", () => {
  it("deletes each workspace an import left when the node stopped, logging each, and goes on past one it cannot delete", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockUnfinished.mockResolvedValue([
      { workspace_id: "ws-a", name: "Handbook", import_started_at: new Date("2026-09-25T10:00:00Z") },
      { workspace_id: "ws-b", name: "Privacy laws", import_started_at: new Date("2026-09-25T11:00:00Z") },
    ]);
    mockCascade.mockRejectedValueOnce(new Error("connection lost"));
    await purgeUnfinishedImports(ctxOf().env);
    expect(mockCascade.mock.calls.map((c) => c[1])).toEqual(["ws-a", "ws-b"]);
    expect(info.mock.calls.map((c) => c[0])).toEqual([
      '[node] deleting workspace ws-a ("Handbook"): its import, started 2026-09-25T10:00:00.000Z, stopped when the node did',
      '[node] deleting workspace ws-b ("Privacy laws"): its import, started 2026-09-25T11:00:00.000Z, stopped when the node did',
    ]);
    expect(logged).toHaveBeenCalledWith("[node] could not delete the workspace an unfinished import left", { workspaceId: "ws-a", error: "connection lost" });
    // The one it could delete took its documents' actors and media with it.
    expect(actorCalls).toEqual(["http://actor/destroy?docId=d1"]);
    expect(mediaPrefixes).toEqual(["media/ws-b/"]);
  });
});
