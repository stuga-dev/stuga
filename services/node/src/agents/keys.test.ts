import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", () => ({ getFolder: vi.fn(), insertApiKey: vi.fn(async () => {}) }));

const { getFolder, insertApiKey } = await import("@stuga/db");
const { agentKeyKind, createAgentKey, newAgentId } = await import("./keys.js");
import type { Ctx } from "../auth/context.js";

const ctx = { sql: {}, alias: "human-1", workspaceId: "ws1", principals: ["user:human-1", "org:ws1"] } as unknown as Ctx;

beforeEach(() => {
  vi.mocked(insertApiKey).mockClear();
  vi.mocked(getFolder).mockReset();
});

describe("agent key kinds", () => {
  it("tells a connector's agent id from a person's key", () => {
    for (let i = 0; i < 200; i++) {
      expect(agentKeyKind(newAgentId("key"))).toBe("key");
      expect(agentKeyKind(newAgentId("connector"))).toBe("connector");
    }
  });

  // A connector's agent id is minted with its OAuth grant (mcp/oauth.ts), never as an api key.
  it("mints a person's key with a key id, owned by them in their workspace", async () => {
    const key = await createAgentKey(ctx, "CI");
    expect(agentKeyKind(key.agentId)).toBe("key");
    expect(vi.mocked(insertApiKey).mock.calls[0]![1]).toMatchObject({
      agentId: key.agentId,
      owner: "human-1",
      workspaceId: "ws1",
      name: "CI",
    });
  });
});

describe("validating a key's narrowing", () => {
  it("defaults to the owner's full reach with propose access and no expiry", async () => {
    await expect(createAgentKey(ctx, "CI")).resolves.toMatchObject({ scopeFolders: null, access: "propose", expiresAt: null });
  });

  it("refuses a folder the caller cannot read, as if it did not exist", async () => {
    vi.mocked(getFolder).mockResolvedValue({ folder_id: "f1", workspace_id: "ws1", acl_principals: ["user:someone-else"] } as never);
    await expect(createAgentKey(ctx, "CI", { scopeFolders: ["f1"] })).rejects.toThrow("folder f1 not found");
    expect(insertApiKey).not.toHaveBeenCalled();
  });

  it("refuses an unknown access level and an out-of-range lifetime", async () => {
    await expect(createAgentKey(ctx, "CI", { access: "admin" as never })).rejects.toThrow("access must be read | propose");
    await expect(createAgentKey(ctx, "CI", { expiresInDays: 0 })).rejects.toThrow(/expires_in_days/);
    await expect(createAgentKey(ctx, "CI", { expiresInDays: 3651 })).rejects.toThrow(/expires_in_days/);
  });
});
