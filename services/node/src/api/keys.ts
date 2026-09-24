/** `/api/keys`: the agent credentials a person has minted. */
import { mintRotatedApiKeySecret } from "@stuga/auth";
import { listApiKeys, revokeApiKey, rotateApiKeySecret, updateApiKey } from "@stuga/db";
import { KeyNarrowingError, agentKeyKind, createAgentKey, validateNarrowing } from "../agents/keys.js";
import { recordAudit } from "../audit/record.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

export async function listKeys({ ctx }: WorkspaceCall): Promise<Response> {
  // By owner alone: a key minted in another workspace is still the caller's to revoke.
  const keys = await listApiKeys(ctx.sql, ctx.alias);
  return json({
    keys: keys.map((k) => ({
      key_id: k.key_id,
      agent_id: k.agent_id,
      kind: agentKeyKind(k.agent_id),
      name: k.name,
      workspace_id: k.workspace_id,
      created_at: k.created_at,
      last_used_at: k.last_used_at,
      revoked_at: k.revoked_at,
      revoked_by: k.revoked_by,
      scope_folders: k.scope_folders,
      access: k.access,
      expires_at: k.expires_at,
      rotated_at: k.rotated_at,
    })),
  });
}

export async function mintKey({ ctx, req }: WorkspaceCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    scope_folders?: unknown;
    access?: unknown;
    expires_in_days?: unknown;
  };
  const name = (body.name ?? "").trim().slice(0, 100);
  if (!name) return error(400, "name required");
  try {
    const minted = await createAgentKey(ctx, name, {
      scopeFolders: body.scope_folders as string[] | null | undefined,
      access: body.access as "read" | "propose" | undefined,
      expiresInDays: body.expires_in_days as number | null | undefined,
    });
    recordAudit(ctx, {
      action: "key.mint",
      targetKind: "api_key",
      targetId: minted.keyId,
      targetLabel: name,
      detail: { agent_id: minted.agentId, name, scope_folders: minted.scopeFolders, access: minted.access, expires_at: minted.expiresAt },
    });
    // The token is returned exactly once; only its hash is stored.
    return json(
      {
        token: minted.token,
        key_id: minted.keyId,
        agent_id: minted.agentId,
        principal: `agent:${minted.agentId}`,
        name,
        scope_folders: minted.scopeFolders,
        access: minted.access,
        expires_at: minted.expiresAt,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof KeyNarrowingError) return error(400, e.message);
    throw e;
  }
}

export async function rotateKey({ ctx, match }: WorkspaceCall): Promise<Response> {
  // Same id and agent principal, so attribution is unchanged; the old token stops verifying.
  const rotated = mintRotatedApiKeySecret(match[1]!);
  const ok = await rotateApiKeySecret(ctx.sql, match[1]!, ctx.alias, rotated.secretHash);
  if (!ok) return error(404, "not found");
  recordAudit(ctx, { action: "key.rotate", targetKind: "api_key", targetId: match[1]! });
  return json({ token: rotated.token, key_id: rotated.keyId });
}

export async function updateKey({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    name?: unknown;
    scope_folders?: unknown;
    access?: unknown;
    expires_in_days?: unknown;
    clear_expiry?: unknown;
  };
  try {
    const patch: Parameters<typeof updateApiKey>[3] = {};
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
      if (!name) return error(400, "name cannot be empty");
      patch.name = name;
    }
    if (body.scope_folders !== undefined || body.access !== undefined || body.expires_in_days !== undefined) {
      const narrowed = await validateNarrowing(ctx, {
        scopeFolders: body.scope_folders as string[] | null | undefined,
        access: body.access as "read" | "propose" | undefined,
        expiresInDays: body.expires_in_days as number | null | undefined,
      });
      if (body.scope_folders !== undefined) patch.scopeFolders = narrowed.scopeFolders;
      if (body.access !== undefined) patch.access = narrowed.access;
      if (body.expires_in_days !== undefined) patch.expiresAt = narrowed.expiresAt;
    }
    if (body.clear_expiry === true) patch.expiresAt = null;
    const row = await updateApiKey(ctx.sql, match[1]!, ctx.alias, patch);
    if (!row) return error(404, "not found");
    recordAudit(ctx, {
      action: "key.update",
      targetKind: "api_key",
      targetId: row.key_id,
      targetLabel: row.name,
      detail: { ...patch },
    });
    return json({
      key_id: row.key_id,
      agent_id: row.agent_id,
      name: row.name,
      scope_folders: row.scope_folders,
      access: row.access,
      expires_at: row.expires_at,
    });
  } catch (e) {
    if (e instanceof KeyNarrowingError) return error(400, e.message);
    throw e;
  }
}

export async function revokeKey({ ctx, match }: WorkspaceCall): Promise<Response> {
  const ok = await revokeApiKey(ctx.sql, match[1]!, ctx.alias);
  if (ok) recordAudit(ctx, { action: "key.revoke", targetKind: "api_key", targetId: match[1]! });
  // 404, not 403: the key's existence is not disclosed.
  return ok ? json({ revoked: true }) : error(404, "not found");
}
