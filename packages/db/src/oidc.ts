/**
 * Sign-ins through the identity provider in flight: the flow a start opens, and
 * what its callback hands the browser. Everything here is single-use and short-lived.
 */
import type { OidcFlowRow, OidcTicketRow } from "./types.js";
import type { Sql } from "./client.js";

export async function createOidcFlow(
  sql: Sql,
  input: {
    state: string;
    bindingHash: string;
    nonce: string;
    codeVerifier: string;
    redirectUri: string;
    prompt: OidcFlowRow["prompt"];
    linkAlias: string | null;
    returnTo: string;
    expiresAt: Date;
  },
): Promise<void> {
  await sql`INSERT INTO oidc_flows ${sql({
    state: input.state,
    binding_hash: input.bindingHash,
    nonce: input.nonce,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    prompt: input.prompt,
    link_alias: input.linkAlias,
    return_to: input.returnTo,
    expires_at: input.expiresAt,
  })}`;
}

/** Delete the flow for `state` whatever its age, and return it only when it had not expired. */
export async function takeOidcFlow(sql: Sql, state: string): Promise<OidcFlowRow | null> {
  const rows = await sql<OidcFlowRow[]>`
    WITH taken AS (DELETE FROM oidc_flows WHERE state = ${state} RETURNING *)
    SELECT * FROM taken WHERE expires_at > now()`;
  return rows[0] ?? null;
}

export async function createOidcTicket(
  sql: Sql,
  input: {
    ticketHash: string;
    kind: OidcTicketRow["kind"];
    bindingHash: string;
    alias?: string | null;
    sub?: string | null;
    /** The issuer that vouched for `sub`, which a first visit must still find in place to link it. */
    issuer?: string | null;
    preferredUsername?: string | null;
    name?: string | null;
    email?: string | null;
    returnTo: string;
    expiresAt: Date;
  },
): Promise<void> {
  await sql`INSERT INTO oidc_tickets ${sql({
    ticket_hash: input.ticketHash,
    kind: input.kind,
    binding_hash: input.bindingHash,
    alias: input.alias ?? null,
    sub: input.sub ?? null,
    issuer: input.issuer ?? null,
    preferred_username: input.preferredUsername ?? null,
    name: input.name ?? null,
    email: input.email ?? null,
    return_to: input.returnTo,
    expires_at: input.expiresAt,
  })}`;
}

/** A live ticket of this kind, left in place. */
export async function peekOidcTicket(sql: Sql, ticketHash: string, kind: OidcTicketRow["kind"]): Promise<OidcTicketRow | null> {
  const rows = await sql<OidcTicketRow[]>`
    SELECT * FROM oidc_tickets
    WHERE ticket_hash = ${ticketHash} AND kind = ${kind} AND expires_at > now()`;
  return rows[0] ?? null;
}

/** Spend a live ticket; of two concurrent takes exactly one gets the row. */
export async function takeOidcTicket(sql: Sql, ticketHash: string, kind: OidcTicketRow["kind"]): Promise<OidcTicketRow | null> {
  const rows = await sql<OidcTicketRow[]>`
    DELETE FROM oidc_tickets
    WHERE ticket_hash = ${ticketHash} AND kind = ${kind} AND expires_at > now()
    RETURNING *`;
  return rows[0] ?? null;
}

/** Drop expired flows and tickets; the maintenance tick calls this. */
export async function purgeOidcSignIns(sql: Sql): Promise<number> {
  const flows = await sql`DELETE FROM oidc_flows WHERE expires_at <= now()`;
  const tickets = await sql`DELETE FROM oidc_tickets WHERE expires_at <= now()`;
  return flows.count + tickets.count;
}
