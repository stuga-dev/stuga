/**
 * The Ctx a unit test runs under, built by hand in place of the auth path: a person, an agent key acting
 * for one, or a read-only key. Each takes overrides, and `env` holds only what the code under test reads.
 * For tests only.
 */
import { vi } from "vitest";
import type { Ctx, Surface } from "../auth/context.js";
import type { NodeEnv } from "../env.js";

const PUBLIC_ORIGIN = "https://stuga.test";

/** Any Ctx field, and whichever parts of the env a test needs. */
export interface CtxOverrides {
  sql?: unknown;
  surface?: Surface;
  alias?: string;
  displayName?: string;
  requestId?: string;
  isAgent?: boolean;
  onBehalfOf?: string;
  scope?: { folders: string[] | null; readOnly: boolean; credentialId: string };
  client?: string;
  model?: string;
  principals?: string[];
  workspaceId?: string;
  role?: string;
  env?: Partial<Record<keyof NodeEnv, unknown>>;
}

/**
 * A member of ws1: `user:<alias>` and the workspace's org floor unless `principals` says otherwise, on a node
 * at PUBLIC_ORIGIN. `env` is added to that origin, not put in its place.
 */
export function personCtx(over: CtxOverrides = {}): Ctx {
  const { alias = "human-1", workspaceId = "ws1", env, ...rest } = over;
  return {
    sql: {},
    alias,
    displayName: "Ada",
    isAgent: false,
    principals: [`user:${alias}`, `org:${workspaceId}`],
    workspaceId,
    role: "member",
    ...rest,
    env: { publicOrigin: PUBLIC_ORIGIN, ...env },
  } as unknown as Ctx;
}

/** An agent key acting for `onBehalfOf` (human-1): its own principal, its person's, and the org floor. */
export function agentCtx(over: CtxOverrides = {}): Ctx {
  const { alias = "agent-1", onBehalfOf = "human-1", workspaceId = "ws1" } = over;
  return personCtx({
    alias,
    displayName: "Connector",
    isAgent: true,
    onBehalfOf,
    principals: [`agent:${alias}`, `user:${onBehalfOf}`, `org:${workspaceId}`],
    ...over,
  });
}

/** An agent key its person narrowed to reading, over their whole reach. */
export function readOnlyKeyCtx(over: CtxOverrides = {}): Ctx {
  return agentCtx({ scope: { folders: null, readOnly: true, credentialId: "k1" }, ...over });
}

/** A settings store that always answers `value`. */
export const fixed = <T>(value: T) => ({ current: () => value });

/** The node settings most routes read, with `over` on top. */
export const nodeSettings = (over: Record<string, unknown> = {}) =>
  fixed({ databaseOpsKeep: 500, maxBodyBytes: 1024 * 1024, nodeLabel: "Studio", ...over });

/** An actor namespace whose every actor answers with `fetch`. */
export const actorsAnswering = (fetch: unknown) => ({ get: () => ({ fetch }) });

/** A job queue that records what it is sent; `audits()` is the ledger rows among them. */
export function recordingJobs() {
  const send = vi.fn(async (_message: Record<string, unknown>) => {});
  const sent = () => send.mock.calls.map(([message]) => message);
  return { send, sent, audits: () => sent().filter((m) => m.kind === "audit") };
}
