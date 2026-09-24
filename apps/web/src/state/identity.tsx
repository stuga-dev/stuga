/**
 * Principals as people read them: a display projection over the user directory,
 * resolved in batches and cached for the life of the tab. ACLs spell a person
 * `user:<alias>`; the audit ledger and usage records use the bare alias,
 * `agent:<id>`, or `panel:<alias>` for a person's co-author.
 */
import { useEffect } from "react";
import { Users } from "../api";
import { AI_COAUTHOR_LABEL, principalHuman } from "../lib/format";
import { createStore, useStore } from "../lib/store";

/** alias → display name */
const names = new Map<string, string>();
/** alias → `@username`, else email; absent when the directory row has neither. */
const handles = new Map<string, string>();

function handleOf(u: { username: string | null; email: string | null }): string | null {
  return u.username ? `@${u.username}` : u.email;
}
/** Bumped whenever names arrive, so consumers re-render. */
const resolved = createStore(0);
let queue: Promise<void> = Promise.resolve();
/** Aliases waiting for the next request. */
let batch = new Set<string>();
/** Queued or in flight, so a second caller does not ask again. */
const pending = new Set<string>();

/** The person a principal or ledger alias names; null for agents, groups and the workspace. */
function personAlias(principal: string): string | null {
  if (principal.startsWith("user:")) return principal.slice("user:".length);
  const human = principalHuman(principal);
  if (human !== null) return human;
  return principal.includes(":") ? null : principal;
}

/** A principal's full name from the cache. Emails stay whole, so two people sharing a local part stay distinct. */
export function principalName(principal: string): string {
  if (principal.startsWith("org:")) return "Everyone";
  if (principal.startsWith("group:")) return `${principal.slice("group:".length)} (group)`;
  if (principal.startsWith("user:")) {
    const alias = principal.slice("user:".length);
    return names.get(alias) ?? (alias.length > 12 ? `${alias.slice(0, 6)}…` : alias);
  }
  return principal;
}

/** A short label from the cache: an email is cut to its local part. */
export function principalLabel(principal: string): string {
  const name = principalName(principal);
  if (!principal.startsWith("user:")) return name;
  const at = name.indexOf("@");
  return at > 0 ? name.slice(0, at) : name;
}

/** A ledger alias: the co-author label, an agent's id, or a person's name. */
export function actorName(alias: string): string {
  if (principalHuman(alias) !== null) return AI_COAUTHOR_LABEL;
  if (alias.startsWith("agent:")) return alias.slice("agent:".length);
  const person = alias.startsWith("user:") ? alias.slice("user:".length) : alias;
  return names.get(person) ?? person;
}

/** What tells apart two people of one name; null for agents and co-authors, and when the name already is the handle. */
export function actorHandle(alias: string): string | null {
  const person = alias.startsWith("user:") ? alias.slice("user:".length) : alias;
  const handle = handles.get(person);
  return handle && handle !== names.get(person) ? handle : null;
}

/** A version author: a bare alias, or a `restore:<version>` marker. */
export function authorLabel(author: string): string {
  if (author.startsWith("restore:")) return `restored from ${author.slice("restore:".length)}`;
  return principalLabel(`user:${author}`);
}

/**
 * Identity colours for peer carets and avatars. `@tiptap/y-tiptap` accepts only
 * 6-digit hex (it appends an alpha suffix for selections), and white text sits on
 * every entry, so each clears 4.5:1 against white. The fold in `colorFor` is
 * uniform only while the length divides 360.
 */
export const PEER_PALETTE = [
  "#2563eb", // blue
  "#7c3aed", // violet
  "#c026d3", // fuchsia
  "#db2777", // pink
  "#dc2626", // red
  "#c2410c", // orange
  "#b45309", // amber
  "#15803d", // green
  "#0f766e", // teal
  "#0e7490", // cyan
] as const;

/** A deterministic identity colour for any string. */
export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return PEER_PALETTE[h % PEER_PALETTE.length]!;
}

export function initials(label: string): string {
  const clean = label.replace(/[^A-Za-z0-9 ]/g, " ").trim();
  if (!clean) return "?";
  const parts = clean.split(/\s+/);
  return (parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : clean.slice(0, 2)).toUpperCase();
}

async function flush(): Promise<void> {
  const aliases = [...batch];
  batch = new Set();
  if (aliases.length === 0) return;
  try {
    const { users } = await Users.resolve(aliases);
    for (const u of users) {
      names.set(u.alias, u.display_name || u.username || u.email || u.alias);
      const handle = handleOf(u);
      if (handle) handles.set(u.alias, handle);
    }
    // An alias the directory does not know names itself, so it is not asked about again.
    for (const a of aliases) if (!names.has(a)) names.set(a, a);
  } catch {
    // Left unresolved; the next caller asks again.
  } finally {
    for (const a of aliases) pending.delete(a);
  }
  resolved.update((n) => n + 1);
}

/** Seed the cache from directory rows already in hand, such as search results, so their avatars name them at once. */
export function rememberUsers(users: readonly { alias: string; username: string | null; display_name: string; email: string | null }[]): void {
  let changed = false;
  for (const u of users) {
    const name = u.display_name || u.username || u.email || u.alias;
    const handle = handleOf(u);
    if (names.get(u.alias) === name && (handles.get(u.alias) ?? null) === handle) continue;
    names.set(u.alias, name);
    if (handle) handles.set(u.alias, handle);
    else handles.delete(u.alias);
    changed = true;
  }
  if (changed) resolved.update((n) => n + 1);
}

/** Look up the people these principals or ledger aliases name, in the background. */
export function resolveNames(principals: readonly (string | null)[]): void {
  let added = false;
  for (const p of principals) {
    const alias = p === null ? null : personAlias(p);
    if (alias === null || names.has(alias) || pending.has(alias)) continue;
    pending.add(alias);
    batch.add(alias);
    added = true;
  }
  if (added) queue = queue.then(flush);
}

/** A counter that changes as names arrive; read the text through the name functions above. */
export function useNamesVersion(): number {
  return useStore(resolved);
}

/** Resolve these principals while mounted, re-rendering as names arrive. */
export function useUserNames(principals: string[]): number {
  const version = useNamesVersion();
  const key = principals.join(",");
  useEffect(() => {
    resolveNames(principals);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return version;
}

/** A circular avatar with initials on the principal's identity colour. */
export function Avatar({ principal, size = 22 }: { principal: string; size?: number }) {
  const label = principalLabel(principal);
  const seed = principal.startsWith("user:") ? principal.slice("user:".length) : principal;
  return (
    <span
      className="avatar"
      title={label}
      style={{
        width: size,
        height: size,
        background: colorFor(seed),
        fontSize: size * 0.42,
        lineHeight: `${size}px`,
      }}
    >
      {initials(label)}
    </span>
  );
}
