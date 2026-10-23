/**
 * Save to Stuga's plan: where each point an agent was asked to save belongs. It writes no text. For
 * each point it searches the workspace as the caller would (the same hybrid passage search `retrieve`
 * ranks with: keywords by BM25, and meaning when embeddings are on), gated by the caller's reach, so
 * it never names more than the caller could find, and looks the point's words up in page titles, so
 * a page whose approved text is empty (a new page whose text all waits) is found by its title. From
 * what it finds:
 *
 * - candidates: the pages the caller can edit where the point fits, best first. A page that says the
 *   point already comes first, then a table's row that does; then a row it fills a column of (a table
 *   records a fact its columns name, a page holds prose: remember-tables.ts); then the pages about it:
 *   its title names the topic, or the point names its title; then a row it names and fills no column of;
 *   then a folder whose name or instructions for agents fit the point, and holds no page about it, as a
 *   place for a new page; then the rest. Within each, a page holding a sentence the
 *   point may change comes first, then by its passages' fused scores, its best first and each further
 *   one counting half the one before, a title naming the topic adding to them. A passage counts only
 *   when it shares a word with the point or its topic, a word search does not leave out as a stopword
 *   and not one inside an email or web address, or the semantic leg found it within the distance
 *   search keeps: numbers, dates and a page's title alone are no reason. A page found by words alone
 *   is left out when every one of them is common (more than one page found holds it), or when it has
 *   one rare word and the point names a page by its title or a page says the point already. Pages in
 *   the person's own My notes are offered only when nothing else is about the point.
 * - section: the heading of the best passage holding the point's words, never a page's title heading
 *   (null: the page's opening, or a page only its title fits); a section names the topic by the same
 *   word, never another form of it ("Accounts" is not "account").
 * - pages beside a named one: when the point names a page whose title reads as a name ("Initech's
 *   invoices", the topic "Initech contract"), the other pages in its folder are about something else
 *   of the same kind (Acme beside Initech in Customers): no candidates, and none of their sentences is
 *   one the point says or replaces. A sentence that names, by a possessive or such a page's title,
 *   someone the point does not ("Globex's refund window" for Acme's) is not one it replaces either.
 * - already_saved: sentences that say the point, word for word, as search normalises text, and
 *   state it: no question, no denial, nothing struck through (remember-text.ts); and cells of a row it
 *   names that hold what it says.
 * - possibly_replaces: other sentences of the best passages the point may make untrue, or that say
 *   it already in other words (likeness.ts); and cells of a row it names that hold another value.
 * - note: when only words were matched (semantic search off) and no page offered is about the point
 *   (none says it, holds a sentence it changes, is named by it, or holds two of its words), a page on
 *   it may be written in another language, which no word of it reaches: the plan says where to look.
 *
 * Each place says how the caller's write there would be reviewed, decided as a write decides it. The
 * person's own My notes is made the first time a plan needs it, and every plan names it, with the
 * pages in it, as the place a point goes when no page of the wiki fits.
 */
import { cutoffFor } from "@stuga/ai";
import type {
  AlreadySavedPassage,
  PlaceReview,
  RememberCandidate,
  RememberHome,
  RememberNewPage,
  RememberPlanBody,
  RememberPlanPoint,
  RememberPoint,
  RememberRowCandidate,
  ReplaceablePassage,
} from "@stuga/agent-surface/backend";
import {
  alikeSentences,
  askDocs,
  distinctWords,
  docsByTitle,
  getDoc,
  getFolderAncestors,
  getFolderSubtreeIds,
  getUsers,
  headingsOnly,
  listDocs,
  listFolders,
  namesTitle,
  openingHeadingLevel,
  possessiveNames,
  properNouns,
  readsAsName,
  savedSentences,
  sharedWords,
  stopwordsAmong,
  withoutAddresses,
  wordsOfPoint,
  type AskChunk,
  type DocRow,
  type FolderRow,
  type SketchCache,
} from "@stuga/db";
import { reviewLevelOf, type ReviewMode } from "@stuga/protocol/domain/events";
import { agentInstructions, instructionLevelLabel, type InstructionLevel } from "@stuga/protocol/domain/instructions";
import { queryVector } from "../api/search.js";
import type { Ctx } from "../auth/context.js";
import { canReadDoc, canReadFolder, canWriteDoc, canWriteFolder, personOf, scopeFolderIds } from "../authz/authz.js";
// The level the caller's own write gets, as the propose path decides it: an agent's by the item, a person's at review.
import { resolveReviewMode } from "../authz/review-mode.js";
import { docInstructionStack, folderInstructionStack } from "../documents/instructions.js";
import { myNotes } from "../documents/my-notes.js";
import { planTables, type PlacesOf, type RowTier } from "./remember-tables.js";
import { tableCache, type TableCache } from "./tables.js";

/** Passages one point's search returns: enough for five pages and the sentences beside them. */
const PASSAGES = 30;
/** Pages one point's title lookup returns: those whose approved text is empty have no passage to find. */
const TITLED_MAX = 10;
/** Pages read from a folder holding a page the point names: the pages beside it. */
const SIBLINGS_MAX = 500;
export const CANDIDATES_MAX = 5;
/** New pages one point is offered at most, beside the pages that exist. */
const NEW_PAGES_MAX = 2;
const ALREADY_SAVED_MAX = 3;
const REPLACES_MAX = 3;
/** The best passages whose sentences are compared with the point. */
const COMPARED_PASSAGES = 12;
const EXCERPT_CHARS = 240;
/** The weight a first place in one of the search's two rankings adds (1/(60+0)): a title naming the topic. */
const TOPIC_BONUS = 1 / 60;
const HOME_PAGES_MAX = 50;
const FOLDERS_WITH_INSTRUCTIONS_MAX = 20;
/** Folders read for the ones a new page could go in. */
const FOLDERS_READ_MAX = 500;
/**
 * How well a folder must fit a point to be offered for a new page: a word of the point or its topic
 * in its name counts two, each one in its instructions for agents one. So its name alone does, and
 * its instructions only when they name two of the point's words.
 */
const NEW_PAGE_FIT = 2;
/**
 * Said of a point no page found is about, when only its words were matched: a page on it written in another
 * language holds none of them.
 */
export const OTHER_LANGUAGE_NOTE =
  "No page found is about this point, and this plan matched its words only (semantic search is off): a page on it " +
  "may be written in another language. Before you make a new page, list the folder it belongs in (`folders`, then " +
  "`docs` action:list with its `parent_id`), or plan again with the point's key words in that language.";
/** Points searched at once: each holds a connection for its search. */
const CONCURRENCY = 4;
/** Why an agent's write in My notes waits or not, as `review.reason` says it of a document. */
const HOME_REASONS: Record<ReviewMode, string> = {
  auto: "AI edits to pages in My notes apply directly",
  review: "AI edits to pages in My notes wait for the user's review",
  colleague: "AI edits to pages in My notes wait for a colleague's approval",
};

/** A folder above a place that the caller cannot read, named in its path. */
const HIDDEN_FOLDER = "…";

/** What one plan reads once, however many points need it. */
interface PlanCache {
  docs: Map<string, Promise<DocRow | null>>;
  paths: Map<string, Promise<string[]>>;
  stacks: Map<string, Promise<InstructionLevel[]>>;
  sketches: SketchCache;
  folders: Promise<FolderRow[]> | null;
  /** The readable pages of a folder, by its id. */
  folderPages: Map<string, Promise<Array<{ doc_id: string; title: string }>>>;
  /** The folders of the person's My notes, itself included; empty when they have none. */
  mine: ReadonlySet<string>;
  /** The tables read, and what waits for their rows. */
  tables: TableCache;
}

const linkOf = (ctx: Ctx, docId: string): string => `${ctx.servedOrigin}/doc/${docId}`;

function once<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let kept = map.get(key);
  if (!kept) {
    kept = load();
    map.set(key, kept);
  }
  return kept;
}

/** The folders above an item, from the top, by title; a folder the caller cannot read is "…". */
function folderPath(ctx: Ctx, cache: PlanCache, folderId: string | null): Promise<string[]> {
  if (!folderId) return Promise.resolve([]);
  return once(cache.paths, folderId, async () =>
    (await getFolderAncestors(ctx.sql, folderId, ctx.workspaceId)).map((f) => (canReadFolder(ctx, f) ? f.title : HIDDEN_FOLDER)),
  );
}

/** The folders the caller can read, once per plan. */
function foldersOf(ctx: Ctx, cache: PlanCache): Promise<FolderRow[]> {
  cache.folders ??= listFolders(ctx.sql, ctx.principals, ctx.workspaceId, undefined, { scopeFolderIds: scopeFolderIds(ctx) }).then((all) =>
    all.slice(0, FOLDERS_READ_MAX),
  );
  return cache.folders;
}

/** A passage's opening, or the stretch around the first of `words` it holds, cut at word breaks. */
export function excerptOf(content: string, words: readonly string[], max = EXCERPT_CHARS): string {
  const text = content.replace(/^\s{0,3}#{1,6}\s.*\n+/, "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), Number.POSITIVE_INFINITY);
  let start = Number.isFinite(at) ? Math.max(0, at - Math.floor(max / 4)) : 0;
  if (start > 0) {
    const space = text.indexOf(" ", start);
    start = space >= 0 && space < at ? space + 1 : start;
  }
  let end = Math.min(text.length, start + max);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    end = space > start ? space : end;
  }
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * The heading of the section a passage sits under, for `markdown_append`: the last of its path, never
 * the page's own title heading (a level-one heading alone on its path), whose section is the whole page.
 */
export function sectionOf(passage: Pick<AskChunk, "heading_path" | "content">): string | null {
  const path = passage.heading_path?.split(" > ") ?? [];
  const last = path.at(-1)?.trim();
  if (!last) return null;
  if (path.length === 1 && openingHeadingLevel(passage.content) === 1) return null;
  return last;
}

/** Whether a title or heading names a topic: one holds the other, or they share a word ("Refund policy", "Refunds"). */
function names(text: string, topic: string): boolean {
  const a = text.toLowerCase().normalize("NFKC").trim();
  const b = topic.toLowerCase().normalize("NFKC").trim();
  if (a === "" || b === "") return false;
  return a.includes(b) || b.includes(a) || sharedWords(topic, text, 1).length > 0;
}

/** How a write by the caller to `doc` would be reviewed, as the propose path decides it. */
function docReview(ctx: Ctx, doc: DocRow): PlaceReview {
  const { mode, reason } = resolveReviewMode(ctx, doc);
  return { mode, reason };
}

/** How a write by the caller to a new page in `folder` would be reviewed: the level the folder gives what is in it. */
function folderReview(ctx: Ctx, folder: FolderRow): PlaceReview {
  const { mode, reason } = resolveReviewMode(ctx, {
    agent_mode: null,
    folder_agent_mode: reviewLevelOf(folder.agent_mode, folder.parent_agent_mode),
    database_agent_mode: null,
    // A page made in a shared My notes is shared as it is.
    notes_shared: folder.notes_shared,
  });
  return { mode, reason };
}

interface DocHit {
  doc: DocRow;
  /** Its passages that hold a word of the point or its topic, or that meaning found, best first. */
  passages: AskChunk[];
  score: number;
  /** The point's words its passages hold, stopwords left out. */
  words: Set<string>;
  /** The topic's words they hold. */
  topicWords: Set<string>;
  /** The semantic leg found one of its passages within the distance search keeps. */
  semantic: boolean;
  /** Some of its text is approved and indexed: false for a page found by its title alone whose text all waits. */
  hasText: boolean;
}

/** The candidates' order, and which pages are about the point. */
interface RankedHit extends DocHit {
  titled: boolean;
  sectioned: boolean;
  /** Its title names the topic, or the point names its title: the page is about it. */
  about: boolean;
  mine: boolean;
  rank: number;
  /** The passage a point would join: the best one holding a word of the point; null when only its title fits. */
  place: AskChunk | null;
}

/** The folders a new page on the point could go in, best first. */
async function newPagesFor(
  ctx: Ctx,
  cache: PlanCache,
  point: RememberPoint,
  levels: Map<string, InstructionLevel>,
  taken: ReadonlySet<string>,
  stop: ReadonlySet<string>,
): Promise<RememberNewPage[]> {
  const said = [point.topic, withoutAddresses(point.text)].filter(Boolean).join("\n");
  const fits: Array<{ folder: FolderRow; fit: number; named: string[]; instructed: string[] }> = [];
  for (const folder of await foldersOf(ctx, cache)) {
    if (cache.mine.has(folder.folder_id) || taken.has(folder.folder_id) || !canWriteFolder(ctx, folder)) continue;
    const named = sharedWords(said, folder.title).filter((w) => !stop.has(w));
    const instructed = folder.agent_instructions.trim() === "" ? [] : sharedWords(said, folder.agent_instructions).filter((w) => !stop.has(w));
    const fit = named.length * 2 + instructed.length;
    if (fit >= NEW_PAGE_FIT) fits.push({ folder, fit, named, instructed });
  }
  fits.sort((a, b) => b.fit - a.fit || a.folder.title.localeCompare(b.folder.title) || a.folder.folder_id.localeCompare(b.folder.folder_id));
  const out: RememberNewPage[] = [];
  for (const { folder, named, instructed } of fits.slice(0, NEW_PAGES_MAX)) {
    const stack = await once(cache.stacks, `folder:${folder.folder_id}`, () => folderInstructionStack(ctx, folder.folder_id));
    for (const level of stack) levels.set(`${level.kind}:${level.id}`, level);
    const below = stack.filter((l) => l.kind !== "workspace").map(instructionLevelLabel);
    const why = [
      named.length > 0 ? `its name "${folder.title}" fits the point's words ${named.join(", ")}` : null,
      instructed.length > 0 ? `its instructions for agents name ${instructed.join(", ")}` : null,
      "no page in it is about the point",
    ].filter((r): r is string => r !== null);
    out.push({
      kind: "new_page",
      folder_id: folder.folder_id,
      folder_path: [...(await folderPath(ctx, cache, folder.parent_id)), folder.title],
      why: why.join("; "),
      review: folderReview(ctx, folder),
      ...(below.length > 0 ? { instructions_labels: below } : {}),
    });
  }
  return out;
}

/** The readable pages in a folder, once per plan: the pages beside one a point names. */
function pagesIn(ctx: Ctx, cache: PlanCache, folderId: string): Promise<Array<{ doc_id: string; title: string }>> {
  return once(cache.folderPages, folderId, async () =>
    (await listDocs(ctx.sql, ctx.principals, ctx.workspaceId, { parentId: folderId, scopeFolderIds: scopeFolderIds(ctx) }))
      .slice(0, SIBLINGS_MAX)
      .map((d) => ({ doc_id: d.doc_id, title: d.title })),
  );
}

/** Whether a sentence names a page's title as a name: its words, the first written with its capital. */
function mentions(sentence: string, title: string): boolean {
  const first = title.trim().split(/\s+/u)[0] ?? "";
  return /^\p{Lu}/u.test(first) && sentence.includes(first) && namesTitle(sentence, title);
}

/** A title as entity sets compare it. */
const keyOf = (title: string): string => title.normalize("NFKC").toLowerCase().trim();

/** One point's plan, and the instruction levels its places name. */
async function planPoint(
  ctx: Ctx,
  cache: PlanCache,
  point: RememberPoint,
  index: number,
  semantic: boolean,
  levels: Map<string, InstructionLevel>,
): Promise<{ plan: RememberPlanPoint; degraded: boolean }> {
  // Where it came from is no part of what it says: the source never steers the search.
  const query = [point.topic, point.text].filter(Boolean).join("\n").slice(0, 4000);
  const ai = ctx.env.aiSettings.current();
  const vector = semantic ? await queryVector(ctx, query) : null;
  const gate = {
    principals: ctx.principals,
    workspaceId: ctx.workspaceId,
    query,
    scopeFolderIds: scopeFolderIds(ctx),
    searchLanguages: () => ctx.env.searchLanguages.current(),
  };
  // A page whose approved text is empty has no passage to find: its title still names it.
  const [passages, titledDocs] = await Promise.all([
    askDocs(ctx.sql, { ...gate, queryEmbedding: vector, embeddingDims: ctx.env.embeddingDims, limit: PASSAGES }),
    docsByTitle(ctx.sql, { ...gate, limit: TITLED_MAX }),
  ]);
  // Search drops a passage found by meaning alone past this distance; so does a plan.
  const cutoff = vector ? cutoffFor(query, ai.embed.searchCutoff) : null;
  const topic = point.topic ?? null;
  // An address says where to send something, not what the point is about.
  const said = withoutAddresses(point.text);
  const inMine = (doc: DocRow) => doc.parent_id !== null && cache.mine.has(doc.parent_id);
  // A word search leaves out ("with", "their") is no reason to name a place.
  const stop = await stopwordsAmong(ctx.sql, [...wordsOfPoint(said), ...wordsOfPoint(topic ?? "")], ctx.env.searchLanguages.current());
  const evidence = (words: string[]) => words.filter((w) => !stop.has(w));

  // The rows of tables the point names, or a new row of one it fits: read beside the pages.
  const tables = await planTables(ctx, cache.tables, point, placesOf(ctx, cache, levels), stop);

  const hits = new Map<string, DocHit>();
  const kept: Array<{ passage: AskChunk; doc: DocRow }> = [];
  /** Every page the search reached, by id: the pages a point may name by title. */
  const known = new Map<string, DocRow>();
  /** The pages each word was found in: a word many pages hold is a common one. */
  const pagesOfWord = new Map<string, Set<string>>();
  const readable = async (docId: string) => {
    const doc = await once(cache.docs, docId, () => getDoc(ctx.sql, docId));
    return doc && !doc.trashed && canReadDoc(ctx, doc) ? doc : null;
  };
  for (const passage of passages) {
    const doc = await readable(passage.doc_id);
    if (!doc) continue;
    known.set(doc.doc_id, doc);
    // A heading with no text of its own fits nothing (an index written before such passages were left out).
    if (headingsOnly(passage.content)) continue;
    // A word inside the passage's own addresses ("travel@northwind.example") is no more a reason than one in the point's.
    const plain = withoutAddresses(passage.content);
    const words = evidence(sharedWords(said, plain, 12));
    const topicWords = topic ? evidence(sharedWords(topic, plain)) : [];
    // The fused scores come back as Postgres numerics, in text.
    const score = Number(passage.score);
    const near = vector !== null && Number(passage.sem_score) > 0 && (cutoff === null || Number(passage.sem_score) >= 1 - cutoff);
    // A passage that shares no word with the point or its topic, and that meaning did not find, was
    // found by a number, a date or its page's title alone: no reason to name it.
    if (words.length === 0 && topicWords.length === 0 && !near) continue;
    for (const w of [...words, ...topicWords]) {
      const pages = pagesOfWord.get(w) ?? new Set<string>();
      pages.add(doc.doc_id);
      pagesOfWord.set(w, pages);
    }
    kept.push({ passage, doc });
    const hit = hits.get(doc.doc_id);
    if (hit) {
      hit.score += score * 0.5 ** hit.passages.length;
      hit.passages.push(passage);
      for (const w of words) hit.words.add(w);
      for (const w of topicWords) hit.topicWords.add(w);
      hit.semantic ||= near;
    } else {
      hits.set(doc.doc_id, { doc, passages: [passage], score, words: new Set(words), topicWords: new Set(topicWords), semantic: near, hasText: true });
    }
  }
  // Pages the topic or the point names by title, whether or not a passage of theirs holds its words: one
  // the passage search reached when the topic shares a word of its title, as for any page; one only the
  // title lookup found (its approved text empty, or its passages crowded out) when they name all of it.
  const namesAll = (title: string) => (topic !== null && namesTitle(topic, title)) || namesTitle(said, title);
  const hasText = new Map(titledDocs.map((t) => [t.doc_id, t.has_text] as const));
  for (const t of titledDocs) {
    if (known.has(t.doc_id) || !namesAll(t.title)) continue;
    const doc = await readable(t.doc_id);
    if (doc) known.set(doc.doc_id, doc);
  }
  for (const doc of known.values()) {
    if (hits.has(doc.doc_id) || !((topic !== null && names(doc.title, topic)) || namesAll(doc.title))) continue;
    hits.set(doc.doc_id, { doc, passages: [], score: 0, words: new Set(), topicWords: new Set(), semantic: false, hasText: hasText.get(doc.doc_id) ?? true });
  }

  // The pages the point is about by name ("Initech's invoices", the topic "Initech contract"): it names
  // their title, which reads as a name, never written in lower case ("Refunds" and "Travel" are words). A
  // page beside one of them in its folder is about something else of the same kind (Acme beside Initech
  // in Customers): no place for the point, and none of its sentences is one the point replaces.
  const texts = [said, topic ?? "", ...kept.map((k) => withoutAddresses(k.passage.content))];
  // The pages whose whole title the point or its topic names, a name or a word ("Writing preferences").
  const namedFully = [...known.values()].filter((d) => namesAll(d.title));
  const named = namedFully.filter((d) => d.parent_id !== null && readsAsName(d.title, texts));
  const namedIds = new Set(named.map((d) => d.doc_id));
  const beside = new Map<string, string>();
  for (const folderId of new Set(named.map((d) => d.parent_id!))) {
    for (const p of await pagesIn(ctx, cache, folderId)) if (!namedIds.has(p.doc_id)) beside.set(p.doc_id, p.title);
  }
  // The names the point is about, and whether a sentence is about another: it names, by a possessive or a
  // page's title beside a named one, someone the point does not.
  const pointNames = new Set([...named.map((d) => keyOf(d.title)), ...possessiveNames(point.text), ...properNouns(point.text)]);
  const aboutAnother = (sentence: string): boolean => {
    if (pointNames.size === 0) return false;
    const theirs = new Set(possessiveNames(sentence));
    for (const title of beside.values()) if (mentions(sentence, title)) theirs.add(keyOf(title));
    return theirs.size > 0 && ![...theirs].some((n) => pointNames.has(n));
  };

  // Decided sentence by sentence: the sentences that say the point are not what it replaces.
  const alreadySaved: AlreadySavedPassage[] = [];
  const saidThere = new Set<string>();
  const holding = new Set<string>();
  for (const { passage, doc } of kept) {
    if (beside.has(doc.doc_id)) continue;
    const sentences = savedSentences(passage.content, point.text);
    if (!sentences) continue;
    for (const sentence of sentences) saidThere.add(`${doc.doc_id}\u0000${sentence}`);
    if (holding.has(doc.doc_id) || alreadySaved.length >= ALREADY_SAVED_MAX) continue;
    holding.add(doc.doc_id);
    alreadySaved.push({
      doc_id: doc.doc_id,
      title: doc.title,
      heading_path: passage.heading_path,
      sentence: sentences.join(" "),
      excerpt: excerptOf(passage.content, sharedWords(point.text, passage.content)),
      ...(inMine(doc) ? { in_my_notes: true as const } : {}),
      url: linkOf(ctx, doc.doc_id),
    });
  }

  const replaces: Array<ReplaceablePassage & { overlap: number }> = [];
  const seen = new Set<string>();
  for (const { passage, doc } of kept.slice(0, COMPARED_PASSAGES)) {
    if (doc.doc_type !== "prose" || beside.has(doc.doc_id)) continue;
    for (const alike of alikeSentences(point.text, passage.content, cache.sketches)) {
      const key = `${doc.doc_id}\u0000${alike.sentence}`;
      if (seen.has(key) || saidThere.has(key) || aboutAnother(alike.sentence)) continue;
      seen.add(key);
      replaces.push({
        doc_id: doc.doc_id,
        title: doc.title,
        heading_path: passage.heading_path,
        sentence: alike.sentence,
        hint: alike.hint,
        can_edit: canWriteDoc(ctx, doc) && !doc.locked,
        review: docReview(ctx, doc),
        ...(inMine(doc) ? { in_my_notes: true as const } : {}),
        url: linkOf(ctx, doc.doc_id),
        overlap: alike.overlap,
      });
    }
  }
  const possiblyReplaces = replaces
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, REPLACES_MAX)
    .map(({ overlap: _overlap, ...r }) => r);

  // The pages that say the point already come first: a new page or another place beside them would say it twice.
  const holders = new Set([...alreadySaved.map((a) => a.doc_id), ...possiblyReplaces.filter((r) => r.hint === "likely_duplicate").map((r) => r.doc_id)]);
  const replacing = new Set(possiblyReplaces.filter((r) => r.hint === "possibly_replaces").map((r) => r.doc_id));

  const ranked: RankedHit[] = [...hits.values()]
    .filter((h) => h.doc.doc_type === "prose" && canWriteDoc(ctx, h.doc) && !h.doc.locked && !beside.has(h.doc.doc_id))
    .map((h) => {
      const place =
        h.passages.find((p) => {
          const plain = withoutAddresses(p.content);
          return evidence(sharedWords(said, plain)).length > 0 || (topic !== null && evidence(sharedWords(topic, plain)).length > 0);
        }) ?? (h.semantic ? (h.passages[0] ?? null) : null);
      const section = place ? sectionOf(place) : null;
      const titled = topic !== null && names(h.doc.title, topic);
      // A section names the topic by the same word ("Contract" for "Initech contract"), never by another form of it ("Accounts" for "account").
      const sectioned = topic !== null && !titled && section !== null && evidence(sharedWords(topic, section, 6, true)).length > 0;
      const about = titled || namesTitle(said, h.doc.title);
      return { ...h, place, titled, sectioned, about, mine: inMine(h.doc), rank: h.score + (titled ? TOPIC_BONUS : sectioned ? TOPIC_BONUS / 2 : 0) };
    })
    .sort(
      (a, b) =>
        Number(replacing.has(b.doc.doc_id)) - Number(replacing.has(a.doc.doc_id)) || b.rank - a.rank || a.doc.doc_id.localeCompare(b.doc.doc_id),
    );

  /** How many pages found hold a word, in any of its forms. */
  const pagesHolding = (word: string): number => {
    const pages = new Set<string>();
    for (const [w, holding] of pagesOfWord) if (distinctWords([word, w]).length === 1) for (const id of holding) pages.add(id);
    return pages.size;
  };
  // A page found by words alone, and only by common ones ("contract", "days": more than one page found holds
  // them), rests on a coincidence, and is left out; one found by a single rare word ("buddy") is a reason to
  // look there, unless the point or its topic names a page by its title, a page says the point already, or a
  // table's row takes it (it names the row and a column, or the table and a column).
  const rowTakes = tables.candidates.some((c) => c.tier !== "weak");
  const weak = (h: RankedHit): boolean => {
    if (h.titled || h.about || h.semantic || holders.has(h.doc.doc_id) || replacing.has(h.doc.doc_id)) return false;
    const rare = distinctWords([...h.words, ...h.topicWords]).filter((w) => pagesHolding(w) < 2);
    return rare.length === 0 || (rare.length < 2 && (namedFully.length > 0 || holders.size > 0 || rowTakes));
  };

  // A page holding the point first; then a page of the wiki about it; else a folder a new page on it belongs in; then the rest.
  const holdersFirst = ranked.filter((h) => holders.has(h.doc.doc_id));
  const aboutIt = ranked.filter((h) => !holders.has(h.doc.doc_id) && !h.mine && h.about);
  const taken = new Set([...holdersFirst, ...aboutIt].map((h) => h.doc.parent_id ?? ""));
  const newPages = await newPagesFor(ctx, cache, point, levels, taken, stop);
  // The person's own notes only when nothing of the wiki is about the point: a page, a folder or a table.
  const fits = holdersFirst.length > 0 || aboutIt.length > 0 || newPages.length > 0 || tables.candidates.length > 0;
  const rest = ranked
    .filter((h) => !holders.has(h.doc.doc_id) && (!h.about || h.mine))
    .filter((h) => !fits || !h.mine)
    .filter((h) => !weak(h));

  const candidates: Array<RememberCandidate | RememberRowCandidate | RememberNewPage> = [];
  const rowsOf = (tier: RowTier) => tables.candidates.filter((c) => c.tier === tier).map((c) => c.candidate);
  // A page is about the point when it says it, holds a sentence it changes, is named by it or its topic, was found
  // by meaning, or holds two of its words; one found by a single word may be a coincidence.
  let about = false;
  const strong = (h: RankedHit): boolean =>
    holders.has(h.doc.doc_id) || replacing.has(h.doc.doc_id) || h.about || h.sectioned || h.semantic || distinctWords([...h.words, ...h.topicWords]).length >= 2;
  const pageOf = async (h: RankedHit): Promise<RememberCandidate> => {
    about ||= strong(h);
    const stack = await once(cache.stacks, `doc:${h.doc.doc_id}`, () => docInstructionStack(ctx, h.doc));
    for (const level of stack) levels.set(`${level.kind}:${level.id}`, level);
    const below = stack.filter((l) => l.kind !== "workspace").map(instructionLevelLabel);
    const words = [...h.words].slice(0, 6);
    const section = h.place ? sectionOf(h.place) : null;
    const shown = h.place ?? h.passages[0] ?? null;
    const why = [
      holders.has(h.doc.doc_id) ? "it says the point already" : null,
      replacing.has(h.doc.doc_id) ? "it holds a sentence the point may change" : null,
      h.titled ? `its title names the topic "${topic}"` : null,
      !h.titled && h.about ? "the point names its title" : null,
      h.sectioned ? `its section "${section}" names the topic "${topic}"` : null,
      words.length > 0 ? `it holds the point's words ${words.join(", ")}` : null,
      words.length === 0 && !h.titled && !h.sectioned && h.topicWords.size > 0 ? `it holds the topic's words ${[...h.topicWords].slice(0, 6).join(", ")}` : null,
      // Said only when the semantic leg found it: a keyword match is never "close in meaning".
      h.semantic ? "it is close in meaning" : null,
      h.passages.length > 1 ? `${h.passages.length} of its passages match` : null,
      h.passages.length === 0 && !h.hasText ? "none of its text is approved yet: read it to see the changes that wait there" : null,
    ].filter((r): r is string => r !== null);
    return {
      kind: "page",
      doc_id: h.doc.doc_id,
      title: h.doc.title,
      folder_path: await folderPath(ctx, cache, h.doc.parent_id),
      section,
      heading_path: h.place?.heading_path ?? null,
      why: why.join("; "),
      excerpt: shown ? excerptOf(shown.content, words) : "",
      review: docReview(ctx, h.doc),
      ...(below.length > 0 ? { instructions_labels: below } : {}),
      ...(h.mine ? { in_my_notes: true as const } : {}),
      url: linkOf(ctx, h.doc.doc_id),
    };
  };
  // Pages that say it, then a row that does; a row it fills before the pages about it, as a table records a
  // fact its columns name; then a row it names but fills no column of, before a folder for a new page.
  const add = (c: RememberCandidate | RememberRowCandidate | RememberNewPage) => {
    if (candidates.length < CANDIDATES_MAX) candidates.push(c);
  };
  for (const h of holdersFirst) add(await pageOf(h));
  for (const r of [...rowsOf("holds"), ...rowsOf("fits")]) add(r);
  for (const h of aboutIt) add(await pageOf(h));
  for (const r of rowsOf("weak")) add(r);
  for (const n of newPages) add(n);
  for (const h of rest) add(await pageOf(h));
  if (tables.candidates.length > 0 || tables.alreadySaved.length > 0 || tables.replaces.length > 0) about = true;

  return {
    plan: {
      index,
      text: point.text,
      topic,
      source: point.source ?? null,
      candidates,
      already_saved: [...alreadySaved, ...tables.alreadySaved.slice(0, ALREADY_SAVED_MAX)],
      possibly_replaces: [...possiblyReplaces, ...tables.replaces.slice(0, REPLACES_MAX)],
      // Meaning crosses languages; words do not.
      ...(!about && vector === null ? { note: OTHER_LANGUAGE_NOTE } : {}),
    },
    degraded: semantic && vector === null,
  };
}

/** What a table's place reads once per plan: its folder path, its instructions' labels, how a write there is reviewed. */
function placesOf(ctx: Ctx, cache: PlanCache, levels: Map<string, InstructionLevel>): PlacesOf {
  return {
    folderPath: (folderId) => folderPath(ctx, cache, folderId),
    async instructionLabels(doc) {
      const stack = await once(cache.stacks, `doc:${doc.doc_id}`, () => docInstructionStack(ctx, doc));
      for (const level of stack) levels.set(`${level.kind}:${level.id}`, level);
      return stack.filter((l) => l.kind !== "workspace").map(instructionLevelLabel);
    },
    review: (doc) => docReview(ctx, doc),
    origin: ctx.servedOrigin,
  };
}

/** Run `work` over `items`, at most `limit` at a time, keeping their order. */
async function inTurn<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!, i);
    }
  });
  await Promise.all(lanes);
  return out;
}

/** The person's My notes for the plan, with its pages and folders, or why there is none. */
async function homeOf(
  ctx: Ctx,
  cache: Omit<PlanCache, "mine">,
  levels: Map<string, InstructionLevel>,
): Promise<{ home: RememberHome | null; note?: string; mine: ReadonlySet<string> }> {
  const notes = await myNotes(ctx);
  if ("refusal" in notes) {
    return { home: null, note: `No My notes for this connection: ${notes.refusal}. Save into a page of the wiki instead.`, mine: new Set() };
  }
  const { folder, created } = notes;
  const stack = await once(cache.stacks, `folder:${folder.folder_id}`, () => folderInstructionStack(ctx, folder.folder_id));
  for (const level of stack) levels.set(`${level.kind}:${level.id}`, level);
  const [pages, subtree]: [RememberHome["pages"], string[]] = created
    ? [[], [folder.folder_id]]
    : await Promise.all([
        listDocs(ctx.sql, ctx.principals, ctx.workspaceId, { parentId: folder.folder_id, scopeFolderIds: scopeFolderIds(ctx) }).then((docs) =>
          docs
            .filter((d) => d.doc_type === "prose")
            .slice(0, HOME_PAGES_MAX)
            .map((d) => ({ doc_id: d.doc_id, title: d.title })),
        ),
        getFolderSubtreeIds(ctx.sql, folder.folder_id, ctx.workspaceId),
      ]);
  // Its own level, else the one above it if the person moved it and cleared its own; a person's own write waits for them.
  const resolved = folderReview(ctx, folder);
  const review = ctx.isAgent ? { mode: resolved.mode, reason: HOME_REASONS[resolved.mode] } : resolved;
  // Whether anyone else reads it now: the person may have shared it, as any folder they own.
  const shared = folder.notes_shared ?? folder.acl_principals.some((p) => p !== `user:${personOf(ctx)}`);
  return { home: { folder_id: folder.folder_id, title: folder.title, created, shared, review, pages }, mine: new Set(subtree) };
}

/** The folders whose instructions for agents say what belongs in them, so a new page goes where they say. */
async function foldersWithInstructions(
  ctx: Ctx,
  cache: PlanCache,
  levels: Map<string, InstructionLevel>,
): Promise<NonNullable<RememberPlanBody["folders_with_instructions"]>> {
  // By title, as listFolders orders them.
  const folders = (await foldersOf(ctx, cache)).filter((f) => f.agent_instructions.trim() !== "").slice(0, FOLDERS_WITH_INSTRUCTIONS_MAX);
  const out: NonNullable<RememberPlanBody["folders_with_instructions"]> = [];
  for (const f of folders) {
    const stack = await once(cache.stacks, `folder:${f.folder_id}`, () => folderInstructionStack(ctx, f.folder_id));
    for (const level of stack) levels.set(`${level.kind}:${level.id}`, level);
    out.push({
      folder_id: f.folder_id,
      path: await folderPath(ctx, cache, f.folder_id),
      instructions_label: instructionLevelLabel({ kind: "folder", title: f.title }),
    });
  }
  return out;
}

/** Whom the connection acts for, by the name and username Stuga knows them by. */
async function userOf(ctx: Ctx): Promise<RememberPlanBody["user"]> {
  const [row] = await getUsers(ctx.sql, [personOf(ctx)], ctx.workspaceId).catch(() => []);
  return row ? { name: row.display_name || row.username, username: row.username } : null;
}

/** Where each point belongs, as the caller can see the workspace. */
export async function planRemember(ctx: Ctx, points: readonly RememberPoint[]): Promise<RememberPlanBody> {
  const base: Omit<PlanCache, "mine"> = {
    docs: new Map(),
    paths: new Map(),
    stacks: new Map(),
    sketches: new Map(),
    folders: null,
    folderPages: new Map(),
    tables: tableCache(),
  };
  const levels = new Map<string, InstructionLevel>();
  const semantic = ctx.env.aiSettings.current().embed.enabled;
  // My notes first: a plan that makes it lists it, and its pages are told apart from the wiki's.
  const [{ home, note, mine }, user] = await Promise.all([homeOf(ctx, base, levels), userOf(ctx)]);
  const cache: PlanCache = { ...base, mine };
  const planned = await inTurn(points, CONCURRENCY, (point, i) => planPoint(ctx, cache, point, i, semantic, levels));
  const folders = await foldersWithInstructions(ctx, cache, levels);
  // The workspace's level first, then folders from the top down, as each stack has them.
  const order = { workspace: 0, folder: 1, database: 2, document: 3 } as const;
  const union = [...levels.values()].sort((a, b) => order[a.kind] - order[b.kind]);
  return {
    user,
    points: planned.map((p) => p.plan),
    home,
    ...(note ? { home_note: note } : {}),
    ...(folders.length > 0 ? { folders_with_instructions: folders } : {}),
    ...agentInstructions(union),
    semantic: semantic && planned.some((p) => !p.degraded),
    degraded: planned.some((p) => p.degraded),
  };
}
