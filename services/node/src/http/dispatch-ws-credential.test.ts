/** What a socket URL may carry: a socket ticket, and nothing else. */
import { describe, expect, it } from "vitest";
import { createApp } from "./dispatch.js";
import type { NodeEnv } from "../env.js";

const PUBLIC_ORIGIN = "http://localhost:8787";
const app = createApp({ publicOrigin: PUBLIC_ORIGIN, extraOrigins: [], internalSecret: "test-secret" } as unknown as NodeEnv);

const upgrade = (query: string) =>
  app.upgrade(new Request(`${PUBLIC_ORIGIN}/ws/doc1?${query}`, { headers: { upgrade: "websocket" } }));

describe("a credential in a socket URL", () => {
  it("ignores a bearer access token", async () => {
    const res = await upgrade("access_token=eyJhbGciOiJFUzI1NiJ9.body.sig");
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
  });

  it("ignores an agent API key", async () => {
    const res = await upgrade("access_token=vk_abcd1234_secretsecret");
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
  });

  it("refuses a ticket this node did not sign", async () => {
    const res = await upgrade("ticket=ws1.YQ.Yg.Yw.w.9999999999.forged");
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
  });
});
