/**
 * The connection to the node's /mcp. With a key it is sent as the bearer; with
 * none, this server signs in (sign-in.ts) and the SDK refreshes the token as it
 * expires. A sign-in waits for the person to answer the consent page, so the
 * connection is a promise the proxy awaits only as long as a client will wait.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolRequest, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_CLIENT_HEADER, AGENT_MODEL_HEADER } from "@stuga/protocol/api/headers";
import type { ResolvedConfig } from "./config.js";
import type { NodeSignIn } from "./sign-in.js";

/** What the proxy needs of the node's /mcp. */
export interface UpstreamClient {
  getInstructions(): string | undefined;
  listTools(): Promise<ListToolsResult>;
  /** A CallToolResult, or the legacy `toolResult` shape an old server might send. */
  callTool(params: CallToolRequest["params"]): Promise<{ [key: string]: unknown }>;
}

export type UpstreamState = "connecting" | "signing-in" | "ready" | "failed";

/** Retries of a node that did not answer back off to this. */
const MAX_RETRY_MS = 60_000;

export class Upstream {
  private connection: Promise<UpstreamClient> | null = null;
  private retryMs = 2_000;
  state: UpstreamState = "connecting";
  /** Why the last attempt failed, in words for the model. */
  failure = "";

  constructor(
    private readonly config: ResolvedConfig,
    private readonly signIn: NodeSignIn | null,
    private readonly onReady: () => void = () => {},
  ) {}

  /**
   * The connected client, connecting (and signing in) first if need be. A node
   * that did not answer is tried again in the background, so its tools arrive
   * with a list-changed notice when it does; a sign-in nobody finished waits
   * for the next call instead of opening the browser again by itself.
   */
  ready(): Promise<UpstreamClient> {
    this.connection ??= this.connect().then(
      (client) => {
        this.state = "ready";
        this.retryMs = 2_000;
        this.onReady();
        return client;
      },
      (error: unknown) => {
        const wasSigningIn = this.state === "signing-in";
        this.state = "failed";
        this.failure = error instanceof Error ? error.message : String(error);
        this.connection = null;
        if (!wasSigningIn) {
          setTimeout(() => void this.ready().catch(() => undefined), this.retryMs).unref();
          this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
        }
        throw error;
      },
    );
    return this.connection;
  }

  /** Drop the connection, so the next call starts again: after the node said the credential no longer works. */
  reset(): void {
    this.connection = null;
    this.state = "connecting";
  }

  private transport(): StreamableHTTPClientTransport {
    const headers: Record<string, string> = { [AGENT_CLIENT_HEADER]: this.config.client };
    if (this.config.model) headers[AGENT_MODEL_HEADER] = this.config.model;
    if (!this.signIn) headers.authorization = `Bearer ${this.config.token}`;
    return new StreamableHTTPClientTransport(new URL("/mcp", this.config.url), {
      requestInit: { headers },
      ...(this.signIn ? { authProvider: this.signIn } : {}),
    });
  }

  private async connect(): Promise<UpstreamClient> {
    this.state = "connecting";
    // A sign-in already under way (a call found the connection no longer accepted) is finished, not started again.
    if (this.signIn?.inFlight) return this.finishSignIn(this.transport());
    const client = new Client({ name: "stuga-mcp", version: this.config.version });
    const transport = this.transport();
    try {
      await client.connect(transport);
      return client;
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || !this.signIn) throw reachable(error, this.config.url);
      return this.finishSignIn(transport);
    }
  }

  /** The browser is open on the node's consent page; the answer comes back to the loopback listener. */
  private async finishSignIn(transport: StreamableHTTPClientTransport): Promise<UpstreamClient> {
    this.state = "signing-in";
    const code = await this.signIn!.waitForCode();
    try {
      await transport.finishAuth(code);
    } finally {
      this.signIn!.codeUsed();
    }
    const signedIn = new Client({ name: "stuga-mcp", version: this.config.version });
    await signedIn.connect(this.transport()).catch((e: unknown) => {
      throw reachable(e, this.config.url);
    });
    return signedIn;
  }
}

/** An error in words that say which node could not be reached. */
function reachable(error: unknown, url: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UnauthorizedError) return new Error(`the Stuga node at ${url} refused this server's key: ${message}`);
  return new Error(`cannot reach the Stuga node at ${url}: ${message}`);
}
