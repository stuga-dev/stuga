/**
 * "Confirm it's you": a change that hands out a lasting way in, such as an API key, an administrator
 * or a password link, takes a sign-in confirmed in the last five minutes. The node refuses an older
 * one with 401 `reauth_required`, marked by REAUTH_HEADER so it is never taken for an ended session,
 * and names the `methods` this person can confirm with. The app asks (ui/ConfirmIdentity.tsx), and
 * the change is sent once more.
 */
import { AuthError } from "./errors";

/** On a `reauth_required` answer. */
export const REAUTH_HEADER = "x-stuga-reauth";

export type ConfirmMethod = "password" | "provider";

/** Asks the person to confirm with one of `methods`; true once they have. */
type Confirmer = (methods: ConfirmMethod[]) => Promise<boolean>;

let confirmer: Confirmer | null = null;

/** The one place that asks, mounted once; returns its removal. */
export function setConfirmer(fn: Confirmer): () => void {
  confirmer = fn;
  return () => {
    if (confirmer === fn) confirmer = null;
  };
}

function asMethods(raw: unknown): ConfirmMethod[] {
  return Array.isArray(raw) ? raw.filter((m): m is ConfirmMethod => m === "password" || m === "provider") : [];
}

/** The methods a refusal asks to confirm with, or null when it asks for nothing of the kind. */
export function reauthMethods(err: unknown): ConfirmMethod[] | null {
  if (err instanceof AuthError) return err.message === "reauth_required" ? asMethods(err.methods) : null;
  const coded = err as { code?: unknown; methods?: unknown } | null;
  return coded?.code === "reauth_required" ? asMethods(coded.methods) : null;
}

/** Ask the person to confirm; false when nothing can ask, or they cancel. */
export async function confirmIdentity(methods: ConfirmMethod[]): Promise<boolean> {
  return confirmer ? confirmer(methods) : false;
}

/** Run `send`; when it is refused for want of a recent confirmation, confirm and send it once more. */
export async function withConfirmation<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (err) {
    const methods = reauthMethods(err);
    if (!methods || !(await confirmIdentity(methods))) throw err;
    return send();
  }
}
