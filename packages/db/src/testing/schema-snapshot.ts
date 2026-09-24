/**
 * Every column, constraint and index in `public`, as deterministic text. Read
 * from the catalog rather than pg_dump, so it needs no external binary and no
 * version-specific dump format.
 */
import type { Sql } from "../client.js";

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface IndexRow {
  tablename: string;
  indexname: string;
  indexdef: string;
}

interface ConstraintRow {
  table_name: string;
  conname: string;
  definition: string;
}

export async function describeSchema(sql: Sql): Promise<string> {
  const columns = await sql<ColumnRow[]>`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, column_name`;

  const indexes = await sql<IndexRow[]>`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY tablename, indexname`;

  // NOT NULL constraints (contype 'n') are left out: the column line says NOT
  // NULL, and whether they are also cataloged depends on the server major.
  const constraints = await sql<ConstraintRow[]>`
    SELECT rel.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = 'public'
      AND con.contype <> 'n'
    ORDER BY rel.relname, con.conname`;

  const tables = [...new Set(columns.map((c) => c.table_name))].sort();
  const lines: string[] = [
    "# Stuga schema snapshot — GENERATED, do not edit by hand.",
    "#",
    "# Regenerate with:  pnpm --filter @stuga/db schema:snapshot",
    "# A diff here is the visible half of a migration. If one appears that no",
    "# migration in this change explains, something is wrong.",
    "",
  ];

  for (const table of tables) {
    lines.push(`TABLE ${table}`);
    for (const c of columns.filter((x) => x.table_name === table)) {
      const nullable = c.is_nullable === "NO" ? " NOT NULL" : "";
      const dflt = c.column_default === null ? "" : ` DEFAULT ${c.column_default}`;
      lines.push(`  ${c.column_name} ${c.data_type}${nullable}${dflt}`);
    }
    for (const k of constraints.filter((x) => x.table_name === table)) {
      lines.push(`  CONSTRAINT ${k.conname} ${k.definition}`);
    }
    for (const i of indexes.filter((x) => x.tablename === table)) {
      lines.push(`  INDEX ${i.indexname} ${i.indexdef}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
