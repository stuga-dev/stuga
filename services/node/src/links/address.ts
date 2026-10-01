/**
 * Which address an invite link or a password link points at (docs/remote-access.md, "Links you
 * share"): the node's own network or its remote address. By default the one its maker is using,
 * since the person it is for is most likely where they are; but when the node's own address is this
 * computer only (PUBLIC_ORIGIN on loopback, as a local-only Docker install has it) and the remote
 * address is on, the remote one, which anyone can open. A link for the remote address needs it on.
 */
import { isLoopbackHost } from "../net/addresses.js";
import type { NodeEnv } from "../env.js";
import type { CredentialArrival } from "@stuga/db";

export type LinkAddress = "local" | "remote";

/** What a link's maker can choose between, as the dialogs that make links read it. */
export interface LinkAddresses {
  /** Whether the remote address is on, and so offered. */
  remote: boolean;
  /** Who can open a link to the node's own address: anyone on its network, or only this computer. */
  local: "network" | "computer";
  /** What a link points at when its maker does not say. */
  default: LinkAddress;
}

/** The maker of a link: where they are, and the address they are using. */
export interface LinkMaker {
  arrival: CredentialArrival;
  servedOrigin: string;
  env: Pick<NodeEnv, "publicOrigin" | "remote">;
}

/** The remote address while it is on: the one a maker there is using, by definition on. */
function remoteOrigin(maker: LinkMaker): string | null {
  if (maker.arrival === "remote") return maker.servedOrigin;
  const now = maker.env.remote?.current();
  return now?.enabled && now.origin ? now.origin : null;
}

function localReach(env: LinkMaker["env"]): "network" | "computer" {
  try {
    return isLoopbackHost(new URL(env.publicOrigin).hostname) ? "computer" : "network";
  } catch {
    return "network";
  }
}

export function linkAddresses(maker: LinkMaker): LinkAddresses {
  const remote = remoteOrigin(maker) !== null;
  const local = localReach(maker.env);
  const fallback: LinkAddress = maker.arrival === "remote" || (local === "computer" && remote) ? "remote" : "local";
  return { remote, local, default: remote ? fallback : "local" };
}

/**
 * The origin a link `requested` for (`"local"`, `"remote"`, or absent for the default) points at,
 * and which address that is; or the refusal: 400 for anything else, 409 `remote_off` for the remote
 * address while it is off.
 */
export function linkOrigin(maker: LinkMaker, requested: unknown): { origin: string; address: LinkAddress } | { error: string; status: number; message: string } {
  if (requested !== undefined && requested !== null && requested !== "local" && requested !== "remote") {
    return { status: 400, error: "bad_request", message: 'address must be "local" or "remote"' };
  }
  const address: LinkAddress = (requested as LinkAddress | null | undefined) ?? linkAddresses(maker).default;
  if (address === "remote") {
    const origin = remoteOrigin(maker);
    if (!origin) return { status: 409, error: "remote_off", message: "Remote access is off, so a link can only open on this node's network." };
    return { origin, address };
  }
  // On the node's own network, the address its maker is using, as before; from the remote address, its own.
  return { origin: maker.arrival === "local" ? maker.servedOrigin : maker.env.publicOrigin, address };
}
