import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initSearchSchema } from "../testing/search-schema.js";
import { describeSchema } from "../testing/schema-snapshot.js";
import { closeClients, createClient, type Sql } from "../client.js";

const URL = process.env.TEST_DATABASE_URL;

// Regenerate with `pnpm --filter @stuga/db schema:snapshot` after changing the schema or a BM25 index.
describe.skipIf(!URL)("the committed schema snapshot", () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = createClient(URL!);
    await initSearchSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });

  it("matches the schema a booted node has", async () => {
    await expect(await describeSchema(sql)).toMatchFileSnapshot("../../schema.snapshot.txt");
  });
});
