// The node image's HEALTHCHECK: GET /ready on the node's own listener, which serves only https when
// TLS_CERT_DIR is set. The certificate names PUBLIC_ORIGIN's host rather than the address probed, and
// this is a liveness probe, not a trust decision, so it is not verified.
import http from "node:http";
import https from "node:https";

const env = process.env;
const bind = env.BIND?.trim();
const host = !bind || bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
const port = Number(env.PORT?.trim() || 8787);
const client = env.TLS_CERT_DIR?.trim() ? https : http;

const request = client.get({ host, port, path: "/ready", rejectUnauthorized: false, timeout: 4000 }, (response) => {
  response.resume();
  process.exit(response.statusCode >= 200 && response.statusCode < 300 ? 0 : 1);
});
request.on("timeout", () => request.destroy(new Error("no answer from /ready")));
request.on("error", () => process.exit(1));
