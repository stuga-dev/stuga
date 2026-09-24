/**
 * `/api/me/nodes`: a person's bookmarks to other Stuga nodes, which the
 * workspace switcher opens with a plain navigation. Account-level, so it works
 * before the person has a workspace; the route table refuses agent keys.
 */
import { addUserNode, listUserNodes, removeUserNode, type UserNodeRow } from "@stuga/db";
import {
  MAX_NODE_LABEL_CHARS,
  MAX_OTHER_NODES,
  type OtherNode,
  type OtherNodes,
} from "@stuga/protocol/api/other-nodes";
import { UNSAFE_TEXT, hasVisibleText } from "@stuga/protocol/domain/node-name";
import { error, json } from "../http/respond.js";
import type { AccountCall } from "../http/router.js";
import { newId } from "../ids.js";

/** Longest URL taken, of which only the origin is kept. */
const MAX_URL_CHARS = 2048;

/** One status has several outcomes here, so each refusal carries a code beside its sentence. */
function refuse(status: number, code: string, message: string): Response {
  return json({ error: code, message }, { status });
}

function nodeView(row: UserNodeRow): OtherNode {
  return { id: row.id, label: row.label, origin: row.origin };
}

export async function listOtherNodes({ ctx }: AccountCall): Promise<Response> {
  const rows = await listUserNodes(ctx.sql, ctx.alias);
  const body: OtherNodes = {
    current: { name: ctx.env.settings.current().nodeLabel, origin: ctx.env.publicOrigin },
    nodes: rows.map(nodeView),
  };
  return json(body);
}

/** An absolute http(s) URL, or null. */
function parseNodeUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > MAX_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

export async function addOtherNode({ ctx, req }: AccountCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { label?: unknown; url?: unknown } | null;
  const url = parseNodeUrl(body?.url);
  if (!url) return refuse(400, "invalid_url", "url must be an absolute http or https address");
  if (url.origin === ctx.env.publicOrigin || ctx.env.extraOrigins.includes(url.origin)) {
    return refuse(400, "own_node", "that is this node's own address");
  }

  const raw = body?.label ?? "";
  if (typeof raw !== "string") return refuse(400, "invalid_label", "label must be text");
  // The host stays in its ASCII form, so a look-alike Unicode name cannot pass for a familiar one.
  const label = raw.trim() || url.host.slice(0, MAX_NODE_LABEL_CHARS);
  if (label.length > MAX_NODE_LABEL_CHARS) {
    return refuse(400, "invalid_label", `label must be ${MAX_NODE_LABEL_CHARS} characters or fewer`);
  }
  if (UNSAFE_TEXT.test(label)) return refuse(400, "invalid_label", "label cannot contain control characters");
  if (!hasVisibleText(label)) return refuse(400, "invalid_label", "label must contain a visible character");

  const added = await addUserNode(
    ctx.sql,
    { id: newId("nb_"), alias: ctx.alias, label, origin: url.origin },
    MAX_OTHER_NODES,
  );
  if (!added.ok) {
    return added.reason === "already_added"
      ? refuse(409, "already_added", "that node is already in your list")
      : refuse(409, "limit_reached", `you can keep at most ${MAX_OTHER_NODES} other nodes`);
  }
  return json({ node: nodeView(added.node) }, { status: 201 });
}

export async function removeOtherNode({ ctx, match }: AccountCall): Promise<Response> {
  // Keyed on the caller too, so someone else's id answers as if it did not exist.
  if (!(await removeUserNode(ctx.sql, ctx.alias, match[1]!))) return error(404, "not found");
  return new Response(null, { status: 204 });
}
