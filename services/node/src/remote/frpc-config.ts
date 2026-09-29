/**
 * The connector's files in the shared directory, one set per relay (docs/remote-access.md): its
 * config, the relay's certificate it pins, and the credential it logs in with. The config is
 * rendered from typed fields with every string escaped, and never names anything that runs a
 * command, opens a port or carries metadata: no `exec` source, `includes`, `webServer`, `user`,
 * `metadatas`, or plugin other than the unix socket.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SOCKET_NAME, removeFile, writeFileDurable } from "./files.js";
import type { RelayEntry } from "./service-client.js";

const FILE_MODE = 0o640;

/** A TOML basic string: quotes, backslashes and control characters escaped; anything else as it is. */
export function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0").toUpperCase()}`;
    else out += ch;
  }
  return `${out}"`;
}

export const tokenFile = (dir: string, relay: string): string => join(dir, `${relay}.jwt`);
export const caFile = (dir: string, relay: string): string => join(dir, `${relay}.ca.pem`);
export const configFile = (dir: string, relay: string): string => join(dir, `${relay}.toml`);

/** The connector's config for one relay: one https proxy for this node's hostname, onto the socket. */
export function renderFrpcToml(args: { relay: RelayEntry; id: string; hostname: string; dir: string }): string {
  const { relay, id, hostname, dir } = args;
  const s = tomlString;
  return [
    "# Written by Stuga. Changes are overwritten.",
    `serverAddr = ${s(relay.addr)}`,
    `serverPort = ${relay.port}`,
    "loginFailExit = false",
    `auth.method = "oidc"`,
    `auth.additionalScopes = ["HeartBeats"]`,
    `auth.oidc.tokenSource.type = "file"`,
    `auth.oidc.tokenSource.file.path = ${s(tokenFile(dir, relay.name))}`,
    "transport.tls.enable = true",
    `transport.tls.trustedCaFile = ${s(caFile(dir, relay.name))}`,
    `transport.tls.serverName = ${s(relay.server_name)}`,
    // Explicit: under tcpMux, frpc's default, heartbeats are off, and with them the relay's re-checks.
    "transport.heartbeatInterval = 30",
    "transport.heartbeatTimeout = 90",
    "transport.poolCount = 2",
    `log.to = "console"`,
    `log.level = "info"`,
    "",
    "[[proxies]]",
    `name = ${s(id)}`,
    `type = "https"`,
    `customDomains = [${s(hostname)}]`,
    `transport.proxyProtocolVersion = "v2"`,
    "[proxies.plugin]",
    `type = "unix_domain_socket"`,
    `unixPath = ${s(join(dir, SOCKET_NAME))}`,
    "",
  ].join("\n");
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Bring the config and CA files in line with `relays`, writing only what differs from the disk,
 * and remove the files of relays no longer listed. Returns the sha-256 over what the files now hold.
 */
export async function writeConnectorFiles(args: {
  dir: string;
  id: string;
  hostname: string;
  relays: readonly RelayEntry[];
  /** The relays listed before, whose files go when they are no longer listed. */
  previous: readonly { name: string }[];
}): Promise<{ sha256: string }> {
  const hash = createHash("sha256");
  for (const relay of [...args.relays].sort((a, b) => a.name.localeCompare(b.name))) {
    const files: Array<[string, string]> = [
      [configFile(args.dir, relay.name), renderFrpcToml({ relay, id: args.id, hostname: args.hostname, dir: args.dir })],
      [caFile(args.dir, relay.name), relay.ca_pem],
    ];
    for (const [path, content] of files) {
      if ((await readOrNull(path)) !== content) await writeFileDurable(path, content, FILE_MODE);
      hash.update(`${path}\0${content}\0`);
    }
  }
  const listed = new Set(args.relays.map((r) => r.name));
  await removeConnectorFiles(
    args.dir,
    args.previous.map((r) => r.name).filter((name) => !listed.has(name)),
  );
  return { sha256: hash.digest("hex") };
}

/** Put the credential where each relay's connector reads it, as one line, replaced whole. */
export async function writeTokenFiles(dir: string, relays: readonly { name: string }[], credential: string): Promise<void> {
  for (const relay of relays) await writeFileDurable(tokenFile(dir, relay.name), `${credential}\n`, FILE_MODE);
}

/** Every file the node wrote for these relays: config, CA and credential. */
export async function removeConnectorFiles(dir: string, names: readonly string[]): Promise<void> {
  // A name is part of a path: only ever one a check-in could have delivered.
  for (const name of names.filter((n) => /^[a-z0-9-]{1,32}$/.test(n))) {
    await removeFile(tokenFile(dir, name));
    await removeFile(configFile(dir, name));
    await removeFile(caFile(dir, name));
  }
}
