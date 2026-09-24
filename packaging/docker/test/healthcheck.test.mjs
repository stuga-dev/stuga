// node --test packaging/docker/test/healthcheck.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const probe = new URL("../healthcheck.mjs", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "stuga-healthcheck-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A certificate for a name other than the probed address, as the node's own TLS presents. */
function certificate() {
  const key = join(scratch, "privkey.pem");
  const cert = join(scratch, "fullchain.pem");
  const args = ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=node.example"];
  try {
    execFileSync("openssl", [...args, "-keyout", key, "-out", cert], { stdio: "ignore" });
  } catch {
    return null;
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}
const tls = certificate();

async function serve(server, status, host = "127.0.0.1") {
  server.on("request", (req, res) => {
    res.writeHead(req.url === "/ready" ? status : 404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  after(() => server.close());
  return server.address().port;
}

function runProbe(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [probe], { env: { PATH: process.env.PATH, ...env }, stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test("a plain http node answering /ready 200 is healthy", async () => {
  const port = await serve(http.createServer(), 200);
  assert.equal(await runProbe({ PORT: String(port) }), 0);
});

test("a node answering /ready 503 is unhealthy", async () => {
  const port = await serve(http.createServer(), 503);
  assert.equal(await runProbe({ PORT: String(port) }), 1);
});

test("with TLS_CERT_DIR the probe speaks https and accepts a certificate for another name", { skip: !tls && "no openssl" }, async () => {
  const port = await serve(https.createServer(tls), 200);
  assert.equal(await runProbe({ PORT: String(port), TLS_CERT_DIR: scratch }), 0);
});

test("the probe follows TLS_CERT_DIR rather than guessing the scheme", { skip: !tls && "no openssl" }, async () => {
  const httpsPort = await serve(https.createServer(tls), 200);
  const httpPort = await serve(http.createServer(), 200);
  assert.equal(await runProbe({ PORT: String(httpsPort) }), 1);
  assert.equal(await runProbe({ PORT: String(httpPort), TLS_CERT_DIR: scratch }), 1);
});

test("a wildcard BIND is probed on 127.0.0.1", async () => {
  const port = await serve(http.createServer(), 200);
  assert.equal(await runProbe({ PORT: String(port), BIND: "0.0.0.0" }), 0);
  assert.equal(await runProbe({ PORT: String(port), BIND: "::" }), 0);
});

test("a specific BIND is probed on that address", async (t) => {
  let port;
  try {
    port = await serve(http.createServer(), 200, "::1");
  } catch {
    t.skip("no IPv6 loopback");
    return;
  }
  assert.equal(await runProbe({ PORT: String(port), BIND: "::1" }), 0);
  assert.equal(await runProbe({ PORT: String(port) }), 1);
});

test("nothing listening is unhealthy", async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await runProbe({ PORT: String(port) }), 1);
});
