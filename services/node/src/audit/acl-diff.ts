/**
 * Permission changes as the audit ledger records them: the principals that
 * entered and left a resource's direct grants. The diff runs over `own_grants`,
 * never the flattened ACL, which folds in the owner and the parent folder.
 */
import type { OwnGrants } from "@stuga/auth";

/** Each tier's true size, for a row whose lists were cut. */
type TierSizes = { p: number; w: number; c: number };

/** One `acl.set` row's detail; `truncated` carries the true sizes when a list was cut. */
export type AclChangeDetail = {
  added: OwnGrants;
  removed: OwnGrants;
  inherits: { before: boolean; after: boolean };
  truncated?: { added: TierSizes; removed: TierSizes };
};

/** One `group.sync` row's detail. A group grant names the group, so its membership change is the permission change. */
export type GroupSyncDetail = {
  added: string[];
  removed: string[];
  members: number;
  truncated?: { added: number; removed: number };
};

/** The most principals one list names in a ledger row; past it the list is cut and `truncated` says by how much. */
const MAX_NAMED_PRINCIPALS = 200;

/** Members of `from` absent from `to`, deduplicated, in `from`'s order. */
function missing(from: readonly string[], to: readonly string[]): string[] {
  const present = new Set(to);
  return [...new Set(from)].filter((principal) => !present.has(principal));
}

/** Per tier: what `from` holds that `to` does not. */
function tierDiff(from: OwnGrants, to: OwnGrants): OwnGrants {
  return {
    p: missing(from.p, to.p),
    w: missing(from.w, to.w),
    c: missing(from.c, to.c),
  };
}

function isEmpty(tiers: OwnGrants): boolean {
  return tiers.p.length === 0 && tiers.w.length === 0 && tiers.c.length === 0;
}

function sizes(tiers: OwnGrants): TierSizes {
  return { p: tiers.p.length, w: tiers.w.length, c: tiers.c.length };
}

function capped(tiers: OwnGrants): OwnGrants {
  return {
    p: tiers.p.slice(0, MAX_NAMED_PRINCIPALS),
    w: tiers.w.slice(0, MAX_NAMED_PRINCIPALS),
    c: tiers.c.slice(0, MAX_NAMED_PRINCIPALS),
  };
}

function overCap(tiers: OwnGrants): boolean {
  return (
    tiers.p.length > MAX_NAMED_PRINCIPALS ||
    tiers.w.length > MAX_NAMED_PRINCIPALS ||
    tiers.c.length > MAX_NAMED_PRINCIPALS
  );
}

/** An ACL write's ledger detail, or null when it moved no principal and left inheritance alone. */
export function describeAclChange(
  before: OwnGrants,
  after: OwnGrants,
  inheritsBefore: boolean,
  inheritsAfter: boolean,
): AclChangeDetail | null {
  const added = tierDiff(after, before);
  const removed = tierDiff(before, after);
  if (isEmpty(added) && isEmpty(removed) && inheritsBefore === inheritsAfter) return null;
  const detail: AclChangeDetail = {
    added: capped(added),
    removed: capped(removed),
    inherits: { before: inheritsBefore, after: inheritsAfter },
  };
  if (overCap(added) || overCap(removed)) {
    detail.truncated = { added: sizes(added), removed: sizes(removed) };
  }
  return detail;
}

/** A directory sync's ledger detail, or null when the membership is unchanged. `before` is null for a new group. */
export function describeGroupSync(before: string[] | null, after: string[]): GroupSyncDetail | null {
  const added = missing(after, before ?? []);
  const removed = missing(before ?? [], after);
  if (added.length === 0 && removed.length === 0) return null;
  const detail: GroupSyncDetail = {
    added: added.slice(0, MAX_NAMED_PRINCIPALS),
    removed: removed.slice(0, MAX_NAMED_PRINCIPALS),
    members: after.length,
  };
  if (added.length > MAX_NAMED_PRINCIPALS || removed.length > MAX_NAMED_PRINCIPALS) {
    detail.truncated = { added: added.length, removed: removed.length };
  }
  return detail;
}
