import type { Sql } from "../client.js";
import { initSchema } from "../schema/migrate.js";

/** The schema a booted node searches: the migrations, which create its keyword indexes too. */
export async function initSearchSchema(sql: Sql): Promise<void> {
  await initSchema(sql);
}
