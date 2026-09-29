/**
 * Pebble, a test ACME CA, and its DNS test server challtestsrv, as packaging/docker/test/compose.pebble.yml
 * runs them for the remote-access integration suite. Pebble makes a new root each time it starts, so
 * the root certificates chain to is fetched rather than kept. For tests only.
 */
import { readFileSync } from "node:fs";
import { httpsTransport } from "../acme/transport.js";

export interface PebbleEnv {
  /** PEBBLE_DIRECTORY: the ACME directory. */
  directory: string;
  /** PEBBLE_MANAGEMENT: Pebble's management API. */
  management: string;
  /** PEBBLE_CA's contents: the root Pebble's own HTTPS is served under (its minica). */
  ca: string;
  /** CHALLTESTSRV_URL: challtestsrv's management API. */
  challtestsrv: string;
  /** CHALLTESTSRV_DNS: challtestsrv's DNS server, ip:port. */
  dns: string;
}

/** The suite's Pebble from the environment, or null when there is none to run against. */
export function pebbleEnv(env: Record<string, string | undefined> = process.env): PebbleEnv | null {
  const { PEBBLE_DIRECTORY, PEBBLE_MANAGEMENT, PEBBLE_CA, CHALLTESTSRV_URL, CHALLTESTSRV_DNS } = env;
  if (!PEBBLE_DIRECTORY || !PEBBLE_MANAGEMENT || !PEBBLE_CA || !CHALLTESTSRV_URL || !CHALLTESTSRV_DNS) return null;
  return {
    directory: PEBBLE_DIRECTORY,
    management: PEBBLE_MANAGEMENT,
    ca: readFileSync(PEBBLE_CA, "utf8"),
    challtestsrv: CHALLTESTSRV_URL,
    dns: CHALLTESTSRV_DNS,
  };
}

/** The root Pebble issues under, this run. */
export async function pebbleRoot(pebble: PebbleEnv): Promise<string> {
  const res = await httpsTransport({ ca: pebble.ca }).request(`${pebble.management}/roots/0`, { method: "GET" });
  if (res.status !== 200) throw new Error(`pebble roots/0: ${res.status}`);
  return Buffer.from(res.body).toString("utf8");
}

/** Resolves once Pebble serves its directory; throws after `timeoutMs`. */
export async function waitForPebble(pebble: PebbleEnv, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const transport = httpsTransport({ ca: pebble.ca });
  for (;;) {
    try {
      const res = await transport.request(pebble.directory, { method: "GET" });
      if (res.status === 200) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`Pebble did not serve ${pebble.directory} within ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Publish a TXT record in challtestsrv. `host` without the trailing dot. */
export async function setTxt(pebble: PebbleEnv, host: string, value: string): Promise<void> {
  const res = await fetch(`${pebble.challtestsrv}/set-txt`, { method: "POST", body: JSON.stringify({ host: `${host}.`, value }) });
  if (!res.ok) throw new Error(`challtestsrv set-txt: ${res.status}`);
}

export async function clearTxt(pebble: PebbleEnv, host: string): Promise<void> {
  const res = await fetch(`${pebble.challtestsrv}/clear-txt`, { method: "POST", body: JSON.stringify({ host: `${host}.` }) });
  if (!res.ok) throw new Error(`challtestsrv clear-txt: ${res.status}`);
}

/** Have Pebble answer `ariResponse`, as sent, for `certificatePem`'s renewal information from now on. */
export async function setRenewalInfo(pebble: PebbleEnv, certificatePem: string, ariResponse: unknown): Promise<void> {
  const res = await httpsTransport({ ca: pebble.ca }).request(`${pebble.management}/set-renewal-info/`, {
    method: "POST",
    body: JSON.stringify({ Certificate: certificatePem, ARIResponse: JSON.stringify(ariResponse) }),
    headers: { "content-type": "application/json" },
  });
  if (res.status !== 200) throw new Error(`pebble set-renewal-info: ${res.status} ${Buffer.from(res.body).toString("utf8")}`);
}
