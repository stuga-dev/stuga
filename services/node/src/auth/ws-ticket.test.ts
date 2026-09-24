import { describe, expect, it } from "vitest";
import { b64urlEncodeText, signTicket } from "./signed-ticket.js";
import { mintWsTicket, verifyWsTicket } from "./ws-ticket.js";

const SECRET = "node-internal-secret";
const NOW = 1_700_000_000_000;
const ALIAS = "u_AAAAAAAAAAAAAAAA";
const WS = "ws_1";
const DOC = "doc_1";

describe("a socket ticket", () => {
  it("round-trips every field it binds", () => {
    const { value, expiresAt } = mintWsTicket(SECRET, ALIAS, WS, DOC, true, NOW);
    expect(verifyWsTicket(SECRET, value, NOW)).toEqual({
      alias: ALIAS,
      workspaceId: WS,
      docId: DOC,
      canWrite: true,
      expiresAt,
    });
  });

  it("carries the write tier it was minted with, not a default", () => {
    const { value } = mintWsTicket(SECRET, ALIAS, WS, DOC, false, NOW);
    expect((verifyWsTicket(SECRET, value, NOW))?.canWrite).toBe(false);
  });

  it("is bound to its document: renaming the document field breaks the signature", () => {
    const { value } = mintWsTicket(SECRET, ALIAS, WS, DOC, true, NOW);
    const [v, alias, ws, , write, exp, sig] = value.split(".");
    const other = b64urlEncodeText("doc_2");
    expect(verifyWsTicket(SECRET, `${v}.${alias}.${ws}.${other}.${write}.${exp}.${sig}`, NOW)).toBeNull();
  });

  it("is bound to its workspace", () => {
    const { value } = mintWsTicket(SECRET, ALIAS, WS, DOC, true, NOW);
    const [v, alias, , doc, write, exp, sig] = value.split(".");
    const other = b64urlEncodeText("ws_2");
    expect(verifyWsTicket(SECRET, `${v}.${alias}.${other}.${doc}.${write}.${exp}.${sig}`, NOW)).toBeNull();
  });

  it("signs the write tier, so a viewer's ticket cannot be promoted in transit", () => {
    const { value } = mintWsTicket(SECRET, ALIAS, WS, DOC, false, NOW);
    const [v, alias, ws, doc, , exp, sig] = value.split(".");
    expect(verifyWsTicket(SECRET, `${v}.${alias}.${ws}.${doc}.w.${exp}.${sig}`, NOW)).toBeNull();
  });

  it("stops verifying the moment it expires", () => {
    const { value, expiresAt } = mintWsTicket(SECRET, ALIAS, WS, DOC, true, NOW, 60);
    expect(verifyWsTicket(SECRET, value, expiresAt * 1000 - 1_000)).not.toBeNull();
    expect(verifyWsTicket(SECRET, value, expiresAt * 1000 + 1_000)).toBeNull();
  });

  it("does not verify under another node's secret", () => {
    const { value } = mintWsTicket(SECRET, ALIAS, WS, DOC, true, NOW);
    expect(verifyWsTicket("a-different-secret", value, NOW)).toBeNull();
  });

  it("answers null for anything that is not a ticket", () => {
    for (const junk of ["", "...", "ws1.a.b.c.w.1", "a.b.1.sig", null, undefined]) {
      expect(verifyWsTicket(SECRET, junk, NOW)).toBeNull();
    }
  });
});

describe("the domain the signature is bound to", () => {
  it("refuses a well-formed socket ticket signed under another kind's label", () => {
    const good = mintWsTicket(SECRET, "alice", "ws1", "d1", true);
    const payload = good.value.slice(0, good.value.lastIndexOf("."));
    const forged = `${payload}.${signTicket(SECRET, "stuga/media-ticket/v1", payload)}`;

    expect(verifyWsTicket(SECRET, good.value)).not.toBeNull();
    expect(verifyWsTicket(SECRET, forged)).toBeNull();
  });
});
