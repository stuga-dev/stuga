/**
 * Where the node may send a request whose URL someone else chose (an agent's image upload, a
 * webhook). The vet is on the resolved addresses, never the hostname, since any public name can
 * point at a private address. DNS rebinding between this lookup and fetch's own is not closed.
 */
import { lookup } from "node:dns/promises";
import { isIpLiteral, isLocalName, isNonPublicAddress } from "./addresses.js";

/** One wording for the refusal, so every surface says the same thing. */
const PRIVATE_ADDRESS_REFUSAL = "refusing to reach a private or loopback address";

/** Why an outbound URL was refused, or the parsed URL when it is allowed. */
type OutboundVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/** Parse and vet one outbound URL. */
export async function vetOutboundUrl(raw: string): Promise<OutboundVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `not a valid absolute URL: ${raw}` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `unsupported URL scheme "${url.protocol}" — use http(s)` };
  }
  if (isLocalName(url.hostname)) {
    return { ok: false, reason: PRIVATE_ADDRESS_REFUSAL };
  }
  if (isIpLiteral(url.hostname)) {
    return isNonPublicAddress(url.hostname) ? { ok: false, reason: PRIVATE_ADDRESS_REFUSAL } : { ok: true, url };
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    return { ok: false, reason: `could not resolve "${url.hostname}"` };
  }
  // Every answer, not just the first: one private address among public ones is a way in.
  if (addresses.length === 0 || addresses.some((a) => isNonPublicAddress(a.address))) {
    return { ok: false, reason: PRIVATE_ADDRESS_REFUSAL };
  }
  return { ok: true, url };
}
