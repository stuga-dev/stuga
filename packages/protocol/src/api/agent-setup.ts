/** What a client needs to connect an agent to this node; only the node can answer it. */
export interface AgentSetup {
  /** The origin agents and browsers use for this node. */
  url: string;
  /** The MCP endpoint on that origin. */
  mcp_url: string;
  /** Which node this is. A client stores one Stuga connection; the node it holds identifies itself here. */
  node: {
    /** Chosen once and never changed: the extension's name, and how `workspaces` action:list names this node. */
    id: string;
    /** What people call the node; an administrator can rename it. */
    name: string;
  };
  /** Whether a service dialling from the internet could reach `url` (false for loopback, LAN, private). */
  reachable: boolean;
  /** Whether `url` is a loopback address: the node and the browser share a machine. */
  loopback: boolean;
  /**
   * Whether `url` is a secure context: https, or http to loopback. A client that
   * signs in through the browser refuses an OAuth token endpoint that is neither,
   * so on a plain-http LAN node its config carries a key instead.
   */
  secure: boolean;
  /** An installable extension the node builds on demand, carrying the server and a fresh key. */
  bundle: {
    /** False when this node has no built server to put in it. */
    available: boolean;
  };
  /** How to launch the stdio MCP server as a local child process. Paths are absolute: desktop clients start servers without a PATH. */
  stdio: {
    /** The interpreter that runs it. */
    command: string;
    /** The server file, or null when this node has no path a local client can open. */
    entry: string | null;
  };
}
