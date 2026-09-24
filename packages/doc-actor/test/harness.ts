/**
 * The real DocActor over the runtime's in-memory host. Alarms are recorded, not
 * fired, and close callbacks are delivered only through `closeSocket`.
 */
import type { AiConfig } from "@stuga/ai";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import {
  MemoryActorState,
  MemoryBlobStore,
  MemoryJobQueue,
  MemorySocket,
  closeSocket,
  connectActor,
} from "@stuga/runtime/testing";
import { DocActor } from "../src/doc-actor.js";
import type { DocActorEnv } from "../src/env.js";
import type { SessionMeta } from "../src/session.js";

export type DocSocket = MemorySocket<SessionMeta>;
export type { DocSocket as MemorySocket };

export const WORKSPACE = "ws_test";

export interface Harness {
  state: MemoryActorState<SessionMeta>;
  snapshots: MemoryBlobStore;
  jobs: MemoryJobQueue<IndexMessage>;
  /** Every message enqueued on the job queue. */
  readonly queued: IndexMessage[];
  env: DocActorEnv;
}

/** An AI configuration with every surface off. */
export function disabledAi(): AiConfig {
  return {
    enabled: false,
    chat: { enabled: false, defaultModel: "none", endpoints: [{ id: "default", provider: "ollama", baseUrl: "http://localhost:11434", models: [] }] },
    embed: { enabled: false, provider: "ollama", baseUrl: "http://localhost:11434", model: "none", dims: 1024, searchMaxDistance: 0.6, retrievalMaxDistance: 0.9 },
  };
}

/** Fresh state and env for one DocActor. AI is off; the internal API answers 404. */
export function harness(): Harness {
  const snapshots = new MemoryBlobStore();
  const jobs = new MemoryJobQueue<IndexMessage>();
  return {
    state: new MemoryActorState<SessionMeta>(),
    snapshots,
    jobs,
    get queued() {
      return jobs.sent;
    },
    env: {
      snapshots,
      jobs,
      ai: () => disabledAi(),
      internal: { fetch: async () => new Response("not found", { status: 404 }) },
    },
  };
}

export function makeActor(h: Harness): DocActor {
  return new DocActor(h.state, h.env);
}

/** An encoded frame as the exact-length `ArrayBuffer` a socket delivers. */
export function frameBuffer(frame: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(frame.byteLength);
  copy.set(frame);
  return copy.buffer;
}

/**
 * Open a socket the way the node does. The node always sends the write tier, the
 * principals and the workspace; they default here to a writer admitted as
 * `user:<alias>` in WORKSPACE.
 */
export function connect(actor: DocActor, h: Harness, params: Record<string, string | string[]>): Promise<DocSocket> {
  const alias = typeof params.alias === "string" ? params.alias : "anonymous";
  return connectActor(actor, h.state, { write: "1", principal: [`user:${alias}`], workspaceId: WORKSPACE, ...params }, "/connect");
}

/** Deliver the close callback the host would for `ws`. */
export function disconnect(actor: DocActor, ws: DocSocket, code = 1000): Promise<void> {
  return closeSocket(actor, ws, code);
}
