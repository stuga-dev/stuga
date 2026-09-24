import { describe, expect, it } from "vitest";
import { createInternalApi } from "./internal-api.js";

describe("createInternalApi", () => {
  it("calls the handler in-process with the request as given", async () => {
    const seen: Request[] = [];
    const api = createInternalApi(async (req) => {
      seen.push(req);
      return Response.json({ ok: true });
    });
    const res = await api.fetch("/internal/retrieve", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(await res.json()).toEqual({ ok: true });
    expect(new URL(seen[0]!.url).pathname).toBe("/internal/retrieve");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers.get("content-type")).toBe("application/json");
    await expect(api.fetch("internal/x")).rejects.toThrow(/absolute/);
  });
});
