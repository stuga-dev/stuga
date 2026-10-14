/**
 * A node that keeps one document's comments in memory and answers the co-author's comment routes as
 * the real one does: thread reads with raw author ids, posts as `panel:<alias>`, and the asked
 * notice. Every other internal call gets an empty answer.
 */
import { vi } from "vitest";
import type { AiConfig } from "@stuga/ai";
import type { InternalApi } from "@stuga/runtime";
import { disabledAi, type Harness } from "./harness.js";

export interface StubComment {
  num: number;
  parent_num: number | null;
  author: string;
  body: string;
  created_at: string;
  resolved?: boolean;
  anchor_start?: string | null;
  anchor_end?: string | null;
  anchor_quote?: string | null;
}

export interface ThreadNode {
  comments: StubComment[];
  /** What `/internal/comment-thread` says of the person's write access. */
  canWrite: boolean;
  /** The document's review setting. */
  review: "review" | "auto";
  /** Set to refuse every comment post with this status. */
  refusePosts: number | null;
  calls: Array<{ path: string; body: Record<string, unknown> }>;
  /** The calls to one route, by body. */
  bodies(path: string): Array<Record<string, unknown>>;
  /** Add a comment as a person would over REST. */
  add(c: Omit<StubComment, "num" | "created_at"> & { num?: number }): StubComment;
}

let clock = Date.UTC(2026, 9, 1);
const stamp = () => new Date((clock += 1000)).toISOString();

/** A node with AI on and these comments; `h.env.internal` answers from it. */
export function threadNode(h: Harness, comments: Array<Omit<StubComment, "num" | "created_at"> & { num?: number }> = []): ThreadNode {
  const base = disabledAi();
  const ai: AiConfig = { ...base, enabled: true, chat: { ...base.chat, enabled: true }, embed: { ...base.embed, enabled: true } };
  h.env.ai = () => ai;

  const node: ThreadNode = {
    comments: [],
    canWrite: true,
    review: "review",
    refusePosts: null,
    calls: [],
    bodies: (path) => node.calls.filter((c) => c.path === path).map((c) => c.body),
    add: (c) => {
      const num = c.num ?? Math.max(0, ...node.comments.map((x) => x.num)) + 1;
      const row: StubComment = { ...c, num, created_at: stamp() };
      node.comments.push(row);
      return row;
    },
  };
  for (const c of comments) node.add(c);

  const fetch: InternalApi["fetch"] = async (path, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const route = String(path);
    node.calls.push({ path: route, body });
    switch (route) {
      case "/internal/comment-thread": {
        const root = node.comments.find((c) => c.num === body.num && c.parent_num === null);
        if (!root) return Response.json({ error: "comment not found" }, { status: 404 });
        const replies = node.comments.filter((c) => c.parent_num === root.num).sort((a, b) => a.num - b.num);
        return Response.json({
          can_write: node.canWrite,
          resolved: root.resolved === true,
          anchor_quote: root.anchor_quote ?? null,
          messages: [root, ...replies].map(({ num, parent_num, author, body: text, created_at }) => ({ num, parent_num, author, body: text, created_at })),
        });
      }
      case "/internal/comment": {
        if (node.refusePosts !== null) return Response.json({ error: "no comment access" }, { status: node.refusePosts });
        const parent = typeof body.parent_num === "number" ? body.parent_num : null;
        if (parent !== null) {
          const root = node.comments.find((c) => c.num === parent);
          const closed = !root || root.parent_num !== null || root.resolved || root.created_at !== body.parent_created_at;
          if (closed) return Response.json({ error: "thread closed" }, { status: 409 });
        }
        const row = node.add({
          parent_num: parent,
          author: `panel:${String(body.alias)}`,
          body: String(body.body),
          anchor_start: (body.anchor_start as string | null | undefined) ?? null,
          anchor_end: (body.anchor_end as string | null | undefined) ?? null,
          anchor_quote: (body.anchor_quote as string | null | undefined) ?? null,
        });
        return Response.json(row, { status: 201 });
      }
      case "/internal/coauthor-asked":
        return new Response(null, { status: 204 });
      case "/internal/review-mode":
        return Response.json({ mode: node.review });
      default:
        return Response.json({ levels: [], docs: [] });
    }
  };
  h.env.internal = { fetch: vi.fn(fetch) };
  return node;
}
