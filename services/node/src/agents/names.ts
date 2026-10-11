/** Agents as people read them: by the name of the key or connection they act through now. */
import { agentNames, type Sql } from "@stuga/db";

/**
 * The current name of each agent among `aliases` (bare or `agent:`-prefixed), keyed by the alias as
 * given, so a page that shows an agent's id can show its name, after a rename too. An alias no key
 * or connection names is left out.
 */
export async function agentNameMap(sql: Sql, aliases: Iterable<string>): Promise<Record<string, string>> {
  const id = (alias: string) => alias.replace(/^agent:/, "");
  // A co-author's `panel:<alias>` is a person's instrument, named by the app, not a key.
  const given = [...new Set(aliases)].filter((a) => !id(a).includes(":"));
  if (given.length === 0) return {};
  const names = await agentNames(sql, [...new Set(given.map(id))]);
  const out: Record<string, string> = {};
  for (const alias of given) {
    const name = names.get(id(alias));
    if (name) out[alias] = name;
  }
  return out;
}
