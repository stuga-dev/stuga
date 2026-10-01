/**
 * Passkey challenges (docs/remote-access.md), stateless until used: each is an HMAC ticket the node
 * signs with a key made at start and held only in memory, so a restart voids every challenge handed
 * out before it. A ticket names its purpose (`sign-in`, `reauth`, `add`; one never stands in for
 * another), a single-use nonce and when it lapses, and a confirmation's or a new passkey's names the
 * sign-in that asked for it. Asking for one writes nothing anywhere.
 *
 * A ticket is checked (signature, purpose, expiry, binding) before anything is held for it; then its
 * nonce is claimed, and only then is the response it came back with verified. A failed verification
 * gives the nonce back, so the ceremony can be tried again; a passed one keeps it until the ticket
 * lapses, so the same response never signs in twice, however many requests carry it at once.
 */
import { randomBytes } from "node:crypto";
import { PASSKEY_TIMEOUT_MS, constantTimeEqual, randomHex } from "@stuga/auth";
import { b64urlDecodeText, b64urlEncodeText, signTicket } from "../auth/signed-ticket.js";

export type PasskeyPurpose = "sign-in" | "reauth" | "add";

/** The sign-in a confirmation or a new passkey is for. */
export interface PasskeyBinding {
  alias: string;
  sid: string;
}

export interface PasskeyTicket {
  purpose: PasskeyPurpose;
  nonce: string;
  expiresAt: number;
  binding: PasskeyBinding | null;
}

export interface PasskeyChallenges {
  /** A new challenge's text: the ticket the browser signs, as is. */
  issue(purpose: PasskeyPurpose, binding: PasskeyBinding | null): string;
  /** The ticket `text` is, when it was signed by this process for `purpose` and has not lapsed; null otherwise. */
  read(text: string, purpose: PasskeyPurpose): PasskeyTicket | null;
  /** Hold the ticket's nonce; false when it is held already. */
  claim(ticket: PasskeyTicket): boolean;
  /** Give a nonce back after a verification that failed. */
  release(ticket: PasskeyTicket): void;
  /** Nonces held, for tests. */
  held(): number;
}

const VERSION = "v1";
const PURPOSES: readonly PasskeyPurpose[] = ["sign-in", "reauth", "add"];

export function createPasskeyChallenges(opts: { now?: () => number; key?: string } = {}): PasskeyChallenges {
  const now = opts.now ?? Date.now;
  /** This process's own: never stored, never derived from anything that outlives it. */
  const key = opts.key ?? randomBytes(32).toString("base64url");
  /** Nonce → when its ticket lapses. */
  const claimed = new Map<string, number>();

  const domain = (purpose: PasskeyPurpose) => `stuga/passkey/${VERSION}/${purpose}`;

  function sweep(): void {
    const t = now();
    for (const [nonce, until] of claimed) if (until <= t) claimed.delete(nonce);
  }

  return {
    issue(purpose, binding) {
      const fields = [
        VERSION,
        purpose,
        randomHex(16),
        now() + PASSKEY_TIMEOUT_MS,
        b64urlEncodeText(binding?.alias ?? ""),
        b64urlEncodeText(binding?.sid ?? ""),
      ].join(".");
      return `${fields}.${signTicket(key, domain(purpose), fields)}`;
    },

    read(text, purpose) {
      if (text.length > 512) return null;
      const parts = text.split(".");
      if (parts.length !== 7) return null;
      const [version, named, nonce, expires, alias64, sid64, signature] = parts as [string, string, string, string, string, string, string];
      if (version !== VERSION || named !== purpose || !PURPOSES.includes(named)) return null;
      const expected = signTicket(key, domain(purpose), parts.slice(0, 6).join("."));
      if (!constantTimeEqual(signature, expected)) return null;
      const expiresAt = Number(expires);
      if (!Number.isFinite(expiresAt) || expiresAt <= now() || !/^[0-9a-f]{32}$/.test(nonce)) return null;
      const alias = b64urlDecodeText(alias64);
      const sid = b64urlDecodeText(sid64);
      if (alias === null || sid === null) return null;
      return { purpose, nonce, expiresAt, binding: alias && sid ? { alias, sid } : null };
    },

    claim(ticket) {
      sweep();
      if (claimed.has(ticket.nonce)) return false;
      claimed.set(ticket.nonce, ticket.expiresAt);
      return true;
    },

    release(ticket) {
      claimed.delete(ticket.nonce);
    },

    held() {
      sweep();
      return claimed.size;
    },
  };
}
