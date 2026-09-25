import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialFile, NodeSignIn } from "./sign-in.js";

const store = () => new CredentialFile(join(mkdtempSync(join(tmpdir(), "stuga-signin-")), "stuga", "oauth.json"));

describe("CredentialFile", () => {
  it("keeps each node's credentials apart, in a file only this user can read", () => {
    const file = store();
    file.update("http://a", () => ({ tokens: { access_token: "sto_a", token_type: "Bearer" } }));
    file.update("http://b", (c) => ({ ...c, client: { client_id: "cid_b" } }));
    expect(file.read("http://a").tokens?.access_token).toBe("sto_a");
    expect(file.read("http://b")).toEqual({ client: { client_id: "cid_b" } });
    expect(file.read("http://c")).toEqual({});
    expect(statSync((file as unknown as { path: string }).path).mode & 0o777).toBe(0o600);
  });
});

describe("NodeSignIn", () => {
  async function started() {
    const opened: string[] = [];
    const signIn = new NodeSignIn({ nodeUrl: "http://node", clientName: "Claude Desktop", store: store(), open: (u) => opened.push(u), log: () => {} });
    await signIn.listen();
    return { signIn, opened, back: (query: string) => fetch(`${signIn.redirectUrl}?${query}`) };
  }

  it("registers a loopback redirect on the port it listens on", async () => {
    const { signIn } = await started();
    expect(signIn.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(signIn.clientMetadata).toMatchObject({ client_name: "Claude Desktop", redirect_uris: [signIn.redirectUrl], token_endpoint_auth_method: "none" });
    signIn.close();
  });

  it("opens the browser, and takes the code only from the redirect it started", async () => {
    const { signIn, opened, back } = await started();
    signIn.redirectToAuthorization(new URL("http://node/oauth/authorize?x=1"));
    expect(opened).toEqual(["http://node/oauth/authorize?x=1"]);
    const state = signIn.state();
    const code = signIn.waitForCode(5_000);
    expect((await back("code=forged&state=wrong")).status).toBe(400);
    expect((await back(`code=abc&state=${state}`)).status).toBe(200);
    await expect(code).resolves.toBe("abc");
    // Used once.
    expect((await back(`code=again&state=${state}`)).status).toBe(400);
    signIn.close();
  });

  it("keeps a receiver for a sign-in the SDK started on its own, so an early answer is not lost", async () => {
    const { signIn, back } = await started();
    const state = signIn.state();
    signIn.redirectToAuthorization(new URL("http://node/oauth/authorize"));
    expect(signIn.inFlight).not.toBeNull();
    // The person approves before anything asked for the code; the reconnect that asks later still gets it.
    expect((await back(`code=early&state=${state}`)).status).toBe(200);
    await expect(signIn.waitForCode()).resolves.toBe("early");
    signIn.codeUsed();
    expect(signIn.inFlight).toBeNull();
    signIn.close();
  });

  it("refuses an answer that comes after the sign-in gave up", async () => {
    const { signIn, back } = await started();
    const state = signIn.state();
    await expect(signIn.waitForCode(10)).rejects.toThrow("not completed in time");
    expect((await back(`code=late&state=${state}`)).status).toBe(400);
    expect(signIn.inFlight).toBeNull();
    signIn.close();
  });

  it("gives up when the person says no", async () => {
    const { signIn, back } = await started();
    const state = signIn.state();
    const refused = expect(signIn.waitForCode(5_000)).rejects.toThrow("Access was not allowed.");
    await back(`error=access_denied&state=${state}`);
    await refused;
    signIn.close();
  });

  it("stores tokens and the registration, and forgets them when the node says they are no good", async () => {
    const { signIn } = await started();
    signIn.saveClientInformation({ client_id: "cid_1" });
    signIn.saveTokens({ access_token: "sto_1", token_type: "Bearer", refresh_token: "str_1" });
    expect(signIn.clientInformation()).toEqual({ client_id: "cid_1" });
    signIn.invalidateCredentials("tokens");
    expect(signIn.tokens()).toBeUndefined();
    expect(signIn.clientInformation()).toEqual({ client_id: "cid_1" });
    signIn.invalidateCredentials("all");
    expect(signIn.clientInformation()).toBeUndefined();
    expect(await signIn.validateResourceURL("http://127.0.0.1:8787/mcp", "http://livs-air.local:8787/mcp")).toEqual(new URL("http://livs-air.local:8787/mcp"));
    signIn.close();
  });
});
