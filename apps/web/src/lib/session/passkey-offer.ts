/**
 * "Sign in faster next time" (ui/PasskeyOffer.tsx): due once a password signs in at the remote
 * address, for someone with no passkey there who never said Not now. Held for this tab until it is
 * answered, so the page the sign-in goes on to can ask.
 */
import { readStored, removeStored, writeStored } from "../storage";
import type { Session } from "./tokens";
import { passkeysOffered } from "./passkey";

const KEY = "stuga_passkey_offer";
const listeners = new Set<() => void>();

/** Note the offer a sign-in came with, when this browser can take it up. */
export function notePasskeyOffer(session: Session): void {
  if (!session.passkeyOffer || !passkeysOffered()) return;
  writeStored("session", KEY, "1");
  for (const listener of listeners) listener();
}

export function passkeyOfferDue(): boolean {
  return readStored("session", KEY) === "1";
}

/** Answered, either way: it is not asked again in this tab. */
export function clearPasskeyOffer(): void {
  removeStored("session", KEY);
}

/** Called when an offer is noted; returns its removal. */
export function onPasskeyOffer(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
