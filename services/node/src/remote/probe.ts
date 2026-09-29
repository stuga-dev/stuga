/**
 * The self-check: a TLS handshake with this node's own address, the way a visitor makes one,
 * through the relay and the connector and back. It sends no request; it only compares the key
 * that answered with the node's own.
 */
import { createHash } from "node:crypto";
import tls from "node:tls";

export type ProbeResult = { ok: true } | { ok: false; code: "connector_unreachable" | "wrong_certificate"; message: string };

const PROBE_TIMEOUT_MS = 10_000;

/** SHA-256 over the peer certificate's SubjectPublicKeyInfo DER, hex. */
export function peerSpkiSha256(socket: tls.TLSSocket): string | null {
  const cert = socket.getPeerX509Certificate();
  if (!cert) return null;
  return createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("hex");
}

/** Compare what answered a handshake with the key this node holds. */
export function judgeHandshake(socket: tls.TLSSocket, expectedSpkiSha256: string, hostname: string): ProbeResult {
  const seen = peerSpkiSha256(socket);
  if (seen === expectedSpkiSha256) return { ok: true };
  return { ok: false, code: "wrong_certificate", message: `${hostname} answered with a certificate that is not this node's` };
}

/** Production: `https://<hostname>:443` as the world sees it. */
export function probeThroughRelay(hostname: string, expectedSpkiSha256: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: hostname,
      port: 443,
      servername: hostname,
      // The comparison below is the check; a chain the system trusts proves nothing more here.
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    });
    const done = (result: ProbeResult) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const unreachable = (why: string) =>
      done({ ok: false, code: "connector_unreachable", message: `couldn't reach ${hostname} through the relay: ${why}` });
    const timer = setTimeout(() => unreachable(`no handshake within ${PROBE_TIMEOUT_MS / 1000}s`), PROBE_TIMEOUT_MS);
    socket.once("secureConnect", () => done(judgeHandshake(socket, expectedSpkiSha256, hostname)));
    socket.once("error", (e) => unreachable(e.message));
  });
}
