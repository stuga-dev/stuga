import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeConnectorFiles, renderFrpcToml, tomlString, writeConnectorFiles, writeTokenFiles } from "./frpc-config.js";
import type { RelayEntry } from "./service-client.js";

const RELAY: RelayEntry = {
  name: "relay-1",
  addr: "relay-1.mystuga.com",
  port: 7000,
  server_name: "relay-1.mystuga.com",
  ca_pem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
};

/** The connector's config exactly as docs/remote-access.md shows it. */
const GOLDEN = `# Written by Stuga. Changes are overwritten.
serverAddr = "relay-1.mystuga.com"
serverPort = 7000
loginFailExit = false
auth.method = "oidc"
auth.additionalScopes = ["HeartBeats"]
auth.oidc.tokenSource.type = "file"
auth.oidc.tokenSource.file.path = "/Users/liv/.stuga-remote/relay-1.jwt"
transport.tls.enable = true
transport.tls.trustedCaFile = "/Users/liv/.stuga-remote/relay-1.ca.pem"
transport.tls.serverName = "relay-1.mystuga.com"
transport.heartbeatInterval = 30
transport.heartbeatTimeout = 90
transport.poolCount = 2
log.to = "console"
log.level = "info"

[[proxies]]
name = "k7f3q2"
type = "https"
customDomains = ["k7f3q2.mystuga.com"]
transport.proxyProtocolVersion = "v2"
[proxies.plugin]
type = "unix_domain_socket"
unixPath = "/Users/liv/.stuga-remote/https.sock"
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "stuga-frpc-"));
  dirs.push(d);
  return d;
};

describe("the connector's config", () => {
  it("renders exactly the documented config", () => {
    expect(renderFrpcToml({ relay: RELAY, id: "k7f3q2", hostname: "k7f3q2.mystuga.com", dir: "/Users/liv/.stuga-remote" })).toBe(GOLDEN);
  });

  it("escapes quotes, backslashes and control characters in every string, and keeps other characters as they are", () => {
    expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(tomlString("line\nbreak\ttab\u0001\u007f")).toBe('"line\\nbreak\\ttab\\u0001\\u007F"');
    expect(tomlString("/Users/Åsa/.stuga-remote")).toBe('"/Users/Åsa/.stuga-remote"');
    const toml = renderFrpcToml({ relay: RELAY, id: "k7f3q2", hostname: "k7f3q2.mystuga.com", dir: '/Users/o"brien\\x/.stuga-remote' });
    expect(toml).toContain('auth.oidc.tokenSource.file.path = "/Users/o\\"brien\\\\x/.stuga-remote/relay-1.jwt"');
    expect(toml).toContain('unixPath = "/Users/o\\"brien\\\\x/.stuga-remote/https.sock"');
  });

  it("never names a command, an admin server, a user, an include or metadata", () => {
    const toml = renderFrpcToml({ relay: RELAY, id: "k7f3q2", hostname: "k7f3q2.mystuga.com", dir: "/tmp/x" });
    for (const word of ["exec", "webServer", "user", "includes", "metadatas", "tcp"]) expect(toml, word).not.toMatch(new RegExp(`^${word}|\\.${word}\\b|\\b${word} =`, "m"));
    expect(toml.match(/^type = /gm)).toEqual(["type = ", "type = "]);
    expect(toml).toContain('type = "unix_domain_socket"');
  });
});

describe("the connector's files", () => {
  it("writes the config and the relay's certificate 0640, and hashes what they hold", async () => {
    const dir = tempDir();
    const first = await writeConnectorFiles({ dir, id: "k7f3q2", hostname: "k7f3q2.mystuga.com", relays: [RELAY], previous: [] });
    expect(readdirSync(dir).sort()).toEqual(["relay-1.ca.pem", "relay-1.toml"]);
    for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).mode & 0o777, name).toBe(0o640);
    expect(readFileSync(join(dir, "relay-1.ca.pem"), "utf8")).toBe(RELAY.ca_pem);
    const same = await writeConnectorFiles({ dir, id: "k7f3q2", hostname: "k7f3q2.mystuga.com", relays: [RELAY], previous: [RELAY] });
    expect(same.sha256).toBe(first.sha256);
    const moved = await writeConnectorFiles({ dir, id: "k7f3q2", hostname: "k7f3q2.mystuga.com", relays: [{ ...RELAY, port: 7001 }], previous: [RELAY] });
    expect(moved.sha256).not.toBe(first.sha256);
  });

  it("removes the files of a relay no longer listed", async () => {
    const dir = tempDir();
    const relay2 = { ...RELAY, name: "relay-2", addr: "relay-2.mystuga.com", server_name: "relay-2.mystuga.com" };
    await writeConnectorFiles({ dir, id: "k7f3q2", hostname: "k7f3q2.mystuga.com", relays: [RELAY, relay2], previous: [] });
    await writeTokenFiles(dir, [RELAY, relay2], "a.b.c");
    await writeConnectorFiles({ dir, id: "k7f3q2", hostname: "k7f3q2.mystuga.com", relays: [relay2], previous: [RELAY, relay2] });
    expect(readdirSync(dir).sort()).toEqual(["relay-2.ca.pem", "relay-2.jwt", "relay-2.toml"]);
  });

  it("removes only what it wrote, and nothing a name could point outside the directory", async () => {
    const dir = tempDir();
    await writeConnectorFiles({ dir, id: "k7f3q2", hostname: "k7f3q2.mystuga.com", relays: [RELAY], previous: [] });
    await writeTokenFiles(dir, [RELAY], "a.b.c");
    writeFileSync(join(dir, "notes.txt"), "mine");
    const outside = join(dir, "..", `${dir.split("/").pop()}-outside.jwt`);
    writeFileSync(outside, "keep");
    await removeConnectorFiles(dir, ["relay-1", `../${dir.split("/").pop()}-outside`]);
    expect(readdirSync(dir)).toEqual(["notes.txt"]);
    expect(readFileSync(outside, "utf8")).toBe("keep");
    rmSync(outside);
  });

  it("replaces the credential whole: a reader never sees part of one", async () => {
    const dir = tempDir();
    const path = join(dir, "relay-1.jwt");
    const jwt = (n: number) => `${"h".repeat(40)}.${String(n).repeat(400)}.${"s".repeat(86)}`;
    await writeTokenFiles(dir, [RELAY], jwt(1));
    let reading = true;
    const seen = new Set<string>();
    const reader = (async () => {
      while (reading) {
        seen.add(readFileSync(path, "utf8"));
        await new Promise((r) => setImmediate(r));
      }
    })();
    for (let n = 2; n <= 9; n++) await writeTokenFiles(dir, [RELAY], jwt(n));
    reading = false;
    await reader;
    for (const text of seen) expect(text).toMatch(/^h{40}\.(\d)\1{399}\.s{86}\n$/);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir)).toEqual(["relay-1.jwt"]);
  });
});
