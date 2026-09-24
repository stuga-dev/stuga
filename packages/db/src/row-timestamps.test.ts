/**
 * postgres.js parses timestamptz into a Date, which keeps milliseconds only.
 * The type-level half is enforced by `tsc -p tsconfig.test.json`.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createClient, closeClients } from "./client.js";
import { insertAuditEvents } from "./audit.js";
import type { Sql } from "./client.js";
import type { AuditEventRow } from "./types.js";

/** OID of `timestamp with time zone`. */
const TIMESTAMPTZ = 1184;

/** Type equality in both directions; plain assignability would accept `string | Date`. */
type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// postgres.js connects on the first query, and nothing here issues one.
const sql = createClient("postgres://row-timestamps@127.0.0.1:1/unused");

afterAll(async () => {
  await closeClients();
});

describe("timestamptz columns", () => {
  it("comes back from the driver as a Date", () => {
    const parse = sql.options.parsers[TIMESTAMPTZ];
    expect(parse).toBeTypeOf("function");
    expect(parse!("2026-09-05 10:00:00+00")).toBeInstanceOf(Date);
  });

  it("is declared on AuditEventRow as exactly that Date", () => {
    // Unsatisfiable, and so a compile error, unless `at` is declared as Date and nothing wider.
    const declaredAsDate: Exact<AuditEventRow["at"], Date> = true;
    expect(declaredAsDate).toBe(true);

    const parsed = sql.options.parsers[TIMESTAMPTZ]!("2026-09-05 10:00:00+00");
    const at: AuditEventRow["at"] = parsed as Date;
    expect(at.toISOString()).toBe("2026-09-05T10:00:00.000Z");
  });
});

describe("the audit ledger's millisecond invariant", () => {
  const parse = sql.options.parsers[TIMESTAMPTZ]! as (v: string) => Date;

  it("keeps three of the six fractional digits a timestamptz holds", () => {
    expect(parse("2026-09-05 10:00:00.123456+00").toISOString()).toBe("2026-09-05T10:00:00.123Z");
    expect(parse("2026-09-05 10:00:00.123456+00").getTime()).toBe(parse("2026-09-05 10:00:00.123999+00").getTime());
  });

  it("round-trips a value that is already whole milliseconds", () => {
    const at = parse("2026-09-05 10:00:00.123+00");
    expect(at.toISOString()).toBe("2026-09-05T10:00:00.123Z");
    expect(parse("2026-09-05 10:00:00.123000+00").getTime()).toBe(at.getTime());
  });

  it("truncates `at` to milliseconds on the way in, the caller's value and the server clock alike", async () => {
    let statement = "";
    const capture = ((strings: TemplateStringsArray) => {
      statement = strings.join(" ? ");
      return Promise.resolve([]);
    }) as unknown as Sql;

    await insertAuditEvents(capture, [
      { workspaceId: "ws1", actor: "user:ada", actorKind: "human", source: "web", action: "doc.update" },
    ]);

    expect(statement).toMatch(/date_trunc\('milliseconds',\s*COALESCE\(at::timestamptz,\s*now\(\)\)\)/);
  });
});
