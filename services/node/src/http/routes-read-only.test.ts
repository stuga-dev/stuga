/**
 * What a read-only key may call, pinned for every route in the table: reads get
 * through, and every change is refused before its handler runs. A new route
 * fails here until its line is added, which is where its verdict is decided.
 */
import { describe, expect, it } from "vitest";
import { READ_ONLY_MESSAGE } from "../authz/authz.js";
import type { Ctx } from "../auth/context.js";
import { gateRefusal, type AppRoute } from "./dispatch.js";
import type { Method } from "./router.js";
import { APP_ROUTES } from "./routes.js";

/** An admin's key, so a gate that refuses it refuses every agent key. */
const readOnlyKey = {
  sql: {},
  alias: "agent-1",
  displayName: "Scout",
  isAgent: true,
  onBehalfOf: "ada",
  surface: "api-key",
  principals: ["agent:agent-1", "user:ada", "org:ws1"],
  workspaceId: "ws1",
  role: "admin",
  scope: { folders: null, readOnly: true, keyId: "k1" },
  env: {},
} as unknown as Ctx;

/** A regex path as a person would write it: `:id` for a segment, `:n` for a number, `**` for the rest. */
function pathLabel(path: string | RegExp): string {
  if (typeof path === "string") return path;
  const source = path.source.replaceAll("\\/", "/");
  const label = source
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replaceAll("([^/]+)", ":id")
    .replaceAll("[^/]+", ":id")
    .replaceAll("(\\d+)", ":n")
    .replaceAll("([0-9a-f]{64})", ":hash")
    .replaceAll("(/.*)?", "/**");
  return source.endsWith("$") ? label : `${label}**`;
}

/** A catch-all answers a read like a GET and a change like a POST. */
function methodsOf(route: AppRoute): readonly Method[] {
  if (route.method === "*") return ["GET", "POST"];
  return typeof route.method === "string" ? [route.method] : route.method;
}

async function verdict(route: AppRoute, method: Method): Promise<string> {
  switch (route.auth) {
    case "none":
      return "no credential";
    case "account":
      return route.humanOnly ? "agents refused" : "allowed";
    case "workspace": {
      if (route.transport === "mcp") return "each tool decides";
      // An unmetered route runs no gates at all.
      if (route.unmetered) return method === "GET" ? "allowed" : "UNGATED";
      const refusal = await gateRefusal(route, readOnlyKey, method);
      if (!refusal) return "allowed";
      const { error } = (await refusal.json()) as { error: string };
      return error === READ_ONLY_MESSAGE ? "refused" : "agents refused";
    }
  }
}

async function line(route: AppRoute): Promise<string> {
  const methods = methodsOf(route);
  const verdicts = await Promise.all(methods.map((m) => verdict(route, m)));
  const label = `${route.method === "*" ? "*" : methods.join("|")} ${pathLabel(route.path)}`;
  if (verdicts.every((v) => v === verdicts[0])) return `${label}: ${verdicts[0]}`;
  return `${label}: ${methods.map((m, i) => `${m} ${verdicts[i]}`).join(", ")}`;
}

/**
 * `allowed`: the key passes every gate the table declares, and the handler applies its own checks. `refused`: the
 * read-only refusal. `agents refused`: a gate every agent key fails, whatever its access.
 */
const PINNED = [
  "* /ready: no credential",
  "GET /api/models: no credential",
  "GET /api/agent-install/:id: no credential",
  "* /api/agent-install/:id: no credential",
  "DELETE /api/media/ticket: no credential",
  "GET /api/media/ticket: allowed",
  "* /api/media/ticket: no credential",
  "GET /api/docs/:id/media/:hash: no credential",
  "* /.well-known/oauth-authorization-server: no credential",
  "* /.well-known/oauth-protected-resource: no credential",
  "POST /oauth/register: no credential",
  "GET /oauth/authorize: no credential",
  "POST /oauth/consent: no credential",
  "POST /oauth/token: no credential",
  "* /mcp: each tool decides",
  "* /ws/:id: no credential",
  "PUT /api/databases/:id/imports/:id/upload: no credential",
  "GET /api/workspaces: agents refused",
  "POST /api/workspaces: agents refused",
  "POST /api/invites/redeem: agents refused",
  "POST /api/share-links/redeem: agents refused",
  "GET /api/me/nodes: agents refused",
  "POST /api/me/nodes: agents refused",
  "DELETE /api/me/nodes/:id: agents refused",
  "* /api/me/nodes/**: agents refused",
  "GET /api/whoami: allowed",
  "PATCH /api/whoami: refused",
  "GET /api/ws/ticket: allowed",
  "GET /api/agent-setup: allowed",
  "POST /api/agent-bundle: refused",
  "GET /api/runs: agents refused",
  "GET /api/agents/stats: agents refused",
  "GET /api/webhooks: agents refused",
  "POST /api/webhooks: refused",
  "PATCH /api/webhooks/:id: refused",
  "DELETE /api/webhooks/:id: refused",
  "* /api/webhooks/**: GET agents refused, POST refused",
  "GET /api/events: allowed",
  "GET /api/instructions: allowed",
  "GET /api/docs/:id/provenance: allowed",
  "GET /api/audit/export: allowed",
  "GET /api/databases/:id/schema: allowed",
  "POST /api/databases/:id/tables: refused",
  "PATCH /api/databases/:id/tables/:id: refused",
  "DELETE /api/databases/:id/tables/:id: refused",
  "POST /api/databases/:id/tables/:id/columns: refused",
  "PATCH /api/databases/:id/tables/:id/columns/:id: refused",
  "DELETE /api/databases/:id/tables/:id/columns/:id: refused",
  "POST /api/databases/:id/tables/:id/views: refused",
  "PATCH /api/databases/:id/tables/:id/views/:id: refused",
  "DELETE /api/databases/:id/tables/:id/views/:id: refused",
  "POST /api/databases/:id/tables/:id/rows/:id/page: allowed",
  "POST /api/databases/:id/tables/:id/rows/list: allowed",
  "POST /api/databases/:id/tables/:id/rows: refused",
  "PATCH /api/databases/:id/tables/:id/rows: refused",
  "POST /api/databases/:id/tables/:id/rows/delete: refused",
  "POST /api/databases/:id/query: allowed",
  "POST /api/databases/:id/ai: refused",
  "GET /api/databases/:id/runs: allowed",
  "GET /api/databases/:id/runs/:id: allowed",
  "POST /api/databases/:id/runs/:id/decision: refused",
  "POST /api/databases/:id/runs/:id/revert: refused",
  "POST /api/databases/:id/runs/:id/ack: refused",
  "POST /api/databases/:id/imports: refused",
  "POST /api/databases/:id/imports/:id/commit: refused",
  "GET /api/databases/:id/ops: allowed",
  "POST /api/databases/:id/ops/:id/revert: refused",
  "* /api/databases/:id/**: GET allowed, POST refused",
  "GET /api/node/admins: agents refused",
  "POST /api/node/admins: refused",
  "* /api/node/admins: GET agents refused, POST refused",
  "DELETE /api/node/admins/:id: refused",
  "POST /api/node/password-resets: refused",
  "GET /api/node/users: agents refused",
  "GET /api/node/settings: agents refused",
  "PUT /api/node/settings: refused",
  "DELETE /api/node/settings: refused",
  "* /api/node/settings: GET agents refused, POST refused",
  "POST /api/node/settings/notify-test: refused",
  "GET /api/node/ai-settings: agents refused",
  "PUT /api/node/ai-settings: refused",
  "DELETE /api/node/ai-settings: refused",
  "* /api/node/ai-settings: GET agents refused, POST refused",
  "POST /api/node/ai-settings/test: refused",
  "POST /api/node/ai-settings/models: refused",
  "GET /api/node/audit: agents refused",
  "GET /api/node/version: agents refused",
  "POST /api/node/version/check: refused",
  "POST /api/node/version/install: refused",
  "GET /api/node/backups: agents refused",
  "POST /api/node/backups: refused",
  "* /api/node/backups: GET agents refused, POST refused",
  "* /api/node/**: GET agents refused, POST refused",
  "PATCH /api/workspaces/:id: refused",
  "DELETE /api/workspaces/:id: refused",
  "GET /api/workspaces/:id/members: agents refused",
  "POST /api/workspaces/:id/members: refused",
  "GET /api/workspaces/:id/member-candidates: agents refused",
  "PATCH /api/workspaces/:id/members/:id: refused",
  "DELETE /api/workspaces/:id/members/:id: refused",
  "POST /api/workspaces/:id/invites: refused",
  "GET /api/workspaces/:id/invites: agents refused",
  "DELETE /api/workspaces/:id/invites/:id: refused",
  "* /api/workspaces/**: GET agents refused, POST refused",
  "GET /api/usage: agents refused",
  "GET /api/audit: allowed",
  "GET /api/audit/facets: allowed",
  "GET /api/keys: agents refused",
  "POST /api/keys: refused",
  "POST /api/keys/:id/rotate: refused",
  "PATCH /api/keys/:id: refused",
  "DELETE /api/keys/:id: refused",
  "* /api/keys/**: GET agents refused, POST refused",
  "GET /api/users: allowed",
  "GET /api/users/search: allowed",
  "GET /api/docs: allowed",
  "POST /api/docs: refused",
  "GET /api/docs/:id: allowed",
  "PATCH /api/docs/:id: refused",
  "DELETE /api/docs/:id: refused",
  "POST /api/docs/:id/request-access: refused",
  "GET /api/docs/:id/runs: allowed",
  "GET /api/docs/:id/runs/:id: allowed",
  "POST /api/docs/:id/runs/:id/decision: refused",
  "POST /api/docs/:id/runs/:id/revert: refused",
  "POST /api/docs/:id/runs/:id/ack: refused",
  "POST /api/docs/:id/propose: refused",
  "GET /api/docs/:id/markdown: allowed",
  "GET /api/docs/:id/instructions: allowed",
  "GET /api/docs/:id/versions: allowed",
  "GET /api/docs/:id/versions/:n: allowed",
  "DELETE /api/docs/:id/versions/:n: refused",
  "POST /api/docs/:id/restore: refused",
  "POST /api/docs/:id/recover: refused",
  "POST /api/docs/:id/media: refused",
  "GET /api/docs/:id/comments: allowed",
  "POST /api/docs/:id/comments: refused",
  "PATCH /api/docs/:id/comments/:n: refused",
  "DELETE /api/docs/:id/comments/:n: refused",
  "GET /api/(docs|folders)/:id/acl: allowed",
  "PUT /api/(docs|folders)/:id/acl: refused",
  "PATCH /api/docs/:id/state: refused",
  "POST /api/docs/:id/share-links: refused",
  "GET /api/docs/:id/share-links: allowed",
  "DELETE /api/docs/:id/share-links/:id: refused",
  "GET /api/folders: allowed",
  "POST /api/folders: refused",
  // Reading what a new folder would inherit is a read, like the per-folder one below.
  "GET /api/folders/instructions: allowed",
  "GET /api/folders/:id/ancestors: allowed",
  "GET /api/folders/:id/contents: allowed",
  "GET /api/folders/:id/instructions: allowed",
  "PATCH /api/folders/:id: refused",
  "DELETE /api/folders/:id: refused",
  "GET /api/collections: allowed",
  "POST /api/collections: refused",
  "POST|DELETE /api/collections/:id/items: refused",
  "GET /api/collections/:id: allowed",
  "PATCH /api/collections/:id: refused",
  "DELETE /api/collections/:id: refused",
  "GET /api/ask/threads: allowed",
  "POST /api/ask/threads: allowed",
  "GET /api/ask/threads/:id: allowed",
  "PATCH /api/ask/threads/:id: allowed",
  "DELETE /api/ask/threads/:id: allowed",
  "PUT /api/groups/:id: refused",
  "POST /api/search: allowed",
  "POST /api/ask: allowed",
  "POST /api/retrieve: allowed",
  "GET /api/favorites: allowed",
  "PUT /api/favorites: refused",
  "DELETE /api/favorites/:id: refused",
  "GET /api/notifications/unread: allowed",
  "GET /api/notifications: allowed",
  "POST /api/notifications/read: refused",
  "* /api/**: GET allowed, POST refused",
];

describe("a read-only key against the route table", () => {
  it("has a pinned verdict for every route, in table order", async () => {
    const actual = await Promise.all(APP_ROUTES.map(line));
    expect(actual).toEqual(PINNED);
  });
});
