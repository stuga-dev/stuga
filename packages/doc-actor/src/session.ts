/**
 * Who holds each document socket, and the fan-out over the open ones.
 *
 * Every field but `agent` is asserted by the node from the verified credential
 * at upgrade; no frame can change them. `agent` is a client-chosen display label
 * and must never decide anything.
 */
import type { ActorSocket, ActorState } from "@stuga/runtime";
import { encodeEmpty } from "@stuga/protocol/wire/frame";
import { CloseCode, Opcode } from "@stuga/protocol/wire/opcodes";
import { bucketClientType, CLIENT_TYPES, type ClientType } from "./client-type.js";

export interface SessionMeta {
  alias: string;
  /** Display label from `?agent=`; logs and attribution only. */
  agent: string | null;
  /** The socket authenticated with an agent credential. Raw Yjs writes and the co-author hang off this. */
  agentAuth: boolean;
  /** The human an agent socket acts for; null on a human socket. Attribution only. */
  onBehalfOf: string | null;
  /** Editor tier; rewritten in place when the ACL changes. */
  canWrite: boolean;
  /** The principals the node resolved at upgrade (user, groups, org, agent). */
  principals: string[];
  /** A scoped agent key's folder confinement, forwarded untouched; null when unscoped. */
  scopeFolderIds: string[] | null;
  workspaceId: string;
  /** Whether the socket echoed the current DOCUMENT_EPOCH. */
  epochAcked: boolean;
}

export type DocSocket = ActorSocket<SessionMeta>;

/**
 * The session a `/connect` request describes, or null when the node left out
 * something the actor would otherwise have to guess (fail closed). Lists arrive
 * as repeated params, so a delimiter inside a value cannot forge an extra entry.
 */
export function parseSession(url: URL): SessionMeta | null {
  const alias = url.searchParams.get("alias");
  const write = url.searchParams.get("write");
  const principals = url.searchParams.getAll("principal").filter(Boolean);
  const workspaceId = url.searchParams.get("workspaceId");
  if (!alias || (write !== "0" && write !== "1") || principals.length === 0 || !workspaceId) return null;
  const scopeFolderIds = url.searchParams.getAll("scopeFolder").filter(Boolean);
  return {
    alias,
    agent: url.searchParams.get("agent") || null,
    agentAuth: url.searchParams.get("agentAuth") === "1",
    onBehalfOf: url.searchParams.get("onBehalfOf") || null,
    canWrite: write === "1",
    principals,
    scopeFolderIds: scopeFolderIds.length > 0 ? scopeFolderIds : null,
    workspaceId,
    epochAcked: false,
  };
}

/**
 * Is this session named by an ACL array? Set intersection over the principals
 * stamped at upgrade, so a group or org grant counts; group membership changes
 * reach an open socket only on reconnect.
 */
export function namedBy(meta: SessionMeta, acl: Set<string>): boolean {
  return meta.principals.some((principal) => acl.has(principal));
}

/** Send to a socket that may already be gone; a throw here would escape an awaited handler. */
export function safeSend(ws: DocSocket, frame: Uint8Array | ArrayBuffer | string): boolean {
  try {
    ws.send(frame);
    return true;
  } catch {
    return false;
  }
}

/** The open sockets of one document, as the host reports them. */
export class Peers {
  constructor(private readonly state: ActorState<SessionMeta>) {}

  all(): DocSocket[] {
    return this.state.getWebSockets();
  }

  broadcast(frame: Uint8Array | ArrayBuffer | string, except?: DocSocket): void {
    for (const ws of this.all()) {
      if (ws !== except) safeSend(ws, frame);
    }
  }

  /** Run frames go to the reviewer's human sockets only, never to an agent's. */
  sendToReviewer(reviewer: string, frame: Uint8Array): void {
    for (const ws of this.all()) {
      if (!ws.meta.agentAuth && ws.meta.alias === reviewer) safeSend(ws, frame);
    }
  }

  /**
   * Void one socket's document state: DOC_RESET as a frame (the browser reloads
   * on it) and as a close code (what an MCP connection notices).
   */
  resetSocket(ws: DocSocket, reason: string): void {
    safeSend(ws, encodeEmpty(Opcode.DOC_RESET));
    try {
      ws.close(CloseCode.DOC_RESET, reason);
    } catch {
      /* already gone */
    }
  }

  /**
   * Close every socket the ACL no longer admits (4403) and re-tier the rest.
   * Returns the sockets demoted to viewer so the caller can tell them.
   */
  applyAcl(allowed: Set<string>, writers: Set<string>): DocSocket[] {
    const demoted: DocSocket[] = [];
    for (const ws of this.all()) {
      if (!namedBy(ws.meta, allowed)) {
        try {
          ws.close(CloseCode.ACCESS_REVOKED, "access revoked");
        } catch {
          /* already closing */
        }
        continue;
      }
      const canWrite = namedBy(ws.meta, writers);
      if (canWrite === ws.meta.canWrite) continue;
      ws.meta.canWrite = canWrite;
      if (!canWrite) demoted.push(ws);
    }
    return demoted;
  }

  /**
   * Log live connection counts by client type, derived from the host's socket
   * set. The client-chosen `agent` label is bucketed so it cannot mint a new
   * series; `closing` is still listed while its close is handled.
   */
  logConnectionCounts(docId: string, event: "connect" | "disconnect", closing?: DocSocket): void {
    const counts = Object.fromEntries(CLIENT_TYPES.map((t) => [t, 0])) as Record<ClientType, number>;
    let total = 0;
    for (const ws of this.all()) {
      if (ws === closing) continue;
      counts[bucketClientType(ws.meta.agent)]++;
      total++;
    }
    console.info("ws connections", { docId, event, total, byType: counts });
  }
}
