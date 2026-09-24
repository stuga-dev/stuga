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
