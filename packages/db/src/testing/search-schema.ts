import type { Sql } from "../client.js";
import { initSchema } from "../schema/migrate.js";
import { runBootRepairs } from "../schema/boot-repairs.js";

/** The schema a booted node searches: the migrations, then the BM25 indexes the boot repairs build. */
export async function initSearchSchema(sql: Sql): Promise<void> {
  await initSchema(sql);
  await runBootRepairs(sql);
}
