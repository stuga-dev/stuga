/**
 * The shared directory as Docker arranges it, with real owners: only root can give files away, so
 * this runs as root, in a container (packaging/docker/test/remote-dir-in-image.sh), and is skipped
 * anywhere else. The connector's side runs as its own user, 65532, in a child process.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, lchownSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyRemoteHeaders } from "../http/security-headers.js";
import { createRemoteListener } from "../platform/remote-listener.js";
import { makeTestCert } from "../testing/cert.js";
import { readConnectorStatus, writeConnectorRequest } from "./connector.js";
import { ensureRemoteDir } from "./files.js";
import { writeConnectorFiles, writeTokenFiles } from "./frpc-config.js";

const CONNECTOR = 65532;
const group = { gid: CONNECTOR, connectorUid: CONNECTOR };
const RELAY = { name: "relay-1", addr: "relay-1.stuga.test", port: 7000, server_name: "relay-1.stuga.test", ca_pem: "-----BEGIN CERTIFICATE-----\n" };

const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The directory as a volume first mounted by the connector's container may leave it: the connector's, 0755. */
function connectorsVolume(): string {
  const parent = mkdtempSync(join(tmpdir(), "stuga-remote-root-"));
  dirs.push(parent);
  chmodSync(parent, 0o755);
  const dir = join(parent, "stuga-remote");
  mkdirSync(dir, { mode: 0o755 });
  chownSync(dir, CONNECTOR, CONNECTOR);
  return dir;
}

const owner = (path: string) => {
  const s = lstatSync(path);
  return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 };
};

/** Run `script` as the connector's user; what it prints, parsed. */
function asConnector(script: string, env: Record<string, string>): Record<string, string> {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { uid: CONNECTOR, gid: CONNECTOR, env, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as Record<string, string>;
}

/** Each step's outcome, `ok` or the error's code. */
const CONNECTOR_SCRIPT = `
import fs from "node:fs";
import net from "node:net";
const dir = process.env.DIR;
const out = {};
const step = (name, fn) => { try { fn(); out[name] = "ok"; } catch (e) { out[name] = e.code ?? String(e); } };
step("read toml", () => fs.readFileSync(dir + "/relay-1.toml"));
step("read jwt", () => fs.readFileSync(dir + "/relay-1.jwt"));
step("read request", () => fs.readFileSync(dir + "/control/request"));
step("write dir", () => fs.writeFileSync(dir + "/planted", "x"));
step("replace jwt", () => fs.renameSync(dir + "/relay-1.jwt", dir + "/status/taken"));
step("write control", () => fs.writeFileSync(dir + "/control/planted", "x"));
step("write status", () => fs.writeFileSync(dir + "/status/status.json", process.env.STATUS));
step("link status", () => fs.symlinkSync(dir + "/relay-1.jwt", dir + "/status/linked.json"));
const socket = net.connect(dir + "/https.sock");
socket.on("connect", () => { out["connect socket"] = "ok"; done(); });
socket.on("error", (e) => { out["connect socket"] = e.code; done(); });
function done() { socket.destroy(); console.log(JSON.stringify(out)); }
`;

describe.skipIf(process.getuid?.() !== 0)("the shared directory, arranged as root for a connector of its own", () => {
  it("puts owners and modes right on a volume the connector got first, and on one changed since", async () => {
    const dir = connectorsVolume();
    // Planted by the connector while it could write there: a link in place of control/, a file in place of status/.
    symlinkSync("/etc", join(dir, "control"));
    writeFileSync(join(dir, "status"), "");
    const etc = owner("/etc");
    await ensureRemoteDir(dir, { group });
    expect(owner(dir)).toEqual({ uid: 0, gid: CONNECTOR, mode: 0o2750 });
    expect(owner(join(dir, "control"))).toEqual({ uid: 0, gid: CONNECTOR, mode: 0o750 });
    expect(owner(join(dir, "status"))).toEqual({ uid: CONNECTOR, gid: CONNECTOR, mode: 0o750 });
    expect(owner("/etc")).toEqual(etc);

    chownSync(dir, 0, 0);
    chmodSync(dir, 0o777);
    chownSync(join(dir, "control"), CONNECTOR, CONNECTOR);
    chownSync(join(dir, "status"), 0, 0);
    chmodSync(join(dir, "status"), 0o777);
    writeFileSync(join(dir, "relay-1.toml"), "x", { mode: 0o600 });
    await ensureRemoteDir(dir, { group });
    expect(owner(dir)).toEqual({ uid: 0, gid: CONNECTOR, mode: 0o2750 });
    expect(owner(join(dir, "control"))).toEqual({ uid: 0, gid: CONNECTOR, mode: 0o750 });
    expect(owner(join(dir, "status"))).toEqual({ uid: CONNECTOR, gid: CONNECTOR, mode: 0o750 });
    expect(owner(join(dir, "relay-1.toml"))).toEqual({ uid: 0, gid: CONNECTOR, mode: 0o640 });
  });

  it("removes what the connector planted before the node first arranged the volume", async () => {
    const dir = connectorsVolume();
    const plant = (name: string, make: (path: string) => void) => {
      make(join(dir, name));
      lchownSync(join(dir, name), CONNECTOR, CONNECTOR);
    };
    // A credential that would pass for the node's, a file where the socket goes, a directory where a setting goes.
    plant("relay-1.jwt", (p) => writeFileSync(p, "a.b.c\n", { mode: 0o640 }));
    plant("https.sock", (p) => writeFileSync(p, ""));
    plant("relay-1.toml", (p) => mkdirSync(p, { mode: 0o777 }));
    plant("relay-1.toml/etc", (p) => symlinkSync("/etc", p));
    plant("control", (p) => mkdirSync(p, { mode: 0o777 }));
    plant("control/request", (p) => mkdirSync(p));
    const etc = owner("/etc");
    await ensureRemoteDir(dir, { group });
    expect(readdirSync(dir).sort()).toEqual(["control", "status"]);
    expect(readdirSync(join(dir, "control"))).toEqual([]);
    expect(owner("/etc")).toEqual(etc);
    expect(existsSync("/etc/passwd")).toBe(true);
  });

  it("lets the connector read its files, reach the socket and write only status/", async () => {
    const dir = connectorsVolume();
    const socketPath = await ensureRemoteDir(dir, { group });
    await writeConnectorFiles({ dir, id: "k7f3q2", hostname: "k7f3q2.stuga.test", relays: [RELAY], previous: [], gid: CONNECTOR });
    await writeTokenFiles(dir, [RELAY], "a.b.c", { gid: CONNECTOR });
    const hints = { request: join(dir, "control", "request"), status: join(dir, "status", "status.json") };
    await writeConnectorRequest(hints, "off", { gid: CONNECTOR });
    const listener = createRemoteListener({
      socketPath,
      hostname: "k7f3q2.stuga.test",
      handler: async () => new Response("ok"),
      upgrade: async () => new Response(null, { status: 404 }),
      decorate: applyRemoteHeaders,
      gid: CONNECTOR,
      maxBodyBytes: () => 64,
      readsOwnBody: () => false,
    });
    listener.setCertificate(makeTestCert({ dnsNames: ["k7f3q2.stuga.test"] }));
    await listener.listen();
    cleanups.push(() => listener.close());

    for (const name of ["relay-1.toml", "relay-1.ca.pem", "relay-1.jwt", "control/request"]) {
      expect(owner(join(dir, name)), name).toEqual({ uid: 0, gid: CONNECTOR, mode: 0o640 });
    }
    expect(owner(socketPath)).toEqual({ uid: 0, gid: CONNECTOR, mode: 0o660 });

    const status = JSON.stringify({ state: "stopped", message: "", at: new Date().toISOString(), connector_sha: null, config_sha: null });
    expect(asConnector(CONNECTOR_SCRIPT, { DIR: dir, STATUS: status })).toEqual({
      "read toml": "ok",
      "read jwt": "ok",
      "read request": "ok",
      "write dir": "EACCES",
      "replace jwt": "EACCES",
      "write control": "EACCES",
      "write status": "ok",
      "link status": "ok",
      "connect socket": "ok",
    });
    expect(await readConnectorStatus(hints)).toMatchObject({ state: "stopped" });
    // A link the connector put where the status goes is not read through, even by root.
    expect(await readConnectorStatus({ ...hints, status: join(dir, "status", "linked.json") })).toBeNull();
  });
});
