/**
 * Signing this server in to a node the way a desktop app signs in: the node's
 * own consent page in the person's browser, a one-off loopback redirect back
 * here (RFC 8252), and a refresh token kept in a file only this user can read.
 * Used when no key was given; the node registers this server as a client on
 * first use.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

/** What is kept per node: the client registration and the tokens. */
interface NodeCredentials {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
}

/** A JSON file of credentials keyed by node URL, readable by this user alone. */
export class CredentialFile {
  constructor(private readonly path: string) {}

  read(nodeUrl: string): NodeCredentials {
    return this.all()[nodeUrl] ?? {};
  }

  update(nodeUrl: string, change: (current: NodeCredentials) => NodeCredentials): void {
    const all = this.all();
    all[nodeUrl] = change(all[nodeUrl] ?? {});
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Written aside and renamed over, so a crash never leaves half a file, and created private.
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
  }

  private all(): Record<string, NodeCredentials> {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, NodeCredentials>) : {};
    } catch {
      return {};
    }
  }
}

/** Open a URL in the person's browser; best-effort, since the URL is also written to stderr. */
export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
  } catch {
    // Nothing to open with: the URL on stderr is the fallback.
  }
}

const SIGNED_IN_PAGE =
  "<!doctype html><meta charset=utf-8><title>Stuga</title>" +
  "<body style=\"font:16px system-ui;margin:4rem auto;max-width:28rem\"><h1>Signed in to Stuga</h1><p>You can close this tab.</p>";

const PAGE_FOR_ERROR = (message: string): string =>
  "<!doctype html><meta charset=utf-8><title>Stuga</title>" +
  `<body style="font:16px system-ui;margin:4rem auto;max-width:28rem"><h1>Not signed in</h1><p>${message.replace(/[<>&"]/g, "")}</p>`;

export interface SignInOptions {
  nodeUrl: string;
  /** What the node lists this connection as, until the person renames it. */
  clientName: string;
  store: CredentialFile;
  open?: (url: string) => void;
  log?: (line: string) => void;
}

/** How long a sign-in waits for the person before its link stops working. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/**
 * The OAuth client this server is to a node. `listen()` must have resolved
 * before a sign-in starts: the redirect URI carries the port it was given.
 * Every sign-in the SDK starts, at connect or mid-session, gets a receiver at
 * once, so the person's answer is never lost however the flow began.
 */
export class NodeSignIn implements OAuthClientProvider {
  private server: Server | null = null;
  private port = 0;
  private verifier = "";
  private expectedState = "";
  private pending: { resolve: (code: string) => void; reject: (error: Error) => void } | null = null;
  /** The code of the sign-in in progress, held once it arrives until `codeUsed()`; null when there is none. */
  inFlight: Promise<string> | null = null;
  private readonly open: (url: string) => void;
  private readonly log: (line: string) => void;

  constructor(private readonly options: SignInOptions) {
    this.open = options.open ?? openInBrowser;
    this.log = options.log ?? ((line) => console.error(line));
  }

  /** Start the loopback listener for the redirect. */
  async listen(): Promise<void> {
    if (this.server) return;
    this.server = createServer((req, res) => this.callback(req.url ?? "", res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    // Idle between sign-ins; never keeps the process alive on its own.
    this.server.unref();
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }

  /** The code the browser brings back for the sign-in in progress, starting a wait if none has. */
  waitForCode(timeoutMs = SIGN_IN_TIMEOUT_MS): Promise<string> {
    this.inFlight ??= new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending?.reject(new Error("the sign-in was not completed in time"));
        // A late answer to this link is refused, not taken as a sign-in nobody is waiting for.
        this.expectedState = "";
        this.verifier = "";
      }, timeoutMs);
      timer.unref();
      this.pending = {
        // An answer that comes before anyone asks for it is held, so the person never approves twice.
        resolve: (code) => {
          clearTimeout(timer);
          this.pending = null;
          resolve(code);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pending = null;
          this.inFlight = null;
          reject(error);
        },
      };
    });
    // Nobody may be awaiting it yet; a refusal must not surface as an unhandled rejection.
    this.inFlight.catch(() => undefined);
    return this.inFlight;
  }

  private callback(path: string, res: import("node:http").ServerResponse): void {
    const url = new URL(path, `http://127.0.0.1:${this.port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const answer = (status: number, page: string): void => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page);
    };
    // A redirect this server did not start is someone else's, whatever it carries.
    if (!this.expectedState || url.searchParams.get("state") !== this.expectedState) {
      answer(400, PAGE_FOR_ERROR("This sign-in link has expired. Start again from your app."));
      return;
    }
    this.expectedState = "";
    const code = url.searchParams.get("code");
    if (!code) {
      const reason = url.searchParams.get("error") === "access_denied" ? "Access was not allowed." : "The node did not sign you in.";
      answer(400, PAGE_FOR_ERROR(reason));
      this.pending?.reject(new Error(reason));
      this.pending = null;
      return;
    }
    answer(200, SIGNED_IN_PAGE);
    this.pending?.resolve(code);
    this.pending = null;
  }

  /** The held code was exchanged (or failed to be): the next sign-in starts afresh. */
  codeUsed(): void {
    this.inFlight = null;
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.options.clientName,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.expectedState = randomBytes(16).toString("base64url");
    return this.expectedState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.options.store.read(this.options.nodeUrl).client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.options.store.update(this.options.nodeUrl, (current) => ({ ...current, client }));
  }

  tokens(): OAuthTokens | undefined {
    return this.options.store.read(this.options.nodeUrl).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.options.store.update(this.options.nodeUrl, (current) => ({ ...current, tokens }));
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // A new link replaces any earlier one, whose state no longer matches.
    this.pending?.reject(new Error("a newer sign-in replaced this one"));
    void this.waitForCode();
    this.log(`Stuga: sign in at ${authorizationUrl.toString()}`);
    this.open(authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  /** The node names its own /mcp; this server was pointed at the node, so it takes the node's word for it. */
  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
    return new URL(resource ?? serverUrl);
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "verifier") this.verifier = "";
    if (scope === "all" || scope === "client" || scope === "tokens") {
      this.options.store.update(this.options.nodeUrl, (current) => ({
        client: scope === "tokens" ? current.client : undefined,
        tokens: undefined,
      }));
    }
  }
}
