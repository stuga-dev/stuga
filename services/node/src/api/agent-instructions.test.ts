/**
 * Instructions for agents on documents and folders at the REST front door: only
 * a person who manages the item writes them, every reader reads the stack, a
 * refused write changes nothing, the ledger keeps sizes and never the text, and
 * only an agent's answers carry the stack.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  getFolder: vi.fn(),
  getFolderAncestors: vi.fn(async () => []),
  setDocAgentInstructions: vi.fn(),
  setDocLocked: vi.fn(),
  updateFolder: vi.fn(),
  resolveDocInstructions: vi.fn(),
  resolveFolderInstructions: vi.fn(),
}));
vi.mock("../documents/create.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../documents/create.js")>()),
  createDocument: vi.fn(),
}));
vi.mock("../agents/edits.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/edits.js")>()),
  proposeDocEdit: vi.fn(),
}));

const {
  getDoc,
  getFolder,
  getFolderAncestors,
  setDocAgentInstructions,
  setDocLocked,
  updateFolder,
  resolveDocInstructions,
  resolveFolderInstructions,
} = await import("@stuga/db");
const { createDocument } = await import("../documents/create.js");
const { proposeDocEdit } = await import("../agents/edits.js");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
const { READ_ONLY_MESSAGE } = await import("../authz/authz.js");
import type { InstructionLevel } from "@stuga/protocol/domain/instructions";
import { MAX_AGENT_INSTRUCTIONS_CHARS } from "@stuga/protocol/domain/limits";
import type { Ctx } from "../auth/context.js";

const mocked = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const DOC = {
  doc_id: "d1",
  workspace_id: "ws1",
  owner: "user:alice",
  title: "Q3 plan",
  doc_type: "prose",
  parent_id: "f1",
  page_of: null,
  trashed: false,
  locked: false,
  search_hidden: false,
  agent_mode: "review",
  agent_instructions: "  cite the source \n",
  acl_principals: ["user:alice", "org:ws1"],
  acl_writers: ["user:alice", "org:ws1"],
  acl_commenters: [],
};

const DATABASE = { ...DOC, doc_id: "db1", title: "Tasks", doc_type: "database", agent_instructions: "" };

const FOLDER = {
  folder_id: "f1",
  workspace_id: "ws1",
  owner: "user:alice",
  title: "Contracts",
  parent_id: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  agent_instructions: "",
  acl_principals: ["user:alice", "org:ws1"],
  acl_writers: ["user:alice", "org:ws1"],
  inherits_perms: true,
  own_grants: { p: [], w: [], c: [] },
};

const WS_LEVEL: InstructionLevel = { kind: "workspace", id: "ws1", title: "Acme", text: "be brief" };
const FOLDER_LEVEL: InstructionLevel = { kind: "folder", id: "f1", title: "Contracts", text: "use UK spelling" };
const DOC_LEVEL: InstructionLevel = { kind: "document", id: "d1", title: "Q3 plan", text: "cite the source" };
const DB_LEVEL: InstructionLevel = { kind: "database", id: "db1", title: "Tasks", text: "one row per task" };

let jobs: Array<Record<string, unknown>>;
let actorCalls: string[];
const actorFetch = vi.fn(async (url: string) => {
  actorCalls.push(url);
  const body = url.includes("/runs/propose")
    ? { mode: "proposed", run: { id: "run_1", ops: [] }, pending: 1, minted: {} }
    : url.includes("/schema")
      ? { tables: [] }
      : url.includes("/markdown")
        ? { markdown: "# Q3" }
        : { inserted: 1 };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
});

function person(alias: string, role: string, over: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias,
    displayName: alias,
    isAgent: false,
    principals: [`user:${alias}`, "org:ws1"],
    workspaceId: "ws1",
    role,
    env: {
      jobs: { send: vi.fn(async (m: Record<string, unknown>) => void jobs.push(m)) },
      docs: { get: () => ({ fetch: actorFetch }) },
      databases: { get: () => ({ fetch: actorFetch }) },
      settings: { current: () => ({ databaseOpsKeep: 500 }) },
    },
    ...over,
  } as unknown as Ctx;
}

const owner = () => person("alice", "member");
const admin = () => person("carol", "admin");
const member = () => person("bob", "member");
/** Alice's key: her principals, never a manager. */
const agent = (over: Partial<Ctx> = {}) =>
  person("agent-1", "member", {
    isAgent: true,
    onBehalfOf: "alice",
    principals: ["agent:agent-1", "user:alice", "org:ws1"],
    ...over,
  } as Partial<Ctx>);
const readOnlyKey = () => agent({ scope: { folders: null, readOnly: true, credentialId: "k1" } } as Partial<Ctx>);

async function call(ctx: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`https://node.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return routeWorkspaceRequest(ctx, req);
}

const auditRows = () => jobs.filter((m) => m.kind === "audit");

beforeEach(() => {
  jobs = [];
  actorCalls = [];
  mocked(getDoc).mockReset();
  mocked(getDoc).mockImplementation(async (_sql: unknown, id: string) => (id === "db1" ? { ...DATABASE } : id === "d1" ? { ...DOC } : null));
  mocked(getFolder).mockReset();
  mocked(getFolder).mockImplementation(async (_sql: unknown, id: string) => (id === "f1" ? { ...FOLDER } : null));
  mocked(getFolderAncestors).mockClear();
  mocked(setDocAgentInstructions).mockReset();
  mocked(setDocAgentInstructions).mockImplementation(async (_sql: unknown, _id: string, text: string) => ({ ...DOC, agent_instructions: text }));
  mocked(setDocLocked).mockReset();
  mocked(setDocLocked).mockImplementation(async () => ({ ...DOC, locked: true }));
  mocked(updateFolder).mockReset();
  mocked(updateFolder).mockImplementation(async (_sql: unknown, _id: string, patch: { agentInstructions?: string; title?: string }) => ({
    ...FOLDER,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.agentInstructions !== undefined ? { agent_instructions: patch.agentInstructions } : {}),
  }));
  mocked(resolveDocInstructions).mockReset();
  mocked(resolveDocInstructions).mockImplementation(async (_sql: unknown, doc: { doc_id: string }) =>
    doc.doc_id === "db1" ? [WS_LEVEL, FOLDER_LEVEL, DB_LEVEL] : [WS_LEVEL, FOLDER_LEVEL, DOC_LEVEL],
  );
  mocked(resolveFolderInstructions).mockReset();
  mocked(resolveFolderInstructions).mockResolvedValue([WS_LEVEL, FOLDER_LEVEL]);
  mocked(createDocument).mockReset();
  actorFetch.mockClear();
});

describe("PATCH /api/docs/:id/state with agent_instructions", () => {
  it.each([
    ["the owner", owner],
    ["a workspace admin", admin],
  ])("lets %s set them, stored verbatim", async (_who, ctx) => {
    const res = await call(ctx(), "PATCH", "/api/docs/d1/state", { agent_instructions: "  new rule\n" });
    expect(res.status).toBe(200);
    expect(mocked(setDocAgentInstructions)).toHaveBeenCalledWith({}, "d1", "  new rule\n");
    // The summary never carries the text.
    expect(await res.json()).not.toHaveProperty("agent_instructions");
  });

  it("refuses a member who can edit the document but does not manage it", async () => {
    const res = await call(member(), "PATCH", "/api/docs/d1/state", { agent_instructions: "x" });
    expect(res.status).toBe(403);
    expect(mocked(setDocAgentInstructions)).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([]);
  });

  it("refuses an agent, even its owner's key", async () => {
    const res = await call(agent(), "PATCH", "/api/docs/d1/state", { agent_instructions: "x" });
    expect(res.status).toBe(403);
    expect(mocked(setDocAgentInstructions)).not.toHaveBeenCalled();
  });

  it("refuses a read-only key before the handler runs", async () => {
    const res = await call(readOnlyKey(), "PATCH", "/api/docs/d1/state", { agent_instructions: "x" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(READ_ONLY_MESSAGE);
    expect(mocked(getDoc)).not.toHaveBeenCalled();
  });

  it.each([
    ["over the limit", "x".repeat(MAX_AGENT_INSTRUCTIONS_CHARS + 1), `agent_instructions is too long (max ${MAX_AGENT_INSTRUCTIONS_CHARS} characters)`],
    ["not text", 42, "agent_instructions must be text"],
  ])("answers 400 for text %s and changes nothing, not even a lock sent alongside", async (_case, value, message) => {
    const res = await call(owner(), "PATCH", "/api/docs/d1/state", { locked: true, agent_instructions: value });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(message);
    expect(mocked(setDocLocked)).not.toHaveBeenCalled();
    expect(mocked(setDocAgentInstructions)).not.toHaveBeenCalled();
    expect(actorCalls).toEqual([]);
    expect(auditRows()).toEqual([]);
  });

  it("accepts text exactly at the limit", async () => {
    const res = await call(owner(), "PATCH", "/api/docs/d1/state", { agent_instructions: "x".repeat(MAX_AGENT_INSTRUCTIONS_CHARS) });
    expect(res.status).toBe(200);
  });

  it("records the sizes and never the text", async () => {
    await call(owner(), "PATCH", "/api/docs/d1/state", { agent_instructions: "a secret rule" });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "doc.agent_instructions",
      targetKind: "doc",
      targetId: "d1",
      targetLabel: "Q3 plan",
      detail: { chars: 13, from_chars: DOC.agent_instructions.length },
    });
    expect(JSON.stringify(rows)).not.toContain("secret rule");
  });

  it("files a database's change under the database target", async () => {
    await call(owner(), "PATCH", "/api/docs/db1/state", { agent_instructions: "one row per task" });
    expect(auditRows()[0]).toMatchObject({ action: "doc.agent_instructions", targetKind: "database", targetId: "db1" });
  });

  it("writes and records nothing when the text is unchanged", async () => {
    const res = await call(owner(), "PATCH", "/api/docs/d1/state", { agent_instructions: DOC.agent_instructions });
    expect(res.status).toBe(200);
    expect(mocked(setDocAgentInstructions)).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([]);
  });
});

describe("PATCH /api/folders/:id with agent_instructions", () => {
  it.each([
    ["the owner", owner],
    ["a workspace admin", admin],
  ])("lets %s set them, recording no rename or move", async (_who, ctx) => {
    const res = await call(ctx(), "PATCH", "/api/folders/f1", { agent_instructions: "use UK spelling" });
    expect(res.status).toBe(200);
    expect(mocked(updateFolder)).toHaveBeenCalledWith({}, "f1", { title: undefined, parentId: undefined, agentInstructions: "use UK spelling" });
    expect(await res.json()).not.toHaveProperty("agent_instructions");
    expect(auditRows()).toEqual([
      expect.objectContaining({
        action: "folder.agent_instructions",
        targetKind: "folder",
        targetId: "f1",
        detail: { chars: 15, from_chars: 0 },
      }),
    ]);
    expect(JSON.stringify(auditRows())).not.toContain("UK spelling");
  });

  it("refuses a member who does not manage the folder", async () => {
    const res = await call(member(), "PATCH", "/api/folders/f1", { agent_instructions: "x" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("only the owner or a workspace admin can change this folder");
    expect(mocked(updateFolder)).not.toHaveBeenCalled();
  });

  it("refuses an agent and a read-only key", async () => {
    expect((await call(agent(), "PATCH", "/api/folders/f1", { agent_instructions: "x" })).status).toBe(403);
    const res = await call(readOnlyKey(), "PATCH", "/api/folders/f1", { agent_instructions: "x" });
    expect(((await res.json()) as { error: string }).error).toBe(READ_ONLY_MESSAGE);
    expect(mocked(updateFolder)).not.toHaveBeenCalled();
  });

  it.each([
    ["over the limit", "x".repeat(MAX_AGENT_INSTRUCTIONS_CHARS + 1)],
    ["not text", ["a list"]],
  ])("answers 400 for text %s before any move check or write", async (_case, value) => {
    const res = await call(owner(), "PATCH", "/api/folders/f1", { title: "Renamed", parent_id: "f2", agent_instructions: value });
    expect(res.status).toBe(400);
    expect(mocked(getFolderAncestors)).not.toHaveBeenCalled();
    expect(mocked(updateFolder)).not.toHaveBeenCalled();
    expect(auditRows()).toEqual([]);
  });

  it("records a rename alone when the text is unchanged", async () => {
    await call(owner(), "PATCH", "/api/folders/f1", { title: "Deals", agent_instructions: "" });
    expect(auditRows().map((r) => r.action)).toEqual(["folder.update"]);
  });
});

describe("GET /api/docs/:id/instructions and /api/folders/:id/instructions", () => {
  it("answers the stored text, the levels above in stack order, and whether the caller may edit", async () => {
    const res = await call(owner(), "GET", "/api/docs/d1/instructions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ own: DOC.agent_instructions, inherited: [WS_LEVEL, FOLDER_LEVEL], can_edit: true });
    expect(mocked(resolveDocInstructions)).toHaveBeenCalledWith({}, expect.objectContaining({ doc_id: "d1" }), ["user:alice", "org:ws1"]);
  });

  it("keeps the whole stack as inherited when the item has no text of its own", async () => {
    mocked(resolveDocInstructions).mockResolvedValue([WS_LEVEL, FOLDER_LEVEL]);
    const body = (await (await call(owner(), "GET", "/api/docs/d1/instructions")).json()) as { inherited: InstructionLevel[] };
    expect(body.inherited).toEqual([WS_LEVEL, FOLDER_LEVEL]);
  });

  it("lets a reader who does not manage, an agent and a read-only key read, never edit", async () => {
    for (const ctx of [member(), agent(), readOnlyKey()]) {
      const res = await call(ctx, "GET", "/api/docs/d1/instructions");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { can_edit: boolean }).can_edit).toBe(false);
    }
  });

  it("answers 404 to a caller who cannot read the item", async () => {
    const stranger = person("eve", "member", { principals: ["user:eve"], workspaceId: "ws1" } as Partial<Ctx>);
    expect((await call(stranger, "GET", "/api/docs/d1/instructions")).status).toBe(404);
    expect((await call(stranger, "GET", "/api/folders/f1/instructions")).status).toBe(404);
    expect(mocked(resolveDocInstructions)).not.toHaveBeenCalled();
  });

  it("answers a folder's stack without its own level", async () => {
    mocked(getFolder).mockResolvedValue({ ...FOLDER, agent_instructions: "use UK spelling" });
    const res = await call(admin(), "GET", "/api/folders/f1/instructions");
    expect(await res.json()).toEqual({ own: "use UK spelling", inherited: [WS_LEVEL], can_edit: true });
    expect(mocked(resolveFolderInstructions)).toHaveBeenCalledWith({}, "ws1", "f1", ["user:carol", "org:ws1"]);
  });
});

describe("the stack on an agent's answers", () => {
  it("GET /api/docs/:id carries it for an agent and leaves a person's answer as it was", async () => {
    const forAgent = (await (await call(agent(), "GET", "/api/docs/d1")).json()) as Record<string, unknown>;
    expect(forAgent.instructions).toEqual([WS_LEVEL, FOLDER_LEVEL, DOC_LEVEL]);
    expect(forAgent).not.toHaveProperty("instructions_cut");
    const forPerson = (await (await call(owner(), "GET", "/api/docs/d1")).json()) as Record<string, unknown>;
    expect(forPerson).not.toHaveProperty("instructions");
    expect(forPerson).not.toHaveProperty("agent_instructions");
    expect(mocked(resolveDocInstructions)).toHaveBeenCalledTimes(1);
  });

  it("names the levels cut to fit", async () => {
    const big = (id: string): InstructionLevel => ({ kind: "folder", id, title: id, text: "x".repeat(MAX_AGENT_INSTRUCTIONS_CHARS) });
    mocked(resolveDocInstructions).mockResolvedValue([big("a"), big("b"), big("c"), DOC_LEVEL]);
    const body = (await (await call(agent(), "GET", "/api/docs/d1")).json()) as { instructions_cut?: string[] };
    expect(body.instructions_cut).toEqual(['Document "Q3 plan"']);
  });

  it("GET /api/docs/:id/markdown carries it for an agent only", async () => {
    const forAgent = (await (await call(agent(), "GET", "/api/docs/d1/markdown")).json()) as Record<string, unknown>;
    expect(forAgent).toMatchObject({ markdown: "# Q3", instructions: [WS_LEVEL, FOLDER_LEVEL, DOC_LEVEL] });
    const forPerson = await (await call(owner(), "GET", "/api/docs/d1/markdown")).json();
    expect(forPerson).toEqual({ markdown: "# Q3" });
  });

  it("GET /api/databases/:id/schema carries the database's stack for an agent only", async () => {
    const forAgent = (await (await call(agent(), "GET", "/api/databases/db1/schema")).json()) as Record<string, unknown>;
    expect(forAgent).toMatchObject({ tables: [], instructions: [WS_LEVEL, FOLDER_LEVEL, DB_LEVEL] });
    const forPerson = await (await call(owner(), "GET", "/api/databases/db1/schema")).json();
    expect(forPerson).toEqual({ tables: [], can_write: true });
  });

  it("POST /api/docs answers an agent with the new document's stack", async () => {
    mocked(createDocument).mockResolvedValue({ ok: true, doc: { ...DOC, agent_instructions: "" } });
    const forAgent = await call(agent(), "POST", "/api/docs", { title: "Q3 plan", parent_id: "f1" });
    expect(forAgent.status).toBe(201);
    expect(((await forAgent.json()) as Record<string, unknown>).instructions).toEqual([WS_LEVEL, FOLDER_LEVEL, DOC_LEVEL]);
    const forPerson = await call(owner(), "POST", "/api/docs", { title: "Q3 plan", parent_id: "f1" });
    expect(await forPerson.json()).toEqual({ ...DOC, agent_instructions: "" });
  });

  it("POST /api/docs still answers 201 with the new document when its stack cannot be read", async () => {
    // The row is committed: a 500 here would send the agent to create it again.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocked(createDocument).mockResolvedValue({ ok: true, doc: { ...DOC, agent_instructions: "" } });
    mocked(resolveDocInstructions).mockRejectedValue(new Error("statement timeout"));
    const res = await call(agent(), "POST", "/api/docs", { title: "Q3 plan", parent_id: "f1" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ doc_id: "d1", title: "Q3 plan" });
    expect(body).not.toHaveProperty("instructions");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("a database write's answer names them too", () => {
  it("carries instructions_labels for an agent and leaves a person's answer alone", async () => {
    const forAgent = await call(agent(), "POST", "/api/databases/db1/tables/tbl_1/rows", { rows: [{ name: "Alpha" }] });
    expect(forAgent.status).toBe(200);
    expect(((await forAgent.json()) as Record<string, unknown>).instructions_labels).toEqual(['Folder "Contracts"', 'Database "Tasks"']);
    const forPerson = await call(owner(), "POST", "/api/databases/db1/tables/tbl_1/rows", { rows: [{ name: "Alpha" }] });
    expect(await forPerson.json()).not.toHaveProperty("instructions_labels");
  });
});

describe("an agent's write answer names the instructions below the workspace", () => {
  const RUN = { id: "run_1", hunks: [] };
  const proposed = (doc: Record<string, unknown>) => ({ kind: "proposed", run: RUN, pending: 1, review: "review", reason: "r", doc });

  it("lists the folder and document labels, not the workspace's", async () => {
    mocked(proposeDocEdit).mockResolvedValue(proposed({ ...DOC }));
    const res = await call(agent(), "POST", "/api/docs/d1/propose", { action: "append", text: "note" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).instructions_labels).toEqual(['Folder "Contracts"', 'Document "Q3 plan"']);
  });

  it("adds nothing when only the workspace's apply, or when the lookup fails", async () => {
    mocked(proposeDocEdit).mockResolvedValue(proposed({ ...DOC }));
    mocked(resolveDocInstructions).mockResolvedValue([WS_LEVEL]);
    const onlyWorkspace = await call(agent(), "POST", "/api/docs/d1/propose", { action: "append", text: "note" });
    expect(await onlyWorkspace.json()).not.toHaveProperty("instructions_labels");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocked(resolveDocInstructions).mockRejectedValue(new Error("statement timeout"));
    const failed = await call(agent(), "POST", "/api/docs/d1/propose", { action: "append", text: "note" });
    // The edit is already proposed: the answer stays a success.
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ mode: "proposed", run: RUN });
    warn.mockRestore();
  });
});
