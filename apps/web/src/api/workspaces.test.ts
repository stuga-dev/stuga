// @vitest-environment jsdom
/** A workspace export as it leaves and comes back to the browser; WorkspaceGeneral.test.tsx mocks this layer. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspaces, onWorkspaceListChanged } from "./workspaces";

let calls: string[];
let disposition: string | null;

beforeEach(() => {
  calls = [];
  disposition = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return new Response("PK", { headers: disposition ? { "content-disposition": disposition } : {} });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Workspaces.exportArchive", () => {
  it("asks for the workspace's archive and names the file as the node does, in UTF-8", async () => {
    disposition = `attachment; filename="Livs.stuga.zip"; filename*=UTF-8''Liv%27s%20%E5%9B%A2%E9%98%9F.stuga.zip`;
    const { blob, filename } = await Workspaces.exportArchive("ws1");
    expect(calls).toEqual(["/api/workspaces/ws1/export"]);
    expect(filename).toBe("Liv's 团队.stuga.zip");
    expect(await blob.text()).toBe("PK");
  });

  it("says so when the node breaks the download partway", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ start: (c) => c.error(new TypeError("network error")) }))),
    );
    await expect(Workspaces.exportArchive("ws1")).rejects.toThrow("The export stopped before it finished.");
  });

  it("falls back to the plain name, then to one of its own", async () => {
    disposition = `attachment; filename="Plans.stuga.zip"`;
    expect((await Workspaces.exportArchive("ws1")).filename).toBe("Plans.stuga.zip");
    disposition = null;
    expect((await Workspaces.exportArchive("ws1")).filename).toBe("workspace.stuga.zip");
  });
});

describe("Workspaces.importArchive", () => {
  it("sends the file as the body, with the name and access in the query, and answers the new workspace", async () => {
    let sent: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push(String(url));
        sent = init;
        return Response.json({ workspace_id: "ws2", name: "Liv's team", start_doc_id: "d1" }, { status: 201 });
      }),
    );
    const file = new File(["PK"], "Liv's team.stuga.zip", { type: "application/zip" });
    const created = await Workspaces.importArchive(file, "Liv's team & co", "private");
    expect(calls).toEqual(["/api/workspaces/import?name=Liv's%20team%20%26%20co&default_doc_access=private"]);
    expect(sent?.method).toBe("POST");
    expect(sent?.body).toBe(file);
    expect(new Headers(sent?.headers).get("content-type")).toBe("application/zip");
    expect(created).toMatchObject({ workspace_id: "ws2", start_doc_id: "d1" });
  });

  it("waits as long as an export, since the node answers once the whole import is done", async () => {
    const deadlines = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ workspace_id: "ws2" }, { status: 201 })));
    await Workspaces.importArchive(new File(["PK"], "a.stuga.zip"), "A", "private");
    await Workspaces.exportArchive("ws1");
    expect(deadlines.mock.calls.map(([ms]) => ms)).toEqual([60 * 60_000, 60 * 60_000]);
    deadlines.mockRestore();
  });

  it("has the workspace list read again when a proxy stops waiting, since the node goes on importing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 504 })));
    const changed = vi.fn();
    const stop = onWorkspaceListChanged(changed);
    try {
      await expect(Workspaces.importArchive(new File(["PK"], "a.stuga.zip"), "A", "private")).rejects.toMatchObject({ status: 504 });
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});

describe("sample workspaces", () => {
  it("lists the node's samples, kept a minute so each opening of the dialog does not ask again", async () => {
    const list = vi.fn(async (url: string | URL) => (calls.push(String(url)), Response.json({ samples: [], unavailable: true })));
    vi.stubGlobal("fetch", list);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect(await Workspaces.samples()).toEqual({ samples: [], unavailable: true });
      await Workspaces.samples();
      expect(calls).toEqual(["/api/workspace-samples"]);
      vi.setSystemTime(Date.now() + 60_000);
      await Workspaces.samples();
      expect(calls).toHaveLength(2);
      // Asked for again at once, past the list kept, which is then the one kept.
      await Workspaces.samplesAgain();
      expect(calls).toHaveLength(3);
      await Workspaces.samples();
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates from a sample by its id, and waits as long as an import does", async () => {
    let sent: RequestInit | undefined;
    const deadlines = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push(String(url));
        sent = init;
        return Response.json({ workspace_id: "ws3", start_doc_id: "d_laws" }, { status: 201 });
      }),
    );
    const created = await Workspaces.createFromSample("privacy-laws", "Privacy laws (sample)", "workspace_view");
    expect(calls).toEqual(["/api/workspaces"]);
    expect(sent?.method).toBe("POST");
    expect(JSON.parse(String(sent?.body))).toEqual({ name: "Privacy laws (sample)", default_doc_access: "workspace_view", sample: "privacy-laws" });
    expect(created).toMatchObject({ workspace_id: "ws3", start_doc_id: "d_laws" });
    expect(deadlines.mock.calls.map(([ms]) => ms)).toEqual([60 * 60_000]);
    deadlines.mockRestore();
  });
});
