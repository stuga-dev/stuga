import { describe, expect, it } from "vitest";
import { b64urlEncodeText, signTicket } from "./signed-ticket.js";
import { mintWsTicket, verifyWsTicket, type WsTicket } from "./ws-ticket.js";

const SECRET = "node-internal-secret";
const NOW = 1_700_000_000_000;
const GRANT: Omit<WsTicket, "expiresAt"> = {
  alias: "u_AAAAAAAAAAAAAAAA",
  workspaceId: "ws_1",
  docId: "doc_1",
  canWrite: true,
  sid: "sess-1",
  arrival: "local",
};

const mint = (over: Partial<Omit<WsTicket, "expiresAt">> = {}, ttl?: number) => mintWsTicket(SECRET, { ...GRANT, ...over }, NOW, ttl);
/** The ticket with field `index` (0 = version) replaced, its signature kept. */
function edited(value: string, index: number, to: string): string {
  const parts = value.split(".");
  parts[index] = to;
  return parts.join(".");
}

describe("a socket ticket", () => {
  it("round-trips every field it binds", () => {
    const { value, expiresAt } = mint();
    expect(verifyWsTicket(SECRET, value, "local", NOW)).toEqual({ ...GRANT, expiresAt });
  });

  it("carries the write tier it was minted with, not a default", () => {
    expect(verifyWsTicket(SECRET, mint({ canWrite: false }).value, "local", NOW)?.canWrite).toBe(false);
  });

  it("is bound to its document: renaming the document field breaks the signature", () => {
    expect(verifyWsTicket(SECRET, edited(mint().value, 3, b64urlEncodeText("doc_2")), "local", NOW)).toBeNull();
  });

  it("is bound to its workspace", () => {
    expect(verifyWsTicket(SECRET, edited(mint().value, 2, b64urlEncodeText("ws_2")), "local", NOW)).toBeNull();
  });

  it("signs the write tier, so a viewer's ticket cannot be promoted in transit", () => {
    expect(verifyWsTicket(SECRET, edited(mint({ canWrite: false }).value, 4, "w"), "local", NOW)).toBeNull();
  });

  it("is bound to the session it was minted for", () => {
    expect(verifyWsTicket(SECRET, edited(mint().value, 5, b64urlEncodeText("sess-2")), "local", NOW)).toBeNull();
  });

  it("opens a socket only at the listener that minted it", () => {
    const local = mint().value;
    const remote = mint({ arrival: "remote" }).value;
    expect(verifyWsTicket(SECRET, local, "remote", NOW)).toBeNull();
    expect(verifyWsTicket(SECRET, remote, "local", NOW)).toBeNull();
    expect(verifyWsTicket(SECRET, remote, "remote", NOW)).toMatchObject({ arrival: "remote", sid: "sess-1" });
  });

  it("stops verifying the moment it expires", () => {
    const { value, expiresAt } = mint({}, 60);
    expect(verifyWsTicket(SECRET, value, "local", expiresAt * 1000 - 1_000)).not.toBeNull();
    expect(verifyWsTicket(SECRET, value, "local", expiresAt * 1000 + 1_000)).toBeNull();
  });

  it("does not verify under another node's secret", () => {
    expect(verifyWsTicket("a-different-secret", mint().value, "local", NOW)).toBeNull();
  });

  it("answers null for anything that is not a ticket, a ticket of the earlier form included", () => {
    for (const junk of ["", "...", "ws1.a.b.c.w.1.sig", "ws2.a.b.c.w.s.1", "a.b.1.sig", null, undefined]) {
      expect(verifyWsTicket(SECRET, junk, "local", NOW)).toBeNull();
    }
  });
});

describe("the domain the signature is bound to", () => {
  it("refuses a well-formed socket ticket signed under another kind's label", () => {
    const good = mintWsTicket(SECRET, GRANT);
    const payload = good.value.slice(0, good.value.lastIndexOf("."));
    const forged = `${payload}.${signTicket(SECRET, "stuga/media-ticket/v2/local", payload)}`;

    expect(verifyWsTicket(SECRET, good.value, "local")).not.toBeNull();
    expect(verifyWsTicket(SECRET, forged, "local")).toBeNull();
  });
});
