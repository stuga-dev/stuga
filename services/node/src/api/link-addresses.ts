/** `GET /api/link-addresses`: where the links this person makes can point (links/address.ts). */
import { json } from "../http/respond.js";
import type { AccountCall } from "../http/router.js";
import { linkAddresses } from "../links/address.js";

export async function getLinkAddresses({ ctx }: AccountCall): Promise<Response> {
  return json(linkAddresses(ctx), { headers: { "cache-control": "no-store" } });
}
