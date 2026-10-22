/**
 * Who wrote a document, as an agent's answer cites it: when it last changed, who made its latest
 * version (people by name, an agent or AI co-author by the person it worked for, "Liv's agent"),
 * whether AI changes in it stand that no person has reviewed, and which AI changes wait to be
 * approved and are not in its text yet. Read for documents the caller has already been shown, so it
 * reaches nothing further; runs by id, agent and the person who asked, never their text.
 */
import { SAMPLE_AGENT_ALIAS, SAMPLE_AGENT_NAME } from "@stuga/protocol/domain/workspaces";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import type { AuthorRef } from "@stuga/protocol/domain/wiki";
import { docCols, docLevelJoins } from "./sql.js";
import type { Queryable } from "./sql.js";
import type { DocRow } from "./types.js";

/** AI changes proposed to a document that wait, from one agent at one level. */
export interface WaitingRun {
  run_id: string;
  agent_alias: string;
  /** The person who asked for them, who reviews them at `review`: the user an agent acts for. */
  reviewer: string;
  /** The level the run was proposed under; a decision takes the stricter of it and the item's now. */
  review_mode: ReviewMode;
  /** Its changes still waiting. */
  pending: number;
  /** When the run began: its oldest waiting change is at most this old. */
  created_at: string;
}

export interface DocAuthorship {
  doc_id: string;
  updated_at: string;
  /** Who made the latest version: a person by name, an agent as "Liv's agent"; with no version naming anyone yet, who created it. */
  last_edited_by: Array<{ kind: "person" | "agent"; name: string }>;
  /** AI changes that stand in it: accepted by a person, or applied directly. */
  ai_changes: number;
  /** Of those, the ones applied directly that no person has marked reviewed yet. */
  ai_unreviewed: number;
  /** Runs whose changes wait for a decision, oldest first: none of their text is in the document. */
  waiting: WaitingRun[];
  /** The document's level fields, so the caller can say at what level its waiting changes are decided now. */
  level: Pick<DocRow, "agent_mode" | "folder_agent_mode" | "database_agent_mode" | "notes_shared">;
}

/** Names longer than this are cut: a display name is the person's own text. */
const NAME_MAX = 80;

const cut = (name: string): string => ([...name].length > NAME_MAX ? `${[...name].slice(0, NAME_MAX - 1).join("")}…` : name);

/** The co-author's alias names the person whose panel it ran in. */
const COAUTHOR_PREFIX = "panel:";

/**
 * Each author alias a version or a run records, named as AuthorRef says. An alias it cannot name (a
 * former member, an agent's own label from before versions recorded its principal, a restore's or an
 * import's marker) is left out.
 */
export async function authorRefs(sql: Queryable, aliases: readonly string[]): Promise<Map<string, AuthorRef>> {
  const out = new Map<string, AuthorRef>();
  if (aliases.length === 0) return out;
  const agents = aliases.filter((a) => a.startsWith("agent-") && a !== SAMPLE_AGENT_ALIAS);
  // An agent acts for the person who made its key or signed it in, whatever name its client gave it.
  const owners = new Map<string, string>();
  if (agents.length > 0) {
    const rows = await sql<{ agent_id: string; owner: string }[]>`
      SELECT agent_id, owner FROM api_keys WHERE agent_id = ANY(${agents})
      UNION ALL
      SELECT agent_id, owner FROM oauth_grants WHERE agent_id = ANY(${agents})`;
    for (const r of rows) owners.set(r.agent_id, r.owner);
  }
  const coauthors = aliases.filter((a) => a.startsWith(COAUTHOR_PREFIX));
  const people = [
    ...new Set([
      ...aliases.filter((a) => !a.startsWith("agent-") && !a.startsWith(COAUTHOR_PREFIX)),
      ...owners.values(),
      ...coauthors.map((a) => a.slice(COAUTHOR_PREFIX.length)),
    ]),
  ];
  const names = new Map<string, string>();
  if (people.length > 0) {
    const rows = await sql<{ alias: string; name: string }[]>`
      SELECT alias, coalesce(nullif(display_name, ''), username) AS name FROM users WHERE alias = ANY(${people})`;
    for (const r of rows) names.set(r.alias, cut(r.name));
  }
  for (const alias of aliases) {
    if (alias === SAMPLE_AGENT_ALIAS) {
      out.set(alias, { kind: "sample", name: SAMPLE_AGENT_NAME });
      continue;
    }
    const kind: Exclude<AuthorRef["kind"], "sample"> = alias.startsWith(COAUTHOR_PREFIX) ? "coauthor" : alias.startsWith("agent-") ? "agent" : "person";
    const person =
      kind === "coauthor" ? names.get(alias.slice(COAUTHOR_PREFIX.length)) : kind === "agent" ? names.get(owners.get(alias) ?? "") : names.get(alias);
    if (person !== undefined) out.set(alias, { kind, name: person });
  }
  return out;
}

/** An author as an agent's answer names one: a person by name, an agent as "Liv's agent". */
export function authorLabel(ref: AuthorRef): { kind: "person" | "agent"; name: string } {
  if (ref.kind === "person") return { kind: "person", name: ref.name };
  if (ref.kind === "sample") return { kind: "agent", name: ref.name };
  return { kind: "agent", name: ref.kind === "coauthor" ? `${ref.name}'s AI co-author` : `${ref.name}'s agent` };
}

/** Each author alias a version records, as an agent's answer names it. */
async function authorNames(sql: Queryable, aliases: readonly string[]): Promise<Map<string, { kind: "person" | "agent"; name: string }>> {
  const refs = await authorRefs(sql, aliases);
  return new Map([...refs].map(([alias, ref]) => [alias, authorLabel(ref)]));
}

export type { AuthorRef };

/** The runs of each of `docIds` whose changes wait for a decision, oldest first. */
export async function waitingRuns(sql: Queryable, workspaceId: string, docIds: readonly string[]): Promise<Map<string, WaitingRun[]>> {
  const out = new Map<string, WaitingRun[]>();
  if (docIds.length === 0) return out;
  const rows = await sql<Array<WaitingRun & { doc_id: string }>>`
    SELECT doc_id, run_id, agent_alias, reviewer, review_mode, pending, created_at
    FROM agent_runs
    WHERE workspace_id = ${workspaceId} AND doc_id = ANY(${[...docIds]}) AND status = 'open' AND pending > 0 AND NOT reverted
    ORDER BY created_at, run_id`;
  for (const { doc_id, ...run } of rows) {
    const list = out.get(doc_id) ?? [];
    list.push({ ...run, created_at: new Date(run.created_at).toISOString() });
    out.set(doc_id, list);
  }
  return out;
}

/** Each document's authorship, for the documents of `docIds` in the workspace; a missing one is left out. */
export async function docAuthorship(sql: Queryable, workspaceId: string, docIds: readonly string[]): Promise<Map<string, DocAuthorship>> {
  const out = new Map<string, DocAuthorship>();
  if (docIds.length === 0) return out;
  const rows = await sql<Array<DocRow & { authors: string[]; ai_changes: number; ai_unreviewed: number }>>`
    SELECT ${docCols(sql, "d", { joined: true })}, coalesce(v.authors, '{}') AS authors,
           coalesce(r.ai_changes, 0)::int AS ai_changes, coalesce(r.ai_unreviewed, 0)::int AS ai_unreviewed
    FROM docs d
    ${docLevelJoins(sql, "d")}
    LEFT JOIN LATERAL (SELECT authors FROM versions WHERE doc_id = d.doc_id ORDER BY seq DESC LIMIT 1) v ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE accepted + applied > 0) AS ai_changes,
             count(*) FILTER (WHERE auto_applied AND NOT acknowledged AND applied > 0) AS ai_unreviewed
      FROM agent_runs WHERE doc_id = d.doc_id AND workspace_id = d.workspace_id AND NOT reverted
    ) r ON TRUE
    WHERE d.workspace_id = ${workspaceId} AND d.doc_id = ANY(${[...docIds]})`;
  // A page with no version naming anyone yet (a new page whose text all waits) is named by who made it.
  const creatorOf = (r: DocRow) => (r.created_by ? r.created_by.replace(/^(?:user|agent):/, "") : null);
  const aliases = rows.flatMap((r) => {
    const creator = creatorOf(r);
    return creator ? [...r.authors, creator] : r.authors;
  });
  const [named, waiting] = await Promise.all([authorNames(sql, [...new Set(aliases)]), waitingRuns(sql, workspaceId, docIds)]);
  for (const r of rows) {
    const nameOf = (alias: string) => {
      const name = named.get(alias);
      return name ? [name] : [];
    };
    let edited = r.authors.flatMap(nameOf);
    const creator = creatorOf(r);
    if (edited.length === 0 && creator) edited = nameOf(creator);
    out.set(r.doc_id, {
      doc_id: r.doc_id,
      updated_at: new Date(r.updated_at).toISOString(),
      // One entry per name: a person and the co-author in their panel stay two.
      last_edited_by: edited.filter((e, i) => edited.findIndex((x) => x.kind === e.kind && x.name === e.name) === i),
      ai_changes: r.ai_changes,
      ai_unreviewed: r.ai_unreviewed,
      waiting: waiting.get(r.doc_id) ?? [],
      level: {
        agent_mode: r.agent_mode,
        folder_agent_mode: r.folder_agent_mode,
        database_agent_mode: r.database_agent_mode ?? null,
        notes_shared: r.notes_shared ?? false,
      },
    });
  }
  return out;
}
