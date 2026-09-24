import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./server.js";
import type { ResolvedConfig } from "./config.js";
import { TOOL_NAMES, toolDefinition } from "@stuga/agent-surface/catalog";

/** One request the server made, as the node would have seen it. */
interface Seen {
  method: string;
  path: string;
  body: string | FormData | null;
  headers: Headers;
}

/** A node that answers from a script, and records what it was asked. */
function nodeFake(routes: Record<string, { status?: number; body?: unknown }>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
    seen.push({
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: (init?.body as string | FormData | undefined) ?? null,
      headers: new Headers(init?.headers),
    });
    const hit = routes[key] ?? routes[`${init?.method ?? "GET"} ${url.pathname}`];
    if (!hit) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return new Response(hit.body === undefined ? "" : JSON.stringify(hit.body), {
      status: hit.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { seen, fetchImpl };
}

const CONFIG = { url: "http://node.test", token: "vk_test", client: "stuga-mcp", version: "0.0.0-dev" };

/** A connected client + the request log, for one scripted node. */
async function connect(routes: Record<string, { status?: number; body?: unknown }> = {}) {
  return connectTo(nodeFake(routes));
}

async function connectTo({ seen, fetchImpl }: ReturnType<typeof nodeFake>) {
  const server = buildServer({ config: CONFIG, fetch: fetchImpl });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };
    return { text: res.content?.[0]?.text ?? "", isError: res.isError === true };
  };
  return { client, call, seen };
}

describe("the registered surface", () => {
  it("answers tools/list with the catalog's tools, in order", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
  });

  it("gives every tool a description and an input schema", async () => {
    const { client } = await connect();
    for (const tool of (await client.listTools()).tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema, tool.name).toBeTruthy();
    }
  });
});

describe("every call carries the credential", () => {
  it("sends the bearer token and the workspace hint on a plain read", async () => {
    const { seen, call } = await connect({ "GET /api/folders": { body: { folders: [] } } });
    await call("folders");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer vk_test");
  });

  it("sends x-stuga-workspace only when one was configured", async () => {
    const { seen, fetchImpl } = nodeFake({ "GET /api/folders": { body: { folders: [] } } });
    const server = buildServer({ config: { ...CONFIG, workspace: "ws-1" }, fetch: fetchImpl });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    await client.callTool({ name: "folders", arguments: {} });
    expect(seen[0]!.headers.get("x-stuga-workspace")).toBe("ws-1");

    const plain = await connect({ "GET /api/folders": { body: { folders: [] } } });
    await plain.call("folders");
    expect(plain.seen[0]!.headers.get("x-stuga-workspace")).toBeNull();
  });
});

describe("docs", () => {
  const list = { "GET /api/docs": { body: { docs: [{ doc_id: "d1", title: "Notes", doc_type: "prose" }] } } };

  it("keeps parent_id's three states distinct: omitted, the root, a folder", async () => {
    const { seen, call } = await connect({ ...list, "GET /api/docs?parent_id=": list["GET /api/docs"], "GET /api/docs?parent_id=f1": list["GET /api/docs"] });
    await call("docs", { action: "list" });
    await call("docs", { action: "list", parent_id: null });
    await call("docs", { action: "list", parent_id: "f1" });
    expect(seen.map((s) => s.path)).toEqual(["/api/docs", "/api/docs?parent_id=", "/api/docs?parent_id=f1"]);
  });

  it("carries doc_type into the listing, so a database is not read as prose", async () => {
    const { call } = await connect(list);
    const out = JSON.parse((await call("docs", { action: "list" })).text) as { docs: Array<{ doc_type?: string }> };
    expect(out.docs[0]!.doc_type).toBe("prose");
  });

  it("refuses an empty search rather than asking the node for everything", async () => {
    const { seen, call } = await connect();
    const res = await call("docs", { action: "search", q: "   " });
    expect(res.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });
});

describe("retrieve", () => {
  it("returns citable passages with a link to each source", async () => {
    const { call } = await connect({
      "POST /api/retrieve": {
        body: { chunks: [{ doc_id: "d1", title: "Handbook", content: "…", heading_path: "A > B" }], degraded: false },
      },
    });
    const out = JSON.parse((await call("retrieve", { q: "x" })).text) as { passages: Array<{ url?: string }> };
    expect(out.passages[0]!.url).toBe("http://node.test/doc/d1");
  });

  it("says retrieval is off instead of reporting an empty result as no match", async () => {
    const { call } = await connect({ "POST /api/retrieve": { body: { chunks: [], ai_disabled: true } } });
    const res = await call("retrieve", { q: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^error: AI chat is disabled on this node/);
  });

  it("claims an unreachable collection only when the node reports one", async () => {
    const bare = await connect({ "POST /api/retrieve": { body: { chunks: [] } } });
    expect(JSON.parse((await bare.call("retrieve", { q: "x", collection_id: "c1" })).text)).not.toHaveProperty("note");

    const flagged = await connect({ "POST /api/retrieve": { body: { chunks: [], empty_scope: true } } });
    expect((await flagged.call("retrieve", { q: "x", collection_id: "c1" })).text).toContain("ask the workspace owner");
  });
});

describe("collections", () => {
  it("manages the person's collections through the node's collection routes", async () => {
    const row = { collection_id: "c1", workspace_id: "ws1", owner: "liv", name: "Research", created_at: "", updated_at: "" };
    const { seen, call } = await connect({
      "GET /api/collections": { body: { collections: [{ ...row, item_count: 1 }] } },
      "GET /api/collections/c1": { body: { collection: row, items: [{ doc_id: "d1", folder_id: null, title: "Doc", added_at: "" }] } },
      "POST /api/collections": { status: 201, body: { ...row, name: "Launch" } },
      "PATCH /api/collections/c1": { body: { ...row, name: "Renamed" } },
      "DELETE /api/collections/c1": { body: { deleted: true } },
      "POST /api/collections/c1/items": { status: 201, body: { added: 1, skipped: 1 } },
      "DELETE /api/collections/c1/items": { body: { removed: 1 } },
    });
    expect(JSON.parse((await call("collections", { action: "list" })).text)).toEqual({ collections: [{ collection_id: "c1", name: "Research", item_count: 1 }] });
    expect(JSON.parse((await call("collections", { action: "open", collection_id: "c1" })).text)).toEqual({
      collection_id: "c1",
      name: "Research",
      items: [{ doc_id: "d1", title: "Doc" }],
    });
    expect(JSON.parse((await call("collections", { action: "create", name: "Launch" })).text)).toEqual({ collection_id: "c1", name: "Launch" });
    await call("collections", { action: "rename", collection_id: "c1", name: "Renamed" });
    await call("collections", { action: "delete", collection_id: "c1" });
    const added = JSON.parse((await call("collections", { action: "add_items", collection_id: "c1", doc_ids: ["d1", "d2"] })).text);
    expect(added).toMatchObject({ added: 1, skipped: 1 });
    expect(added.note).toContain("not readable by this connector");
    await call("collections", { action: "remove_items", collection_id: "c1", folder_ids: ["f1"] });

    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /api/collections",
      "GET /api/collections/c1",
      "POST /api/collections",
      "PATCH /api/collections/c1",
      "DELETE /api/collections/c1",
      "POST /api/collections/c1/items",
      "DELETE /api/collections/c1/items",
    ]);
    expect(JSON.parse(seen[2]!.body as string)).toEqual({ name: "Launch" });
    expect(JSON.parse(seen[3]!.body as string)).toEqual({ name: "Renamed" });
    expect(JSON.parse(seen[5]!.body as string)).toEqual({ doc_ids: ["d1", "d2"], folder_ids: [] });
    expect(JSON.parse(seen[6]!.body as string)).toEqual({ doc_ids: [], folder_ids: ["f1"] });
  });

  it("passes the node's refusal through", async () => {
    const { call } = await connect({ "PATCH /api/collections/c1": { status: 403, body: { error: "this key is read-only: it can read and search, but not change anything" } } });
    expect(await call("collections", { action: "rename", collection_id: "c1", name: "x" })).toEqual({
      isError: true,
      text: "error: this key is read-only: it can read and search, but not change anything",
    });
  });
});

describe("media", () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

  it("uploads as multipart, with the type sniffed from the bytes and no JSON content-type", async () => {
    const { seen, call } = await connect({
      "POST /api/docs/d1/media": { status: 201, body: { url: "/api/docs/d1/media/h", hash: "h", size: 16, mime: "image/png" } },
    });
    const res = await call("media", { doc_id: "d1", action: "upload", data: png.toString("base64"), alt: "chart", caption: "Figure 1" });
    expect(seen[0]!.body).toBeInstanceOf(FormData);
    const file = (seen[0]!.body as FormData).get("file") as File;
    expect(file.type).toBe("image/png");
    expect(seen[0]!.headers.get("content-type")).toBeNull();
    const [json, note] = res.text.split("\n");
    expect(JSON.parse(json!)).toMatchObject({ markdown: '![chart](/api/docs/d1/media/h "Figure 1")' });
    expect(note).toContain("uploading does not place the image by itself");
  });

  it("refuses bytes that are not an image the node stores, without a round trip", async () => {
    const { seen, call } = await connect();
    const res = await call("media", { doc_id: "d1", action: "upload", data: Buffer.from("<svg/>").toString("base64") });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("SVG is not accepted");
    expect(seen).toHaveLength(0);
  });
});

describe("databases", () => {
  const schema = {
    "GET /api/databases/db1/schema": {
      body: { database_id: "db1", tables: [{ table_id: "t1", name: "tasks", display: "Tasks", columns: [] }] },
    },
  };

  it("resolves a table by display name before writing to it", async () => {
    const { seen, call } = await connect({
      ...schema,
      "POST /api/databases/db1/tables/t1/rows": { body: { mode: "proposed", run: { id: "run_1" }, pending: 1, minted: { row_ids: ["r1"] } } },
    });
    const res = await call("databases", { action: "insert_rows", database_id: "db1", table: "Tasks", rows: [{ Name: "a" }] });
    expect(seen.map((s) => s.path)).toEqual(["/api/databases/db1/schema", "/api/databases/db1/tables/t1/rows"]);
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Do NOT retry");
    expect(JSON.parse(res.text)).toMatchObject({ row_ids: ["r1"] });
  });

  it("hands back the node's own refusal, not a thrown request line", async () => {
    const { call } = await connect({
      ...schema,
      "POST /api/databases/db1/tables/t1/rows": { status: 423, body: { error: "this database is locked; unlock it to make changes" } },
    });
    const res = await call("databases", { action: "insert_rows", database_id: "db1", table: "Tasks", rows: [{ Name: "a" }] });
    expect(res.isError).toBe(true);
    expect(res.text).toBe("error: this database is locked; unlock it to make changes");
  });

  it("open_page resolves the table, posts to the row's page route and points at the markdown tool", async () => {
    const { seen, call } = await connect({
      ...schema,
      "POST /api/databases/db1/tables/t1/rows/r1/page": { body: { doc_id: "d9", created: true } },
    });
    const res = await call("databases", { action: "open_page", database_id: "db1", table: "Tasks", row_id: "r1" });
    expect(seen.map((s) => s.path)).toEqual(["/api/databases/db1/schema", "/api/databases/db1/tables/t1/rows/r1/page"]);
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toMatchObject({ doc_id: "d9", created: true });
    expect(res.text).toContain("markdown");
  });

  it("normalizes a boolean bind, which the actor would refuse", async () => {
    const { seen, call } = await connect({ "POST /api/databases/db1/query": { body: { rows: [] } } });
    await call("query", { database_id: "db1", sql: "SELECT 1 WHERE done = ?", params: [true] });
    expect(JSON.parse(seen[0]!.body as string)).toMatchObject({ params: [1] });
  });
});

describe("workspaces", () => {
  it("reports the workspace the node resolved, not the one that was configured", async () => {
    const { seen, fetchImpl } = nodeFake({
      "GET /api/whoami": { body: { alias: "agent:a1", display_name: "Claude", workspace_id: "ws-real" } },
      "GET /api/workspaces": { status: 403, body: { error: "agents cannot manage workspaces" } },
    });
    const server = buildServer({ config: { ...CONFIG, workspace: "ws-wished-for" }, fetch: fetchImpl });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = (await client.callTool({ name: "workspaces", arguments: { action: "list" } })) as { content: Array<{ text: string }> };
    const out = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    expect(out.workspace_id).toBe("ws-real");
    expect(out).not.toHaveProperty("reachable");
    expect(seen.map((s) => s.path)).toEqual(["/api/whoami", "/api/workspaces"]);
  });

  it("lists what a human token can reach", async () => {
    const { call } = await connect({
      "GET /api/whoami": { body: { alias: "user-liv", display_name: "Liv", workspace_id: "ws1" } },
      "GET /api/workspaces": { body: { workspaces: [{ workspace_id: "ws1", name: "Home", role: "owner" }] } },
    });
    const out = JSON.parse((await call("workspaces", { action: "list" })).text) as { reachable?: Array<{ name: string }> };
    expect(out.reachable).toEqual([{ workspace_id: "ws1", name: "Home", role: "owner" }]);
  });

  it("names the node the workspace is on", async () => {
    const { call } = await connect({ "GET /api/whoami": { body: { alias: "agent:a1", workspace_id: "ws1" } } });
    const out = JSON.parse((await call("workspaces", { action: "list" })).text) as Record<string, unknown>;
    expect(out.node).toEqual({ name: "node.test", origin: "http://node.test" });
  });
});

describe("which node this server is", () => {
  /** The handshake a client sees from a server built for `node`. */
  async function handshake(node?: { name: string; origin: string }, config: ResolvedConfig = CONFIG) {
    const server = buildServer({ config, ...(node ? { node } : {}), fetch: nodeFake({}).fetchImpl });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { info: client.getServerVersion(), instructions: client.getInstructions() ?? "" };
  }

  it("keeps one product title and names each server's own node in its first line", async () => {
    const liv = await handshake({ name: "Liv’s Mac", origin: "http://localhost:8787" });
    const studio = await handshake({ name: "Studio", origin: "https://studio.example" });
    expect(liv.info).toMatchObject({ name: "stuga", title: "Stuga" });
    expect(studio.info).toMatchObject({ name: "stuga", title: "Stuga" });
    expect(liv.instructions.split("\n")[0]).toBe(
      'This connection is to the Stuga node "Liv’s Mac" at http://localhost:8787. `workspaces` action:list names every workspace you can reach and the node each is on.',
    );
    expect(studio.instructions.startsWith('This connection is to the Stuga node "Studio" at https://studio.example.')).toBe(true);
  });

  it("falls back to what the config carries when nothing looked the node up", async () => {
    expect((await handshake(undefined, { ...CONFIG, nodeName: "Liv’s Mac" })).info?.title).toBe("Stuga");
    expect((await handshake()).instructions.startsWith('This connection is to the Stuga node "node.test" at http://node.test.')).toBe(true);
  });
});

describe("append, provenance, instructions and events", () => {
  it("append posts the heading along with the text", async () => {
    const { seen, call } = await connect({
      "POST /api/docs/d1/propose": { body: { mode: "proposed", run: { id: "run_a", hunks: [] }, pending: 1, review: "review", reason: "this document waits for review" } },
    });
    const out = await call("markdown", { doc_id: "d1", action: "append", text: "- note", heading: "Log" });
    expect(JSON.parse(seen[0]!.body as string)).toMatchObject({ action: "append", text: "- note", heading: "Log" });
    expect(out.text).toContain("waiting for the user to accept it (this document waits for review)");
    expect(out.text).toContain("run_a");
  });

  it("append without text is refused before any request", async () => {
    const { seen, call } = await connect();
    const out = await call("markdown", { doc_id: "d1", action: "append" });
    expect(out.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("provenance renders unreviewed passages first", async () => {
    const { call } = await connect({
      "GET /api/docs/d1/provenance": {
        body: {
          passages: [
            { run_id: "run_1", agent: "A", agent_alias: "agent-a", landed: "accepted", reviewed: true, excerpt: "fine" },
            { run_id: "run_2", agent: "B", agent_alias: "agent-b", landed: "auto_applied", reviewed: false, excerpt: "unchecked" },
          ],
          pending_runs: 1,
        },
      },
    });
    const out = await call("markdown", { doc_id: "d1", action: "provenance" });
    expect(out.text.indexOf("unchecked")).toBeLessThan(out.text.indexOf("fine"));
    expect(out.text).toContain("NOT yet reviewed");
    expect(out.text).toContain("1 run(s) still have proposals");
  });

  it("workspaces action:instructions reads the conventions", async () => {
    const { call } = await connect({ "GET /api/instructions": { body: { workspace_id: "ws1", name: "W", instructions: "Notes go in Journal/." } } });
    const out = await call("workspaces", { action: "instructions" });
    expect(JSON.parse(out.text)).toMatchObject({ instructions: "Notes go in Journal/." });
  });

  it("events without a cursor starts from the newest id, then reads from it", async () => {
    const { seen, call } = await connect({
      "GET /api/events?limit=1&after=0": { body: { events: [], cursor: 0, latest: 41 } },
      "GET /api/events?after=41": { body: { events: [{ id: 42, type: "run.decided" }], cursor: 42, latest: 42 } },
    });
    const out = await call("events", {});
    expect(seen.map((s) => s.path)).toEqual(["/api/events?limit=1&after=0", "/api/events?after=41"]);
    expect(JSON.parse(out.text)).toMatchObject({ cursor: 42 });
  });

  it("events with a cursor and types goes straight to the feed", async () => {
    const { seen, call } = await connect({ "GET /api/events": { body: { events: [], cursor: 5, latest: 5 } } });
    await call("events", { after: 5, types: ["comment.added"], limit: 10 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/api/events?types=comment.added&limit=10&after=5");
  });
});

describe("run labels", () => {
  it("names its client on every call and sends the model label only when configured", async () => {
    const { seen, fetchImpl } = nodeFake({ "GET /api/folders": { body: { folders: [] } } });
    const server = buildServer({ config: { ...CONFIG, client: "claude-desktop", model: "claude-opus" }, fetch: fetchImpl });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    await client.callTool({ name: "folders", arguments: {} });
    expect(seen[0]!.headers.get("x-stuga-client")).toBe("claude-desktop");
    expect(seen[0]!.headers.get("x-stuga-model")).toBe("claude-opus");

    const plain = await connect({ "GET /api/folders": { body: { folders: [] } } });
    await plain.call("folders");
    expect(plain.seen[0]!.headers.get("x-stuga-client")).toBe("stuga-mcp");
    expect(plain.seen[0]!.headers.get("x-stuga-model")).toBeNull();
  });
});

describe("databases: bulk data stays out of the model", () => {
  const schema = {
    "GET /api/databases/db1/schema": {
      body: { database_id: "db1", tables: [{ table_id: "t1", name: "bookings", display: "Bookings", columns: [] }] },
    },
  };
  const ticket = {
    import_id: "imp_1",
    table_id: "t1",
    format: "csv",
    upload_url: "https://public.test/api/databases/db1/imports/imp_1/upload?sig=abc",
    upload_path: "/api/databases/db1/imports/imp_1/upload?sig=abc",
    upload_method: "PUT",
    max_bytes: 1000,
    expires_at: "2026-09-06T00:00:00Z",
    review: "review",
    import_page_url: "https://public.test/doc/db1?table=t1&import",
  };
  const committed = {
    import_id: "imp_1",
    mode: "proposed",
    rows_total: 2,
    rows_ingested: 2,
    rows_skipped: 0,
    errors: [],
    errors_truncated: false,
    ignored_columns: [],
    run: { id: "run_1" },
    pending: 1,
  };

  /** A connected client whose server reads files from a scripted disk. */
  async function connectWithFiles(routes: Record<string, { status?: number; body?: unknown }>, files: Record<string, string>) {
    const { seen, fetchImpl } = nodeFake(routes);
    const server = buildServer({
      config: CONFIG,
      fetch: fetchImpl,
      readFile: async (path) => {
        if (!(path in files)) throw new Error("ENOENT: no such file");
        return new TextEncoder().encode(files[path]!);
      },
    });
    const client = new Client({ name: "test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
      return { text: res.content?.[0]?.text ?? "", isError: res.isError === true };
    };
    return { seen, call };
  }

  it("import with `file` stages, uploads without the bearer, and commits in one call", async () => {
    const { seen, call } = await connectWithFiles(
      {
        ...schema,
        "POST /api/databases/db1/imports": { status: 201, body: ticket },
        "PUT /api/databases/db1/imports/imp_1/upload?sig=abc": { status: 201, body: { import_id: "imp_1", bytes: 20 } },
        "POST /api/databases/db1/imports/imp_1/commit": { body: committed },
      },
      { "/tmp/rows.csv": "ref,rate\nB1,1\nB2,2\n" },
    );
    const res = await call("databases", { action: "import", database_id: "db1", table: "Bookings", file: "/tmp/rows.csv", on_error: "skip_bad_rows" });
    expect(res.isError).toBe(false);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /api/databases/db1/schema",
      "POST /api/databases/db1/imports",
      "PUT /api/databases/db1/imports/imp_1/upload?sig=abc",
      "POST /api/databases/db1/imports/imp_1/commit",
    ]);
    expect(JSON.parse(seen[1]!.body as string)).toEqual({ table_id: "t1", format: "csv" });
    expect(seen[2]!.headers.get("authorization")).toBeNull();
    expect(JSON.parse(seen[3]!.body as string)).toMatchObject({ on_error: "skip_bad_rows" });
    expect(res.text).toContain("Proposed — the import of 2 rows is ONE change");
    expect(res.text).toContain("do NOT retry");
    expect(JSON.parse(res.text)).toMatchObject({ rows_ingested: 2, run_id: "run_1" });
  });

  it("hands back the node's row-level report on a refused commit, and says the staging survives", async () => {
    const { call } = await connectWithFiles(
      {
        ...schema,
        "POST /api/databases/db1/imports": { status: 201, body: ticket },
        "PUT /api/databases/db1/imports/imp_1/upload?sig=abc": { status: 201, body: { import_id: "imp_1", bytes: 20 } },
        "POST /api/databases/db1/imports/imp_1/commit": {
          status: 422,
          body: {
            error: "import_validation_failed",
            message: "1 of 2 rows failed validation; nothing was loaded",
            rows_total: 2,
            rows_failed: 1,
            errors: [{ row: 2, column: "rate", value: "n/a", code: "invalid_number", message: "expected a number" }],
            errors_truncated: false,
            ignored_columns: [],
          },
        },
      },
      { "/tmp/rows.csv": "ref,rate\nB1,1\nB2,n/a\n" },
    );
    const res = await call("databases", { action: "import", database_id: "db1", table: "Bookings", file: "/tmp/rows.csv" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("nothing was loaded");
    expect(res.text).toContain("do NOT re-send the data");
    expect(res.text).toContain('"code":"invalid_number"');
  });

  it("import with `content` carries the file's text itself through the same staged import", async () => {
    const { seen, call } = await connect({
      ...schema,
      "POST /api/databases/db1/imports": { status: 201, body: ticket },
      "PUT /api/databases/db1/imports/imp_1/upload?sig=abc": { status: 201, body: { import_id: "imp_1", bytes: 20 } },
      "POST /api/databases/db1/imports/imp_1/commit": { body: committed },
    });
    const res = await call("databases", { action: "import", database_id: "db1", table: "Bookings", content: "ref,rate\nB1,1\nB2,2\n" });
    expect(res.isError).toBe(false);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /api/databases/db1/schema",
      "POST /api/databases/db1/imports",
      "PUT /api/databases/db1/imports/imp_1/upload?sig=abc",
      "POST /api/databases/db1/imports/imp_1/commit",
    ]);
    expect(res.text).toContain("Proposed — the import of 2 rows is ONE change");
  });

  it("hands an unreadable file to the user with the link, instead of trying another way", async () => {
    const { call } = await connectWithFiles(
      { ...schema, "POST /api/databases/db1/imports": { status: 201, body: ticket } },
      { "/tmp/rows.parquet": "x" },
    );
    const missing = await call("databases", { action: "import", database_id: "db1", table: "Bookings", file: "/home/claude/rows.csv" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("Could not read /home/claude/rows.csv");
    expect(missing.text).toContain(ticket.import_page_url);
    expect(missing.text).toContain("do NOT fall back to insert_rows");
    const unknown = await call("databases", { action: "import", database_id: "db1", table: "Bookings", file: "/tmp/rows.parquet" });
    expect(unknown.text).toContain("pass format");
    const neither = await call("databases", { action: "import", database_id: "db1", table: "Bookings" });
    expect(neither.text).toContain("requires `file`");
    const rowsOnly = await call("databases", { action: "insert_rows", database_id: "db1", table: "Bookings", file: "/tmp/rows.csv" });
    expect(rowsOnly.text).toContain("action:import");
  });

  it("steers a full insert_rows batch to import", async () => {
    const { call } = await connect({
      ...schema,
      "POST /api/databases/db1/tables/t1/rows": { body: { mode: "applied", run: { id: "run_1" } } },
    });
    const many = Array.from({ length: 200 }, (_, i) => ({ ref: `B${i}` }));
    const big = await call("databases", { action: "insert_rows", database_id: "db1", table: "Bookings", rows: many });
    expect(big.isError).toBe(false);
    expect(big.text).toContain("do NOT send another insert_rows batch");
    expect(big.text).toContain("action:import");
    const small = await call("databases", { action: "insert_rows", database_id: "db1", table: "Bookings", rows: [{ ref: "B1" }] });
    expect(small.text).not.toContain("do NOT send another insert_rows batch");
  });

  it("retries a refused import by id, without re-sending a byte", async () => {
    const { seen, call } = await connect({
      ...schema,
      "POST /api/databases/db1/imports/imp_1/commit": { body: { ...committed, rows_skipped: 2 } },
    });
    const res = await call("databases", { action: "import", database_id: "db1", import_id: "imp_1", on_error: "skip_bad_rows" });
    expect(res.isError).toBe(false);
    expect(seen.map((x) => `${x.method} ${x.path}`)).toEqual(["POST /api/databases/db1/imports/imp_1/commit"]);
    expect(JSON.parse(seen[0]!.body as string)).toMatchObject({ on_error: "skip_bad_rows" });
  });

  it("create_table with columns is one request carrying the whole schema", async () => {
    const { seen, call } = await connect({
      "POST /api/databases/db1/tables": { body: { mode: "proposed", run: { id: "run_1" }, pending: 3, minted: { table_id: "t9", column_ids: ["c1", "c2"] } } },
    });
    const res = await call("databases", {
      action: "create_table",
      database_id: "db1",
      name: "Guests",
      columns: [
        { name: "Guest", type: "text" },
        { name: "Tier", type: "single_select", choices: ["Gold"] },
      ],
    });
    expect(res.isError).toBe(false);
    expect(JSON.parse(seen[0]!.body as string)).toEqual({
      display: "Guests",
      columns: [
        { name: "Guest", type: "text" },
        { name: "Tier", type: "single_select", choices: ["Gold"] },
      ],
    });
    expect(JSON.parse(res.text)).toMatchObject({ table_id: "t9", column_ids: ["c1", "c2"] });
  });

  it("create_database passes the starter table's name and columns, and reports the table it was born with", async () => {
    const { seen, call } = await connect({
      "POST /api/docs": { status: 201, body: { doc_id: "db9", title: "Hotel" } },
      "GET /api/databases/db9/schema": {
        body: { database_id: "db9", tables: [{ table_id: "t1", name: "bookings", display: "Bookings", columns: [{ column_id: "c1", name: "ref", type: "text" }] }] },
      },
    });
    const res = await call("databases", { action: "create_database", title: "Hotel", table: "Bookings", columns: [{ name: "Ref", type: "text" }] });
    expect(JSON.parse(seen[0]!.body as string)).toEqual({ title: "Hotel", doc_type: "database", table: "Bookings", columns: [{ name: "Ref", type: "text" }] });
    expect(JSON.parse(res.text)).toEqual({ database_id: "db9", title: "Hotel", table_id: "t1", table: "bookings", columns: [{ column_id: "c1", name: "ref", type: "text" }] });
  });
});

describe("instructions for agents", () => {
  const instructions = [
    { kind: "workspace", id: "ws1", title: "Acme", text: "Write in British English." },
    { kind: "folder", id: "f1", title: "Contracts", text: "Cite the clause number." },
  ];
  const cut = ['Document "Q3"'];

  it("passes the node's stack through metadata, create and schema untouched", async () => {
    const { call } = await connect({
      "GET /api/docs/d1": { body: { doc_id: "d1", title: "Q3", review: { mode: "review" }, instructions, instructions_cut: cut } },
      "POST /api/docs": { status: 201, body: { doc_id: "d2", title: "Notes", owner: "user:human-1", instructions } },
      "GET /api/databases/db1/schema": { body: { database_id: "db1", tables: [], instructions } },
    });
    expect(JSON.parse((await call("docs", { action: "metadata", doc_id: "d1" })).text)).toMatchObject({ instructions, instructions_cut: cut });
    expect(JSON.parse((await call("docs", { action: "create", title: "Notes" })).text)).toEqual({ doc_id: "d2", title: "Notes", instructions });
    expect(JSON.parse((await call("databases", { action: "schema", database_id: "db1" })).text)).toEqual({ database_id: "db1", tables: [], instructions });
  });

  it("renders the stack above the markdown a read returns", async () => {
    const { call } = await connect({
      "GET /api/docs/d1/markdown": { body: { markdown: "# Q3\n\nbody", run_id: null, pending: 0, instructions, instructions_cut: cut } },
    });
    const { text } = await call("markdown", { doc_id: "d1", action: "read" });
    expect(text).toMatch(/^=== INSTRUCTIONS FOR THIS DOCUMENT \(not part of its text\) ===\n/);
    expect(text).toContain('--- Workspace "Acme" ---\nWrite in British English.\n--- Folder "Contracts" ---\nCite the clause number.\n');
    expect(text).toContain('Cut short or left out to fit: Document "Q3".');
    expect(text.endsWith("===\n\n# Q3\n\nbody")).toBe(true);
  });

  it("create_database reports the stack the node placed the database under", async () => {
    const { call } = await connect({
      "POST /api/docs": { status: 201, body: { doc_id: "db9", title: "Hotel", instructions } },
      "GET /api/databases/db9/schema": { body: { database_id: "db9", tables: [], instructions } },
    });
    const res = await call("databases", { action: "create_database", title: "Hotel" });
    expect(JSON.parse(res.text)).toEqual({ database_id: "db9", title: "Hotel", instructions });
  });
});

describe("a read-only key", () => {
  const READ_ONLY = "this key is read-only: it can read and search, but not change anything";
  const SCHEMA = {
    database_id: "db1",
    tables: [
      {
        table_id: "t1",
        name: "tasks",
        display: "Tasks",
        position: 0,
        row_count: 1,
        columns: [{ column_id: "c1", name: "name", display: "Name", type: "text", position: 0, options: null }],
        views: [{ view_id: "v1", table_id: "t1", kind: "table", name: "Open", position: 0, filter: null, sorts: [], group_by: null, hidden_columns: [], config: {} }],
      },
    ],
  };
  const DOC = { doc_id: "d1", title: "Notes", doc_type: "prose", parent_id: null, updated_at: "" };
  const COLLECTION = { collection_id: "c1", workspace_id: "ws1", owner: "liv", name: "Research", created_at: "", updated_at: "" };

  /** A node that answers a read-only key as the node's route table does: reads answer, every change is refused. */
  function readOnlyNode(): ReturnType<typeof nodeFake> {
    const reads: Record<string, unknown> = {
      "GET /api/whoami": { workspace_id: "ws1", alias: "agent-1", display_name: "Scout", scope: { folders: null, read_only: true } },
      "GET /api/instructions": { workspace_id: "ws1", name: "io", instructions: "" },
      "GET /api/docs": { docs: [DOC, { ...DOC, doc_id: "db1", doc_type: "database" }] },
      "GET /api/docs/d1": DOC,
      "GET /api/docs/d1/markdown": { markdown: "body" },
      "GET /api/docs/d1/runs": { runs: [] },
      "GET /api/docs/d1/provenance": { passages: [], pending_runs: 0 },
      "GET /api/docs/d1/comments": { comments: [] },
      "GET /api/folders": { folders: [] },
      "GET /api/events": { events: [], cursor: 0, latest: 0 },
      "GET /api/collections": { collections: [] },
      "GET /api/collections/c1": { collection: COLLECTION, items: [] },
      "GET /api/databases/db1/schema": SCHEMA,
      "GET /api/databases/db1/runs": { runs: [] },
      "POST /api/search": { query: "launch", results: [], degraded: false, semantic: false },
      "POST /api/retrieve": { chunks: [], degraded: false },
      "POST /api/databases/db1/query": { columns: ["n"], rows: [{ n: 1 }], truncated: false },
      "POST /api/databases/db1/tables/t1/rows/r1/page": { doc_id: "page1", created: false },
    };
    const fake = nodeFake({});
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      await fake.fetchImpl(input, init);
      const method = init?.method ?? "GET";
      const key = `${method} ${new URL(String(input)).pathname}`;
      if (key in reads) return new Response(JSON.stringify(reads[key]), { status: 200 });
      if (method === "GET") return new Response(JSON.stringify({ error: "agents cannot manage workspaces" }), { status: 403 });
      return new Response(JSON.stringify({ error: READ_ONLY }), { status: 403 });
    }) as typeof globalThis.fetch;
    return { seen: fake.seen, fetchImpl };
  }

  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
  const CALLS: Array<[tool: string, args: Record<string, unknown>, verdict: "reads" | "refused"]> = [
    ["workspaces", { action: "list" }, "reads"],
    ["workspaces", { action: "instructions" }, "reads"],
    ["docs", { action: "list" }, "reads"],
    ["docs", { action: "search", q: "launch" }, "reads"],
    ["docs", { action: "metadata", doc_id: "d1" }, "reads"],
    ["docs", { action: "create", title: "New" }, "refused"],
    ["markdown", { action: "read", doc_id: "d1" }, "reads"],
    ["markdown", { action: "write", doc_id: "d1", text: "x" }, "refused"],
    ["markdown", { action: "str_replace", doc_id: "d1", find: "a", replace: "b" }, "refused"],
    ["markdown", { action: "append", doc_id: "d1", text: "x" }, "refused"],
    ["markdown", { action: "cited_edits", doc_id: "d1", edits: [{ old_string: "a", new_string: "b" }] }, "refused"],
    ["markdown", { action: "status", doc_id: "d1" }, "reads"],
    ["markdown", { action: "provenance", doc_id: "d1" }, "reads"],
    ["media", { action: "upload", doc_id: "d1", data: PNG }, "refused"],
    ["comments", { action: "list", doc_id: "d1" }, "reads"],
    ["comments", { action: "add", doc_id: "d1", body: "Looks good" }, "refused"],
    ["folders", {}, "reads"],
    ["events", {}, "reads"],
    ["collections", { action: "list" }, "reads"],
    ["collections", { action: "open", collection_id: "c1" }, "reads"],
    ["collections", { action: "create", name: "x" }, "refused"],
    ["collections", { action: "rename", collection_id: "c1", name: "x" }, "refused"],
    ["collections", { action: "delete", collection_id: "c1" }, "refused"],
    ["collections", { action: "add_items", collection_id: "c1", doc_ids: ["d1"] }, "refused"],
    ["collections", { action: "remove_items", collection_id: "c1", doc_ids: ["d1"] }, "refused"],
    ["retrieve", { q: "launch" }, "reads"],
    ["databases", { action: "list" }, "reads"],
    ["databases", { action: "schema", database_id: "db1" }, "reads"],
    ["databases", { action: "status", database_id: "db1" }, "reads"],
    ["databases", { action: "create_database", title: "New" }, "refused"],
    ["databases", { action: "create_table", database_id: "db1", name: "Projects" }, "refused"],
    ["databases", { action: "add_column", database_id: "db1", table: "tasks", name: "Due", type: "date" }, "refused"],
    ["databases", { action: "insert_rows", database_id: "db1", table: "tasks", rows: [{ name: "x" }] }, "refused"],
    ["databases", { action: "update_rows", database_id: "db1", table: "tasks", updates: [{ _id: "r1", values: { name: "y" } }] }, "refused"],
    ["databases", { action: "delete_rows", database_id: "db1", table: "tasks", row_ids: ["r1"] }, "refused"],
    ["databases", { action: "import", database_id: "db1", table: "tasks", content: "name\nx\n" }, "refused"],
    ["databases", { action: "create_view", database_id: "db1", table: "tasks", name: "Mine" }, "refused"],
    ["databases", { action: "update_view", database_id: "db1", table: "tasks", view: "Open", name: "Closed" }, "refused"],
    ["databases", { action: "open_page", database_id: "db1", table: "tasks", row_id: "r1" }, "reads"],
    ["query", { database_id: "db1", sql: "SELECT 1" }, "reads"],
  ];

  it("has a verdict for every tool and action this server registers", () => {
    const registered = TOOL_NAMES.flatMap((tool) => {
      const action = toolDefinition(tool, "stdio").inputSchema.action as unknown as { options: string[] } | undefined;
      return action ? action.options.map((a) => `${tool}.${a}`) : [`${tool}.`];
    });
    expect(CALLS.map(([tool, args]) => `${tool}.${String(args.action ?? "")}`)).toEqual(registered);
  });

  it.each(CALLS.filter(([, , verdict]) => verdict === "reads"))("answers %s %o", async (tool, args) => {
    const { call } = await connectTo(readOnlyNode());
    const out = await call(tool, args);
    expect(out.isError, out.text).toBe(false);
  });

  it.each(CALLS.filter(([, , verdict]) => verdict === "refused"))("passes on the refusal of %s %o and sends nothing after it", async (tool, args) => {
    const node = readOnlyNode();
    const { call } = await connectTo(node);
    expect(await call(tool, args)).toEqual({ isError: true, text: `error: ${READ_ONLY}` });
    const changes = node.seen.filter((s) => s.method !== "GET");
    expect(changes).toHaveLength(1);
    expect(node.seen.at(-1)).toBe(changes[0]);
  });
});
