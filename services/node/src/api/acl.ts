/** Sharing: a document's or folder's direct grants, and the effective ACL they materialize into. */
import { type OwnGrants, materializeAcl, orgPrincipal } from "@stuga/auth";
import {
  type DocRow,
  type OwnGrantsJson,
  folderEffectiveAcl,
  getUserAliasByHandle,
  isWorkspaceMember,
  listGroupMembers,
  setDocAcl,
  setFolderAcl,
} from "@stuga/db";
import { describeAclChange } from "../audit/acl-diff.js";
import { recordAudit } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { manages } from "../authz/authz.js";
import {
  authorizedDoc,
  authorizedFolder,
  itemKind,
  reflattenFolderSubtree,
  revokeDocAccess,
} from "../documents/access.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

/**
 * One notification per person the grants reach. A `group:` grant is expanded to
 * its live members for addressing only; the ACL keeps the group principal.
 */
async function enqueueGranteeNotifications(ctx: Ctx, docId: string, title: string, grants: string[]): Promise<void> {
  const groupIds = grants.filter((g) => g.startsWith("group:"));
  const members = await listGroupMembers(ctx.sql, groupIds, ctx.workspaceId);
  const recipients = [...new Set([...grants, ...members])]
    .filter((p) => p.startsWith("user:"))
    .map((p) => p.slice("user:".length))
    .filter((alias) => alias !== ctx.alias); // don't notify the sharer
  for (const recipient of recipients) {
    await ctx.env.jobs.send({
      kind: "notify",
      recipient,
      workspaceId: ctx.workspaceId,
      eventType: "DIRECT_DOC_PERMISSIONS",
      docId,
      // The name: an alias is an opaque directory key.
      title: `${ctx.displayName || ctx.alias} shared "${title}" with you`,
      body: "You now have access to this document.",
      actor: ctx.alias,
    });
  }
}

/**
 * Resolve typed `user:` grants to the `user:<alias>` principals ACLs match on,
 * so a share never stores a grant that can never match. An id naming a member's
 * alias is kept; anything else is a username, email or name, resolved within
 * this workspace. `org:` collapses to this workspace's org principal.
 */
async function resolveUserGrants(
  ctx: Ctx,
  grants: string[],
): Promise<{ resolved: string[]; unresolved: string[] }> {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const g of grants) {
    if (g.startsWith("org:")) {
      resolved.push(orgPrincipal(ctx.workspaceId));
      continue;
    }
    if (g.startsWith("group:")) {
      resolved.push(g);
      continue;
    }
    if (!g.startsWith("user:")) {
      resolved.push(g);
      continue;
    }
    const id = g.slice("user:".length).trim();
    if (!id) continue;
    if (await isWorkspaceMember(ctx.sql, ctx.workspaceId, id)) {
      resolved.push(`user:${id}`);
      continue;
    }
    const alias = await getUserAliasByHandle(ctx.sql, id, ctx.workspaceId);
    if (alias) resolved.push(`user:${alias}`);
    else unresolved.push(id);
  }
  return { resolved, unresolved };
}

const MAX_ACL_GRANTS = 1_000;

const MAX_PRINCIPAL_LENGTH = 320;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function isGrantList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ACL_GRANTS &&
    value.every(
      (grant) =>
        typeof grant === "string" &&
        grant.length > 0 &&
        grant.length <= MAX_PRINCIPAL_LENGTH &&
        grant === grant.trim() &&
        !hasControlCharacter(grant),
    )
  );
}

export async function getAcl({ ctx, match }: WorkspaceCall): Promise<Response> {
  const kind = match[1]!; // "docs" | "folders"
  const id = match[2]!;
  const resource = kind === "folders" ? await authorizedFolder(ctx, id) : await authorizedDoc(ctx, id);
  if (!resource) return error(404, "not found");
  // The folder inherited access comes from; its title only for a caller who may read it.
  const parentId = resource.parent_id;
  const parentFolder = parentId ? await authorizedFolder(ctx, parentId) : null;
  // own_grants are the editable direct grants; the effective arrays add inherited ones.
  return json({
    parent: parentId ? { folder_id: parentId, title: parentFolder?.title ?? null } : null,
    // Always has access, whatever the grants and inheritance say.
    owner: resource.owner,
    acl_principals: resource.acl_principals,
    acl_writers: resource.acl_writers,
    acl_commenters: "acl_commenters" in resource ? resource.acl_commenters : [],
    inherits: resource.inherits_perms,
    own_grants: resource.own_grants,
  });
}

export async function setAcl({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const kind = match[1]!; // "docs" | "folders"
  const id = match[2]!;
  const resource = kind === "folders" ? await authorizedFolder(ctx, id) : await authorizedDoc(ctx, id);
  if (!resource) return error(404, "not found");
  if (!manages(ctx, resource)) return error(403, "only the owner or a workspace admin can change sharing");
  const body = (await req.json().catch(() => ({}))) as {
    grants?: unknown;
    /** Subset of `grants` allowed to edit. Omitted → everyone can edit. */
    writer_grants?: unknown;
    /** Subset of `grants` allowed to comment (but not edit). Docs only. */
    commenter_grants?: unknown;
    inherits?: unknown;
  };
  if (
    (body.grants !== undefined && !isGrantList(body.grants)) ||
    (body.writer_grants !== undefined && !isGrantList(body.writer_grants)) ||
    (body.commenter_grants !== undefined && !isGrantList(body.commenter_grants))
  ) {
    return error(
      400,
      `grant lists must contain at most ${MAX_ACL_GRANTS} valid principals`,
    );
  }
  if (body.inherits !== undefined && typeof body.inherits !== "boolean") {
    return error(400, "inherits must be a boolean");
  }
  const rawGrants = body.grants ?? [];
  // Writer grants default to all grants.
  const rawWriterGrants = body.writer_grants ?? rawGrants;
  const rawCommenterGrants = body.commenter_grants ?? [];
  if (kind === "folders" && rawCommenterGrants.length > 0) {
    return error(400, "folders do not support commenter grants");
  }
  const { resolved: resolvedGrants, unresolved } = await resolveUserGrants(ctx, rawGrants);
  const { resolved: resolvedWriterGrants, unresolved: unresolvedWriters } = await resolveUserGrants(
    ctx,
    rawWriterGrants,
  );
  const { resolved: resolvedCommenterGrants, unresolved: unresolvedCommenters } = await resolveUserGrants(
    ctx,
    rawCommenterGrants,
  );
  const allUnresolved = [...new Set([...unresolved, ...unresolvedWriters, ...unresolvedCommenters])];
  if (allUnresolved.length > 0) {
    return error(
      400,
      `No member of this workspace matches: ${allUnresolved.join(", ")}. They must join the workspace before you can share with them.`,
    );
  }
  const grants = [...new Set(resolvedGrants)];
  const writerGrants = [...new Set(resolvedWriterGrants)];
  const grantSet = new Set(grants);
  if ([...writerGrants, ...resolvedCommenterGrants].some((grant) => !grantSet.has(grant))) {
    return error(400, "writer and commenter grants must also be reader grants");
  }
  const writerSet = new Set(writerGrants);
  const commenterGrants = [...new Set(resolvedCommenterGrants)].filter(
    (grant) => !writerSet.has(grant),
  );
  const inherits = body.inherits ?? false;
  // The direct grants are stored as given; the effective arrays add the parent folder's when inheriting.
  const own: OwnGrantsJson = { p: grants, w: writerGrants, c: commenterGrants };
  const parentId = resource.parent_id;
  const parentEff =
    inherits && parentId ? await folderEffectiveAcl(ctx.sql, parentId, ctx.workspaceId) : null;
  const eff = materializeAcl(resource.owner, own as OwnGrants, parentEff, inherits);
  if (kind === "folders") {
    await setFolderAcl(ctx.sql, id, eff.principals, eff.writers, inherits, own);
    // Re-materialize every inheriting descendant.
    await reflattenFolderSubtree(ctx, id);
    await enqueueGranteeNotifications(ctx, id, resource.title, grants);
  } else {
    await setDocAcl(ctx.sql, id, eff.principals, eff.writers, inherits, eff.commenters, own);
    // Searches filter on acl_principals live, so nothing is reindexed. Live
    // sockets of principals that lost access are dropped.
    await revokeDocAccess(ctx.env, id, eff.principals, (resource as DocRow).doc_type, eff.writers);
    await enqueueGranteeNotifications(ctx, id, resource.title, grants);
  }
  // The principals that entered and left the direct grants; a save that changes nobody's access writes nothing.
  const change = describeAclChange(
    resource.own_grants,
    own,
    resource.inherits_perms,
    inherits,
  );
  if (change) {
    recordAudit(ctx, {
      action: "acl.set",
      targetKind: kind === "folders" ? "folder" : itemKind(resource as DocRow),
      targetId: id,
      targetLabel: resource.title,
      detail: change,
    });
  }
  return json({ acl_principals: eff.principals, acl_writers: eff.writers, acl_commenters: eff.commenters });
}
