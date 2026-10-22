/** What an agent reads back from the wiki: the Index, the Log and the check, names as an answer gives them. */
import type { AuthorRef, LogPage, WikiIndex, WikiLint, WikiLog } from "@stuga/protocol/domain/wiki";

/** A person by name; an agent or a co-author by the person it worked for, as every agent answer names them. */
export function authorName(ref: AuthorRef): string {
  switch (ref.kind) {
    case "person":
    case "sample":
      return ref.name;
    case "agent":
      return `${ref.name}'s agent`;
    case "coauthor":
      return `${ref.name}'s AI co-author`;
  }
}

/** Said with an index: what it is, and what it is not. */
export const INDEX_NOTE =
  "Generated from the pages you can read; nothing writes to it. `needs_checking`: a page it cites changed after it " +
  "was approved (`docs` action:lint lists which).";

/** Said when an index or a check lists less than there is. */
export const NARROW_NOTE = "Not everything is listed: pass a folder's id as `parent_id` to read one folder at a time.";

export function renderIndex(index: WikiIndex, origin: string): string {
  return JSON.stringify({
    sections: index.sections.map((s) => ({
      folder_id: s.folder_id,
      path: s.path,
      ...(s.my_notes ? { my_notes: true } : {}),
      ...(s.elsewhere ? { elsewhere: true, note: "Shared with the user; its folder is not one they can open." } : {}),
      pages: s.pages.map((p) => ({
        doc_id: p.doc_id,
        title: p.title,
        ...(p.doc_type === "database" ? { doc_type: p.doc_type } : {}),
        summary: p.summary,
        changed_at: p.changed_at,
        changed_by: p.changed_by.map(authorName),
        ...(p.needs_checking ? { needs_checking: true } : {}),
        ...(origin ? { url: `${origin}/doc/${p.doc_id}` } : {}),
      })),
    })),
    ...(index.truncated ? { truncated: true, note: NARROW_NOTE } : {}),
    about: INDEX_NOTE,
  });
}

function pageLine(p: LogPage): Record<string, unknown> {
  return {
    doc_id: p.doc_id,
    title: p.title,
    ...(p.doc_kind === "database" ? { doc_kind: p.doc_kind } : {}),
    approved: p.approved,
    declined: p.declined,
    ...(p.applied > 0 ? { applied_directly: p.applied } : {}),
    ...(p.reverted ? { reverted: true } : {}),
  };
}

export function renderLog(log: WikiLog): string {
  return JSON.stringify({
    entries: log.entries.map((e) => ({
      kind: e.kind,
      id: e.id,
      ...(e.title ? { title: e.title } : {}),
      at: e.at,
      outcome: e.outcome,
      asked_by: e.asked_by ? authorName(e.asked_by) : null,
      agent: e.agent.name,
      decided_by: e.decided_by.map(authorName),
      pages: e.pages.map(pageLine),
    })),
    next: log.next,
    ...(log.entries.length === 0 ? { note: "No AI change you can read has been decided yet." } : {}),
  });
}

/** Said after a check, where a model acting on it reads it. */
export const LINT_NEXT =
  "Nothing is fixed yet, and nothing here is fixed by rewriting a page. For each page in `needs_checking`, read it " +
  "and each changed source, and correct only the sentences the change makes untrue, citing the source again " +
  "(`markdown_edit` action:cited_edits); when nothing it says is untrue, leave it and tell the user, who marks it " +
  "checked on the page. For an orphan, add a link to it (`[title](/doc/<id>)`) from the page a reader would look " +
  "in. For a link `in_trash`, point it at the page meant, or tell the user, who may restore that page. A link " +
  "`not_found` may name a page that is there and the user cannot open: never take it out on your own; tell the user " +
  "which page holds it, and change it only once they say the page it names is gone. Propose all of it as " +
  'ONE change: `change_title` such as "Wiki check, 2026-10-22" on your first write and its `change_id` on every ' +
  "other, so a person approves it as one. Then tell the user what you proposed and what you left for them.";

export function renderLint(lint: WikiLint): string {
  const empty = lint.needs_checking.length + lint.orphans.length + lint.broken_links.length === 0;
  return JSON.stringify({
    needs_checking: lint.needs_checking,
    orphans: lint.orphans,
    broken_links: lint.broken_links,
    ...(lint.truncated ? { truncated: true, note: NARROW_NOTE } : {}),
    next: empty ? "Nothing to fix in the pages the user can read." : LINT_NEXT,
  });
}
