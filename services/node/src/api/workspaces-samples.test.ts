/** GET /api/workspace-samples and POST /api/workspaces with a sample: the index's samples, and one downloaded, checked and imported with its steps. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  provisionWorkspace: vi.fn(),
  deleteWorkspaceCascade: vi.fn(),
  getWorkspace: vi.fn(),
  finishWorkspaceImport: vi.fn(async () => true),
}));
vi.mock("../archive/import.js", async (orig) => ({
  ...(await orig<typeof import("../archive/import.js")>()),
  importWorkspaceArchive: vi.fn(),
}));
vi.mock("../archive/samples.js", async (orig) => ({
  ...(await orig<typeof import("../archive/samples.js")>()),
  sampleCatalog: vi.fn(),
}));

const { provisionWorkspace, deleteWorkspaceCascade, getWorkspace } = await import("@stuga/db");
const { ImportStepError, importWorkspaceArchive } = await import("../archive/import.js");
const { SampleDownloadError, sampleCatalog } = await import("../archive/samples.js");
const { createWorkspace, importWorkspace, listWorkspaceSamples } = await import("./workspaces.js");
const { APP_ROUTES } = await import("../http/routes.js");
const { matchRoute } = await import("../http/router.js");
import type { SamplesIndex } from "../archive/format.js";
import type { SampleCatalog } from "../archive/samples.js";
import type { AccountCtx } from "../auth/context.js";
import { DEFAULT_MAX_BODY_BYTES } from "../media/media.js";
import { build, text } from "../archive/testing/fixture.js";

const mockProvision = provisionWorkspace as unknown as ReturnType<typeof vi.fn>;
const mockCascade = deleteWorkspaceCascade as unknown as ReturnType<typeof vi.fn>;
const mockImport = importWorkspaceArchive as unknown as ReturnType<typeof vi.fn>;

const SAMPLES_URL = "http://mirror.lan/samples";

const listed = (id: string, name: string) => ({
  id,
  title: `The ${id} sample`,
  description: `What ${id} shows.`,
  name,
  langs: ["en", "zh"],
  file: `${id}.stuga.zip`,
  sha256: "0".repeat(64),
  bytes: 1234,
  archive_version: 1,
});

const INDEX: SamplesIndex = {
  format: "stuga-samples",
  version: 1,
  tag: "v2026.09.25",
  samples: [listed("python-specs", "Python specs"), listed("privacy-laws", "Privacy laws")],
};

let catalog: { index: ReturnType<typeof vi.fn>; lastLookFailed: ReturnType<typeof vi.fn>; download: ReturnType<typeof vi.fn> };
const jobs: Array<Record<string, unknown>> = [];

function ctxOf(): AccountCtx {
  const ns = () => ({ get: () => ({ fetch: async () => new Response("{}") }) });
  return {
    sql: {},
    surface: "web",
    alias: "u_liv",
    displayName: "Liv",
    isAgent: false,
    requestId: "req-1",
    env: {
      sql: {},
      samplesUrl: SAMPLES_URL,
      settings: { current: () => ({ maxBodyBytes: DEFAULT_MAX_BODY_BYTES }) },
      jobs: { send: vi.fn(async (m: Record<string, unknown>) => void jobs.push(m)) },
      docs: ns(),
      databases: ns(),
      media: { list: async () => ({ objects: [], truncated: false }), delete: async () => {} },
    },
  } as unknown as AccountCtx;
}

async function list(): Promise<Response> {
  const req = new Request("https://node.test/api/workspace-samples");
  return listWorkspaceSamples({ ctx: ctxOf(), req, url: new URL(req.url), match: ["/api/workspace-samples"] });
}

async function create(body: unknown): Promise<Response> {
  const req = new Request("https://node.test/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return createWorkspace({ ctx: ctxOf(), req, url: new URL(req.url), match: ["/api/workspaces"] });
}

const errorOf = async (res: Response): Promise<string> => ((await res.json()) as { error: string }).error;

beforeEach(() => {
  vi.clearAllMocks();
  jobs.length = 0;
  catalog = { index: vi.fn(async () => INDEX), lastLookFailed: vi.fn(() => false), download: vi.fn(async () => build()) };
  vi.mocked(sampleCatalog).mockReturnValue(catalog as unknown as SampleCatalog);
  mockProvision.mockImplementation(async (_sql: unknown, input: { workspaceId: string; name: string; defaultDocAccess?: string }) => ({
    workspace_id: input.workspaceId,
    name: input.name,
    default_doc_access: input.defaultDocAccess ?? "workspace_edit",
    agent_instructions: "",
    created_at: "2026-01-01T00:00:00.000Z",
  }));
  mockCascade.mockResolvedValue({ docs: [] });
  vi.mocked(getWorkspace).mockResolvedValue(null);
  mockImport.mockResolvedValue({ ids: {}, startDocId: "d_start", counts: { folders: 1, docs: 2, databases: 1, pages: 1, rows: 2, images: 1, comments: 3 } });
});

afterEach(() => vi.restoreAllMocks());

describe("GET /api/workspace-samples", () => {
  it("lists the index's samples in its order, with what a person picks by and nothing of where they come from", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      samples: [
        { id: "python-specs", title: "The python-specs sample", description: "What python-specs shows.", name: "Python specs", langs: ["en", "zh"] },
        { id: "privacy-laws", title: "The privacy-laws sample", description: "What privacy-laws shows.", name: "Privacy laws", langs: ["en", "zh"] },
      ],
    });
    expect(sampleCatalog).toHaveBeenCalledWith(SAMPLES_URL);
  });

  it("says the samples are unavailable when the node has no index", async () => {
    catalog.index.mockResolvedValue(null);
    expect(await (await list()).json()).toEqual({ samples: [], unavailable: true });
  });

  it("says so too once a look fails, as offline, though the node keeps the index it read", async () => {
    catalog.lastLookFailed.mockReturnValue(true);
    expect(await (await list()).json()).toEqual({ samples: [], unavailable: true });
  });

  it("is a person's call on their account, before any workspace is theirs", () => {
    const found = matchRoute(APP_ROUTES, "GET", "/api/workspace-samples");
    expect(found?.route).toMatchObject({ auth: "account", humanOnly: expect.any(String), handler: listWorkspaceSamples });
  });
});

describe("POST /api/workspaces with a sample", () => {
  it("imports the sample, trusted with its steps, and answers as a create does plus the document to open", async () => {
    const res = await create({ name: "", sample: "privacy-laws", default_doc_access: "private" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["agent_instructions", "created_at", "default_doc_access", "name", "role", "start_doc_id", "workspace_id"]);
    expect(body).toMatchObject({ name: "Privacy laws", role: "owner", default_doc_access: "private", start_doc_id: "d_start" });
    expect(catalog.download).toHaveBeenCalledWith(INDEX, INDEX.samples[1]);
    expect(mockProvision.mock.calls[0]![1]).toMatchObject({ name: "Privacy laws", owner: "u_liv", defaultDocAccess: "private" });
    const [ctx, workspaceId, contents, opts] = mockImport.mock.calls[0]!;
    expect((ctx as AccountCtx).alias).toBe("u_liv");
    expect(workspaceId).toBe(body.workspace_id);
    expect((contents as { manifest: { start: string } }).manifest.start).toBe("Start here.md");
    expect(opts).toEqual({ trusted: true, sampleSteps: expect.any(Function), signal: expect.any(AbortSignal) });
    expect(jobs.filter((m) => m.kind === "audit")).toEqual([
      expect.objectContaining({ action: "workspace.import", targetLabel: "Privacy laws", detail: expect.objectContaining({ docs: 2, sample: "privacy-laws" }) }),
    ]);
  });

  it("keeps a name the person typed", async () => {
    const res = await create({ name: " Our laws ", sample: "privacy-laws" });
    expect(((await res.json()) as { name: string }).name).toBe("Our laws");
    expect(mockProvision.mock.calls[0]![1].defaultDocAccess).toBeUndefined();
  });

  it.each([
    ["an id no sample has", { sample: "handbook" }, 'there is no sample "handbook"'],
    ["a sample that is no id", { sample: 7 }, "sample must be a sample's id"],
    ["an unknown default access", { sample: "privacy-laws", default_doc_access: "public" }, "default_doc_access must be workspace_edit | workspace_view | private"],
  ])("refuses %s with 400, downloading and creating nothing", async (_case, body, message) => {
    const res = await create({ name: "Laws", ...body });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe(message);
    expect(catalog.download).not.toHaveBeenCalled();
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it.each([
    ["there is no index", () => catalog.index.mockResolvedValue(null)],
    ["the download fails", () => catalog.download.mockRejectedValue(new SampleDownloadError("http://mirror.lan/…: not the SHA-256 the index lists"))],
    ["the archive fails its checks", () => catalog.download.mockResolvedValue(text("not a zip"))],
  ])("answers 502 when %s, creating nothing, and logs why", async (_case, arrange) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    arrange();
    const res = await create({ name: "Laws", sample: "privacy-laws" });
    expect(res.status).toBe(502);
    expect(await errorOf(res)).toBe("could not download the sample");
    expect(mockProvision).not.toHaveBeenCalled();
    if (catalog.download.mock.calls.length > 0) {
      expect(logged).toHaveBeenCalledWith("could not download a sample", expect.objectContaining({ sample: "privacy-laws", tag: "v2026.09.25" }));
    }
  });

  it("deletes the workspace again when the import or a step fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockImport.mockRejectedValue(new ImportStepError("sample steps", new Error("step 1: the edit to Brief.md was noop, not proposed")));
    const res = await create({ name: "Laws", sample: "privacy-laws" });
    expect(res.status).toBe(500);
    expect(mockCascade).toHaveBeenCalledWith(expect.anything(), mockProvision.mock.calls[0]![1].workspaceId);
  });

  it("counts as the person's one import, so it waits for their archive upload", async () => {
    let finish!: () => void;
    mockImport.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve({ ids: {}, startDocId: null, counts: {} }))));
    const req = new Request("https://node.test/api/workspaces/import", { method: "POST", body: build() as Uint8Array<ArrayBuffer> });
    const upload = importWorkspace({ ctx: ctxOf(), req, url: new URL(req.url), match: ["/api/workspaces/import"] });
    await vi.waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    const res = await create({ name: "Laws", sample: "privacy-laws" });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("you are already importing a workspace; try again when it is done");
    expect(catalog.download).not.toHaveBeenCalled();
    finish();
    expect((await upload).status).toBe(201);
    expect((await create({ name: "Laws", sample: "privacy-laws" })).status).toBe(201);
  });
});
