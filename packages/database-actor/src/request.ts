/** Request parsing shared by every route, and the refusal type routes throw. */
import { DATABASE_MAX_COLUMN_DESCRIPTION_CHARS, DATABASE_MAX_DISPLAY_LENGTH } from "@stuga/protocol/databases/limits";
import type { DatabaseActor as DatabaseActorIdentity } from "@stuga/protocol/databases/types";

/** A refusal with a known HTTP shape. Anything else thrown is a bug and answers 500. */
export class OpError extends Error {
  constructor(
    readonly status: number,
    readonly slug: string,
    message: string,
    /** Extra fields for the error body. */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type Body = Record<string, unknown>;

export function errorResponse(status: number, slug: string, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: slug, message, ...extra }, { status });
}

export function conflict(message: string): OpError {
  return new OpError(409, "conflict", message);
}

export async function readJson(req: Request): Promise<Body> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new OpError(400, "bad_request", "body must be valid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OpError(400, "bad_request", "body must be a JSON object");
  }
  return body as Body;
}

/** The node resolves identity; this checks shape only, never authorization. */
export function parseActor(body: Body): DatabaseActorIdentity {
  const a = body.actor as Body | undefined;
  if (!a || typeof a !== "object" || typeof a.alias !== "string" || a.alias === "" || typeof a.is_agent !== "boolean") {
    throw new OpError(400, "bad_actor", "mutations require actor: {alias, is_agent}");
  }
  return {
    alias: a.alias,
    is_agent: a.is_agent,
    ...(typeof a.on_behalf_of === "string" && a.on_behalf_of !== "" ? { on_behalf_of: a.on_behalf_of } : {}),
  };
}

/** How many ledger ops to keep once this write lands (0 = never prune); the node sends its setting on every mutation. */
export function parseOpsKeep(body: Body): number {
  const v = body.ops_keep;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new OpError(400, "validation", "mutations require ops_keep: a whole number of ops, 0 or more");
  }
  return v;
}

export function requireDisplay(v: unknown, field = "display"): string {
  if (typeof v !== "string") throw new OpError(400, "validation", `${field} must be a string`);
  const t = v.trim();
  if (t === "") throw new OpError(400, "validation", `${field} must not be empty`);
  if (t.length > DATABASE_MAX_DISPLAY_LENGTH) {
    throw new OpError(400, "validation", `${field} too long (max ${DATABASE_MAX_DISPLAY_LENGTH} chars)`);
  }
  return t;
}

/** A column's description: stored trimmed, and absent, empty or whitespace-only means none. */
export function parseDescription(v: unknown, field = "description"): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new OpError(400, "validation", `${field} must be a string`);
  const t = v.trim();
  if (t === "") return null;
  if (t.length > DATABASE_MAX_COLUMN_DESCRIPTION_CHARS) {
    throw new OpError(400, "validation", `${field} too long (max ${DATABASE_MAX_COLUMN_DESCRIPTION_CHARS} chars)`);
  }
  return t;
}

export function requireId(v: unknown, field: string): string {
  if (typeof v !== "string" || v === "") throw new OpError(400, "validation", `${field} must be a non-empty string`);
  return v;
}

/** A non-empty object from a body field. */
export function requireObject(v: unknown, message: string, slug = "validation"): Body {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new OpError(400, slug, message);
  return v as Body;
}

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
