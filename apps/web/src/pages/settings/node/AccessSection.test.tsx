// @vitest-environment jsdom
/** Account recovery's Revoke everything: what it takes, and the password link it hands back. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { mountInto } from "../../../test/form-input";

const nodeApi = vi.hoisted(() => ({
  admins: vi.fn(),
  users: vi.fn(),
  revokeEverythingCounts: vi.fn(),
  revokeEverythingFor: vi.fn(),
  mintPasswordReset: vi.fn(),
}));
vi.mock("../../../api", async (orig) => ({ ...(await orig<typeof import("../../../api")>()), NodeSettings: nodeApi }));
vi.mock("./NodeAudit", () => ({ NodeAudit: () => null }));
const me = vi.hoisted(() => ({ alias: null as string | null }));
vi.mock("../../../lib/http/client", async (orig) => ({
  ...(await orig<typeof import("../../../lib/http/client")>()),
  getAlias: () => me.alias,
}));

const { AccessSection, memberRevokeSummary } = await import("./AccessSection");
const { setAuthConfigForTest } = await import("../../../lib/session/auth-config");

const BO = { alias: "u_bo", username: "bo", display_name: "Bo" };
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

function Where() {
  return <p id="where">{useLocation().search}</p>;
}

beforeEach(() => {
  me.alias = null;
  for (const fn of Object.values(nodeApi)) fn.mockReset();
  nodeApi.admins.mockResolvedValue({ admins: [] });
  nodeApi.users.mockResolvedValue({ users: [BO, { alias: "u_bob", username: "bob", display_name: "Bob" }] });
  nodeApi.revokeEverythingCounts.mockResolvedValue({ sessions: 2, provider: true, apps: 1, api_keys: 0, invites: 0, share_links: 2 });
  nodeApi.revokeEverythingFor.mockResolvedValue({ password_link: { url: "http://livs-air.local:8787/reset/abc", expires_at: "2026-10-01T00:00:00Z" } });
  setAuthConfigForTest({ provider: { label: "Okta" } });
});

describe("Revoke everything for someone", () => {
  it("opens with the person an alert named, says what it takes, and hands back a password link", async () => {
    const { host, root } = mountInto();
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/settings/node/access?revoke=bo"]}>
          <Where />
          <Routes>
            <Route path="/settings/node/access" element={<AccessSection ops={null} onSaved={() => {}} />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    await settle();
    expect(nodeApi.users).toHaveBeenCalledWith("bo");
    expect(host.querySelector("#where")?.textContent).toBe("");

    const buttons = () => [...host.querySelectorAll("button")];
    const revoke = buttons().find((b) => b.textContent === "Revoke everything")!;
    await act(async () => revoke.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(nodeApi.revokeEverythingCounts).toHaveBeenCalledWith("u_bo");
    const dialog = host.ownerDocument.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Revoke everything for Bo?");
    expect(dialog.textContent).toContain(
      "Signs them out everywhere and removes their password, Okta sign-in, a connected app and 2 links they shared. You get a password link to send them.",
    );

    const confirm = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Revoke everything")!;
    await act(async () => confirm.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(nodeApi.revokeEverythingFor).toHaveBeenCalledWith("u_bo");
    expect(host.textContent).toContain("Password link for Bo");
    expect(host.textContent).toContain("http://livs-air.local:8787/reset/abc");
  });

  it("is not offered for yourself, whose Revoke everything takes a new password in Profile", async () => {
    me.alias = "u_bo";
    const { host, root } = mountInto();
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/settings/node/access?revoke=bo"]}>
          <Routes>
            <Route path="/settings/node/access" element={<AccessSection ops={null} onSaved={() => {}} />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    await settle();
    const revoke = [...host.querySelectorAll("button")].find((b) => b.textContent === "Revoke everything")!;
    expect(revoke.disabled || revoke.getAttribute("aria-disabled") === "true").toBe(true);
    await act(async () => revoke.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(nodeApi.revokeEverythingCounts).not.toHaveBeenCalled();
  });

  it("says only their password when there is nothing else to take", () => {
    expect(memberRevokeSummary({ sessions: 0, provider: false, apps: 0, api_keys: 1, invites: 0, share_links: 0 }, null)).toBe(
      "Signs them out everywhere and removes their password and an API key. You get a password link to send them.",
    );
    expect(memberRevokeSummary(null, null)).toBe("Signs them out everywhere and removes their password. You get a password link to send them.");
  });
});
