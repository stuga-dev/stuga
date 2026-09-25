/**
 * Minting agent credentials. A person mints keys (/api/keys); an OAuth consent
 * creates a grant (mcp/oauth.ts). Both resolve to an independent `agent:<id>`
 * principal, and the agent id records which kind it is.
 */
import { mintApiKey } from "@stuga/auth";
import { type ApiKeyAccess, getFolder, insertApiKey } from "@stuga/db";
import type { Ctx } from "../auth/context.js";

export type AgentKeyKind = "key" | "connector";

const KEY_AGENT_PREFIX = "agent-";
const CONNECTOR_AGENT_PREFIX = "agent-conn-";

/** Which way a key was minted, read from its agent id. */
export function agentKeyKind(agentId: string): AgentKeyKind {
  return agentId.startsWith(CONNECTOR_AGENT_PREFIX) ? "connector" : "key";
}

/** A fresh agent id. The random part is base64 without `-`, so a key's id can never read as a connector's. */
export function newAgentId(kind: AgentKeyKind): string {
  const buf = new Uint8Array(9);
  crypto.getRandomValues(buf);
  const random = btoa(String.fromCharCode(...buf)).replace(/[+/=]/g, "").slice(0, 12);
  return `${kind === "connector" ? CONNECTOR_AGENT_PREFIX : KEY_AGENT_PREFIX}${random}`;
}

export interface AgentKey {
  /** The full token, disclosed once; only its hash is stored. */
  token: string;
  keyId: string;
  /** The principal the key resolves to is `agent:<agentId>`. */
  agentId: string;
  name: string;
  scopeFolders: string[] | null;
  access: ApiKeyAccess;
  expiresAt: string | null;
}

/** How a key may be narrowed at mint time; the defaults are its owner's own reach. */
export interface KeyNarrowing {
  /** Folder ids the key is confined to, each with its subtree. */
  scopeFolders?: string[] | null;
  access?: ApiKeyAccess;
  /** Days from now until the key stops verifying; omitted means never. */
  expiresInDays?: number | null;
}

const MAX_KEY_LIFETIME_DAYS = 3650;
const MAX_SCOPE_FOLDERS = 50;

export class KeyNarrowingError extends Error {}

/**
 * Validate a narrowing against the caller's reach. Every folder must be one the
 * caller can read in this workspace, so a scope cannot probe which folder ids exist.
 */
export async function validateNarrowing(ctx: Ctx, input: KeyNarrowing): Promise<{
  scopeFolders: string[] | null;
  access: ApiKeyAccess;
  expiresAt: string | null;
}> {
  let scopeFolders: string[] | null = null;
  if (input.scopeFolders !== undefined && input.scopeFolders !== null) {
    if (!Array.isArray(input.scopeFolders) || input.scopeFolders.some((f) => typeof f !== "string" || !f)) {
      throw new KeyNarrowingError("scope_folders must be a list of folder ids");
    }
    const unique = [...new Set(input.scopeFolders)];
    if (unique.length === 0) throw new KeyNarrowingError("scope_folders cannot be empty — omit it for the whole workspace");
    if (unique.length > MAX_SCOPE_FOLDERS) throw new KeyNarrowingError(`scope_folders lists more than ${MAX_SCOPE_FOLDERS} folders`);
    for (const id of unique) {
      const folder = await getFolder(ctx.sql, id);
      const visible =
        folder !== null && folder.workspace_id === ctx.workspaceId && folder.acl_principals.some((p) => ctx.principals.includes(p));
      if (!visible) throw new KeyNarrowingError(`folder ${id} not found`);
    }
    scopeFolders = unique;
  }
  const access: ApiKeyAccess = input.access ?? "propose";
  if (access !== "read" && access !== "propose") throw new KeyNarrowingError("access must be read | propose");
  let expiresAt: string | null = null;
  if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
    const days = Number(input.expiresInDays);
    if (!Number.isFinite(days) || days <= 0 || days > MAX_KEY_LIFETIME_DAYS) {
      throw new KeyNarrowingError(`expires_in_days must be between 1 and ${MAX_KEY_LIFETIME_DAYS}`);
    }
    expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  }
  return { scopeFolders, access, expiresAt };
}

/** Mint a key for the caller in the workspace they act in. The caller has already decided who may mint. */
export async function createAgentKey(ctx: Ctx, name: string, narrowing: KeyNarrowing = {}): Promise<AgentKey> {
  const { scopeFolders, access, expiresAt } = await validateNarrowing(ctx, narrowing);
  const minted = mintApiKey();
  const agentId = newAgentId("key");
  await insertApiKey(ctx.sql, {
    keyId: minted.keyId,
    secretHash: minted.secretHash,
    agentId,
    owner: ctx.alias,
    workspaceId: ctx.workspaceId,
    name,
    scopeFolders,
    access,
    expiresAt,
  });
  return { token: minted.token, keyId: minted.keyId, agentId, name, scopeFolders, access, expiresAt };
}
