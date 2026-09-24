import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { INSTALL_CLIENTS, installScript, getAgentInstaller, STUGA_SKILL, STUGA_SKILL_OPENAI } from "./install.js";
import { APP_ROUTES } from "../http/routes.js";
import { isAppPath } from "../http/dispatch.js";
import { matchRoute } from "../http/router.js";
import type { PublicCall } from "../http/router.js";

const NODE = { id: "ktbbpahhzxoldakw", name: "Liv’s Mac" };
const ORIGIN = "http://livs-air.local:8787";
const ACTIONS = ["install", "disconnect", "uninstall"] as const;

const call = (path: string): PublicCall =>
  ({
    env: {
      publicOrigin: ORIGIN,
      nodeId: NODE.id,
      settings: { current: () => ({ nodeLabel: NODE.name }) },
      // A handler that reached for the database would fail here: it must not.
      get sql(): never {
        throw new Error("the installer must not touch the database");
      },
    },
    url: new URL(`${ORIGIN}${path}`),
    match: matchRoute(APP_ROUTES, "GET", new URL(`${ORIGIN}${path}`).pathname)!.match,
  }) as unknown as PublicCall;

function shellCheck(script: string): void {
  const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
  expect(syntax.stderr).toBe("");
  expect(syntax.status).toBe(0);
}

describe("agent installer", () => {
  it.each(INSTALL_CLIENTS)("hands %s a script that carries no credential", (client) => {
    for (const action of ACTIONS) {
      const script = installScript(client, action, ORIGIN)!;
      // One name for every node, overridable by the rare person who holds two nodes in one client.
      expect(script).toContain('STUGA_SERVER="${STUGA_SERVER:-stuga}"');
      // A key, a bearer header or a token slot would mean the script grants access; OAuth does.
      expect(script).not.toMatch(/vk_|Bearer|STUGA_TOKEN|STUGA_API_KEY|Authorization/);
      shellCheck(script);
    }
  });

  it.each(INSTALL_CLIENTS)("sends %s to this node's /mcp and never through an npx bridge", (client) => {
    const script = installScript(client, "install", ORIGIN)!;
    expect(script).toContain("http://livs-air.local:8787/mcp");
    expect(script).not.toContain("mcp-remote");
    expect(script).not.toContain("npx");
  });

  it("lets adding the Codex server perform exactly one browser sign-in", () => {
    const script = installScript("codex", "install", ORIGIN)!;
    expect(script).toContain('codex mcp add "${STUGA_SERVER}" --url "${STUGA_MCP_URL}"');
    // Current Codex releases log in as part of `mcp add`; a second command mints an orphan connector.
    expect(script).not.toMatch(/^\s*codex mcp login "\$\{STUGA_SERVER\}"/m);
    expect(script).toContain('${HOME}/.agents/skills/stuga');
    expect(script).toContain("display_name");
    expect(script).toContain('codex mcp get "${STUGA_SERVER}" --json');
    expect(script).toContain("already names another MCP server");
  });

  it.each(INSTALL_CLIENTS)("clears %s's stored sign-in on removal, not just the server entry", (client) => {
    // A removal that leaves a usable credential on disk is not a removal, and it makes the
    // next install skip the sign-in and reuse a stale token.
    for (const action of ["disconnect", "uninstall"] as const) {
      const script = installScript(client, action, ORIGIN)!;
      expect(script).toMatch(/codex mcp logout|mcp_oauth_tokens\.json/);
    }
  });

  it("logs Codex out before removing the server, which is what clears the stored sign-in", () => {
    for (const action of ["disconnect", "uninstall"] as const) {
      const script = installScript("codex", action, ORIGIN)!;
      expect(script.indexOf("codex mcp logout")).toBeLessThan(script.indexOf("codex mcp remove"));
    }
  });

  it("gives Antigravity a serverUrl entry, the only remote shape it reads", () => {
    const script = installScript("antigravity", "install", ORIGIN)!;
    expect(script).toContain("serverUrl: url");
    expect(script).toContain('${HOME}/.gemini/config/skills/stuga');
    // The docs call ~/.gemini/antigravity/skills legacy; the shipped binary does not read it at all.
    expect(script).not.toContain("antigravity/skills");
    expect(script).toContain('STUGA_CONFIG="${HOME}/.gemini/config/mcp_config.json"');
    // Antigravity registers itself, so the entry holds a URL and nothing else.
    expect(script).not.toContain("clientId");
    expect(script).not.toContain("openai.yaml");
  });

  it("takes the skill away before the client entry, so a guarded refusal cannot leave it behind", () => {
    const script = installScript("antigravity", "uninstall", ORIGIN)!;
    expect(script).toContain('rm -rf "${STUGA_SKILL_DIR}"');
    expect(script.indexOf("rm -rf")).toBeLessThan(script.indexOf("command -v node"));
  });

  it.each(ACTIONS)("says on %s that local removal is not revocation", (action) => {
    const script = installScript("codex", action, ORIGIN)!;
    if (action === "install") expect(script).toContain("Setup complete");
    else expect(script).toContain("Local removal does not revoke access");
  });

  it("keeps the served skill identical to the checked-in integration", async () => {
    const dir = new URL("../../../../integrations/skills/stuga/", import.meta.url);
    expect(STUGA_SKILL).toBe(await readFile(new URL("SKILL.md", dir), "utf8"));
    expect(STUGA_SKILL_OPENAI).toBe(await readFile(new URL("agents/openai.yaml", dir), "utf8"));
  });
});

describe("GET /api/agent-install/:client", () => {
  it("serves a public, non-cached shell script without reading the database", async () => {
    // The path has to reach the app router before any route can answer it.
    expect(isAppPath("GET", "/api/agent-install/codex")).toBe(true);
    const route = matchRoute(APP_ROUTES, "GET", "/api/agent-install/codex")?.route;
    expect(route?.auth).toBe("none");
    const response = await getAgentInstaller(call("/api/agent-install/codex"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain('STUGA_SERVER="${STUGA_SERVER:-stuga}"');
  });

  it("reads the removal scripts off the same route", async () => {
    for (const action of ["disconnect", "uninstall"] as const) {
      const response = await getAgentInstaller(call(`/api/agent-install/antigravity?action=${action}`));
      expect(await response.text()).toContain("Local removal does not revoke access");
    }
  });

  it("ignores a key handed to it, since it has nothing to do with one", async () => {
    const response = await getAgentInstaller(call("/api/agent-install/codex?key=vk_live_1&token=vk_live_2"));
    expect(await response.text()).not.toContain("vk_live_");
  });

  it("does not serve a host it has no installer for", async () => {
    const response = await getAgentInstaller(call("/api/agent-install/claude-desktop"));
    expect(response.status).toBe(404);
  });
});
