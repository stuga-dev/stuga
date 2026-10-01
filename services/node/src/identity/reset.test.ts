import { describe, it, expect } from "vitest";
import { sha256Hex } from "@stuga/auth";
import type { Sql } from "@stuga/db";
import { mintPasswordReset, resetUrl, RESET_TTL_MS } from "./reset.js";

/** A `Sql` stand-in that records the row handed to the `sql(row)` insert helper. */
function fakeSql(rows: Record<string, unknown>[]): Sql {
  const fn = (first: unknown): unknown => {
    if (first && typeof first === "object" && "raw" in first) return Promise.resolve([]);
    rows.push(first as Record<string, unknown>);
    return { row: true };
  };
  return fn as unknown as Sql;
}

describe("minting a password reset", () => {
  it("stores the token's hash and never the token", async () => {
    const rows: Record<string, unknown>[] = [];
    const { token } = await mintPasswordReset(fakeSql(rows), { alias: "u_alice", createdBy: "console" });

    expect(rows).toHaveLength(1);
    const stored = rows[0]!;
    expect(stored.token_hash).toBe(sha256Hex(token));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("records who minted it, so a console reset is not mistaken for an administrator's", () => {
    const rows: Record<string, unknown>[] = [];
    return mintPasswordReset(fakeSql(rows), { alias: "u_alice", createdBy: "console" }).then(() => {
      expect(rows[0]).toMatchObject({ alias: "u_alice", created_by: "console" });
    });
  });

  it("expires a day out, measured from the caller's clock", async () => {
    const rows: Record<string, unknown>[] = [];
    const now = new Date(1_700_000_000_000);
    const { expiresAt } = await mintPasswordReset(fakeSql(rows), {
      alias: "u_alice",
      createdBy: "console",
      now,
    });
    expect(expiresAt.getTime() - now.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(RESET_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(rows[0]!.expires_at).toEqual(expiresAt);
  });

  it("mints a different token every time", async () => {
    const a = await mintPasswordReset(fakeSql([]), { alias: "u_alice", createdBy: "console" });
    const b = await mintPasswordReset(fakeSql([]), { alias: "u_alice", createdBy: "console" });
    expect(a.token).not.toBe(b.token);
  });

  it("mints 256 bits of hex, so a link cannot be guessed", async () => {
    const { token } = await mintPasswordReset(fakeSql([]), { alias: "u_alice", createdBy: "console" });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the link", () => {
  it("is built on PUBLIC_ORIGIN, like every other URL the node mints", () => {
    expect(resetUrl("https://stuga.example.com", "abc")).toBe("https://stuga.example.com/reset/abc");
  });
});

describe("what reset-password prints", () => {
  const base = {
    alias: "u_fen",
    username: "fen",
    token: "t0ken",
    hours: 24,
    publicOrigin: "http://203.0.113.7:8787",
    remoteHostname: null,
    listener: { plainHttp: true, port: 8787 },
  };

  it("gives the remote address's link while it is on, which opens anywhere", async () => {
    const { resetLinkText } = await import("./reset-command.js");
    const text = resetLinkText({ ...base, remoteHostname: "k7f3q2.mystuga.com" });
    expect(text).toContain("https://k7f3q2.mystuga.com/reset/t0ken");
    expect(text).not.toContain("203.0.113.7");
    expect(text).not.toContain("ssh -L");
  });

  it("over plain http, the node's own link and the SSH tunnel to open it from elsewhere", async () => {
    const { resetLinkText } = await import("./reset-command.js");
    const text = resetLinkText({ ...base, listener: { plainHttp: true, port: 9000 } });
    expect(text).toContain("http://203.0.113.7:8787/reset/t0ken");
    // Another computer on the node's network opens the link as it is: the tunnel is for outside it.
    expect(text).toContain("From outside this network, open it through an SSH tunnel: ssh -L 9000:127.0.0.1:9000 <this machine>");
    expect(text).toContain("http://localhost:9000/reset/t0ken");
  });

  it("over https, the node's own link alone", async () => {
    const { resetLinkText } = await import("./reset-command.js");
    expect(resetLinkText({ ...base, publicOrigin: "https://nas.example", listener: { plainHttp: false, port: 8787 } })).not.toContain("ssh -L");
  });

  it("reads the tunnel's port from the host's (Docker) before the node's own", async () => {
    const { resetListener } = await import("./reset-command.js");
    expect(resetListener({ PORT: "8787", STUGA_TUNNEL_PORT: "9100" })).toEqual({ plainHttp: true, port: 9100 });
    expect(resetListener({ PORT: "8788", TLS_CERT_DIR: "/certs" })).toEqual({ plainHttp: false, port: 8788 });
    expect(resetListener({})).toEqual({ plainHttp: true, port: 8787 });
  });
});
