// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ConnectorStatus, RemoteAccessStatus, RemoteError } from "@stuga/protocol/api/remote-access";
import { shortDate } from "../../../lib/format";
import { mountInto, typeInto } from "../../../test/form-input";

const nodeApi = vi.hoisted(() => ({
  getRemoteAccess: vi.fn(),
  enableRemoteAccess: vi.fn(),
  disableRemoteAccess: vi.fn(),
  retryRemoteConnector: vi.fn(),
}));

vi.mock("../../../api", async (orig) => ({
  ...(await orig<typeof import("../../../api")>()),
  NodeSettings: nodeApi,
}));

const { RemoteAccessSection } = await import("./RemoteAccessSection");

const DAY = 86_400_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

const ADDRESS = "https://k7f3q2.remote.example";
const CONFIG = "/Users/liv/.stuga-remote/relay-1.toml";

type Available = Extract<RemoteAccessStatus, { available: true }>;

const OFF: Available = {
  available: true,
  enabled: false,
  state: "off",
  address: null,
  certificate: null,
  credential: null,
  connector: null,
  ca_terms: null,
  last_error: null,
};

const ON: Available = {
  ...OFF,
  enabled: true,
  state: "on",
  address: ADDRESS,
  certificate: { expires_at: at(80 * DAY), renew_at: at(50 * DAY) },
  credential: { expires_at: at(DAY) },
  connector: { managed: false, status: null, config_path: CONFIG, config_changed_at: at(-2 * DAY), reachable: true, checked_at: at(-60_000) },
  ca_terms: { accepted_by: "liv", accepted_at: at(-2 * DAY), url: "https://letsencrypt.org/documents/LE-SA-v1.8.pdf" },
};

/** Bound once, now off: the address and the account stay. */
const OFF_BOUND: Available = { ...ON, enabled: false, state: "off" };

const STARTING: Available = { ...ON, state: "starting", certificate: null, credential: null, connector: null };

const SHA = "3f".repeat(32);
const helper = (state: ConnectorStatus["state"], message = ""): ConnectorStatus => ({
  state,
  message,
  at: at(-30_000),
  connector_sha: "c".repeat(64),
  config_sha: SHA,
});

/** On, where the packaging runs the connector. */
const MANAGED: Available = { ...ON, connector: { ...ON.connector!, managed: true, config_path: null, status: helper("running") } };

const problem = (code: RemoteError["code"], message: string, extra: Partial<RemoteError> = {}): RemoteError => ({
  code,
  message,
  at: at(-60_000),
  ...extra,
});

let host: HTMLDivElement;

const text = () => host.textContent ?? "";
/** The page's own buttons, not the ones in the kept-mounted confirmation. */
const buttons = (label: string) => [...host.querySelectorAll("button")].filter((b) => b.textContent === label && !b.closest("dialog"));
const isDisabled = (b: HTMLButtonElement | undefined) => !!b && (b.disabled || b.getAttribute("aria-disabled") === "true");

function field(labelText: string): HTMLInputElement | undefined {
  return [...host.querySelectorAll("input")].find((i) => (host.querySelector(`label[for="${i.id}"]`)?.textContent ?? "").startsWith(labelText));
}

const checkbox = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]');

async function click(el: Element | undefined | null) {
  expect(el, "nothing to click").toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function mount(status: RemoteAccessStatus) {
  nodeApi.getRemoteAccess.mockResolvedValue(status);
  const page = mountInto();
  host = page.host;
  await act(async () => page.root.render(<RemoteAccessSection />));
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("RemoteAccessSection", () => {
  it("says remote access isn't here when the packaging offers none", async () => {
    await mount({ available: false });
    expect(text()).toBe("Remote access isn’t available on this node.");
  });

  it("turns on with a code and the certificate authority's agreement, and not before both", async () => {
    nodeApi.enableRemoteAccess.mockResolvedValue(STARTING);
    await mount(OFF);
    expect(text()).toContain("Reach this node from anywhere at its own address.");
    const link = [...host.querySelectorAll("a")].find((a) => a.textContent?.includes("Let’s Encrypt Subscriber Agreement"));
    expect(link?.getAttribute("href")).toBe("https://letsencrypt.org/repository/");

    expect(isDisabled(buttons("Turn on")[0])).toBe(true);
    await typeInto(field("Code"), " 7K2M-9QXD-4TZB-H8PN ");
    // A code alone is not enough: the agreement is accepted here, or nowhere.
    expect(isDisabled(buttons("Turn on")[0])).toBe(true);
    await click(checkbox());
    expect(isDisabled(buttons("Turn on")[0])).toBe(false);
    await click(checkbox());
    expect(isDisabled(buttons("Turn on")[0])).toBe(true);
    await click(checkbox());

    await click(buttons("Turn on")[0]);
    await settle();
    expect(nodeApi.enableRemoteAccess).toHaveBeenCalledWith({ code: "7K2M-9QXD-4TZB-H8PN", accept_ca_terms: true });
    expect(text()).toContain(ADDRESS);
    expect(text()).toContain("Getting a certificate…");
  });

  it("shows a refused code under the code field", async () => {
    nodeApi.enableRemoteAccess.mockRejectedValue(new Error("That code has already been used."));
    await mount(OFF);
    await typeInto(field("Code"), "7K2M-9QXD-4TZB-H8PN");
    await click(checkbox());
    await click(buttons("Turn on")[0]);
    await settle();
    expect(field("Code")!.getAttribute("aria-invalid")).toBe("true");
    expect(text()).toContain("That code has already been used.");
    expect(text()).not.toContain("That didn’t work");
  });

  it("turns a bound node back on without a code, or with a different one", async () => {
    nodeApi.enableRemoteAccess.mockResolvedValue(ON);
    await mount(OFF_BOUND);
    expect(text()).toContain(ADDRESS);
    // The agreement the node's account took, once it has one.
    const link = [...host.querySelectorAll("a")].find((a) => a.textContent?.includes("Subscriber Agreement"));
    expect(link?.getAttribute("href")).toBe("https://letsencrypt.org/documents/LE-SA-v1.8.pdf");
    await click(checkbox());
    await click(buttons("Turn on")[0]);
    await settle();
    expect(nodeApi.enableRemoteAccess).toHaveBeenLastCalledWith({ accept_ca_terms: true });
  });

  it("links to the CA's own page for terms that are not an https link", async () => {
    await mount({ ...OFF_BOUND, ca_terms: { ...ON.ca_terms!, url: "data:text/plain,Do%20what%20thou%20wilt" } });
    const link = [...host.querySelectorAll("a")].find((a) => a.textContent?.includes("Subscriber Agreement"));
    expect(link?.getAttribute("href")).toBe("https://letsencrypt.org/repository/");
  });

  it("sends a different code only once it is asked for", async () => {
    nodeApi.enableRemoteAccess.mockResolvedValue(ON);
    await mount(OFF_BOUND);
    await click(buttons("Use a different code")[0]);
    await typeInto(field("Code"), "3NVQ-8RKW-6HXD-2PMB");
    await click(checkbox());
    await click(buttons("Turn on")[0]);
    await settle();
    expect(nodeApi.enableRemoteAccess).toHaveBeenLastCalledWith({ code: "3NVQ-8RKW-6HXD-2PMB", accept_ca_terms: true });
  });

  it("says what a starting node waits on", async () => {
    await mount(STARTING);
    expect(text()).toContain("Getting a certificate…");

    await mount({ ...STARTING, certificate: ON.certificate });
    expect(text()).toContain("Connecting to the relay…");

    await mount({ ...STARTING, certificate: ON.certificate, credential: ON.credential, connector: ON.connector });
    expect(text()).toContain("Checking the address…");
    expect(text()).toContain(`frpc -c ${CONFIG}`);
  });

  it("shows the address, the renewal and the connector's command while on, and turns off after asking", async () => {
    nodeApi.disableRemoteAccess.mockResolvedValue(OFF_BOUND);
    await mount(ON);
    expect(text()).toContain(ADDRESS);
    expect(buttons("Copy")).toHaveLength(1);
    expect(text()).toContain(`Certificate renews ${shortDate(ON.certificate!.renew_at!)}.`);
    expect(text()).toContain("Run the connector on this machine:");
    expect(text()).toContain(`frpc -c ${CONFIG}`);
    // Which address to hand out, how people sign in there, and that the node's own stays on its network.
    expect(text()).toContain(`Share ${ADDRESS}. Sign in there with a passkey or a password of 15 characters or more.`);
    expect(text()).toContain("on your network. The remote address is the one to share.");

    await click(buttons("Turn off")[0]);
    expect(nodeApi.disableRemoteAccess).not.toHaveBeenCalled();
    await click([...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "Turn off"));
    await settle();
    expect(nodeApi.disableRemoteAccess).toHaveBeenCalledTimes(1);
    expect(buttons("Turn on")).toHaveLength(1);
  });

  it("quotes a connector path the shell would split", async () => {
    await mount({ ...ON, connector: { ...ON.connector!, config_path: "/Users/liv/My Stuga/relay-1.toml" } });
    expect(text()).toContain("frpc -c '/Users/liv/My Stuga/relay-1.toml'");
  });

  it("warns what is wrong while the address still runs, and when the node tries again", async () => {
    await mount({
      ...ON,
      state: "degraded",
      last_error: problem("connector_unreachable", "couldn't reach it", { retry_at: at(10 * 60_000) }),
    });
    expect(text()).toContain("The address doesn’t reach this node. Check that the connector is running.");
    expect(text()).toContain("Next try ");
    expect(text()).toContain(ADDRESS);
    expect(buttons("Turn off")).toHaveLength(1);
  });

  it("says another computer is using the address, and what to do", async () => {
    await mount({ ...ON, state: "degraded", last_error: problem("wrong_certificate", "k7f3q2.remote.example answered with a certificate that is not this node's") });
    expect(text()).toContain("Another computer is using this address. Turn off remote access on the one you no longer use.");
    expect(text()).not.toContain("certificate that");
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(buttons("Turn off")).toHaveLength(1);
  });

  it("says a denied address is off, with the service's own words", async () => {
    await mount({ ...ON, state: "denied", last_error: problem("denied", "This address was reported for abuse.", { reason: "abuse" }) });
    expect(text()).toContain("Remote access is off for this address.");
    expect(text()).toContain("This address was reported for abuse.");
    expect(buttons("Turn off")).toHaveLength(1);
    expect(text()).not.toContain("frpc");
  });

  it("asks for a restore code when the service no longer takes the node's key", async () => {
    nodeApi.enableRemoteAccess.mockResolvedValue(STARTING);
    await mount({ ...ON, state: "error", last_error: problem("binding_rejected", "no longer accepted") });
    expect(text()).toContain(
      "The remote access service no longer accepts this node’s key. Enter a restore code to keep this address.",
    );
    await typeInto(field("Code"), "3NVQ-8RKW-6HXD-2PMB");
    await click(checkbox());
    await click(buttons("Turn on")[0]);
    await settle();
    expect(nodeApi.enableRemoteAccess).toHaveBeenCalledWith({ code: "3NVQ-8RKW-6HXD-2PMB", accept_ca_terms: true });
  });

  it("says the address moved to another computer, and turns on again only with a code", async () => {
    nodeApi.enableRemoteAccess.mockResolvedValue(STARTING);
    await mount({ ...OFF, last_error: problem("moved", "This address moved to another computer.", { service_code: "node_moved" }) });
    expect(text()).toContain("This address moved to another computer.");
    expect(text()).not.toContain("restore code");
    expect(buttons("Use a different code")).toHaveLength(0);
    await click(checkbox());
    expect(isDisabled(buttons("Turn on")[0])).toBe(true);
    await typeInto(field("Code"), "3NVQ-8RKW-6HXD-2PMB");
    await click(buttons("Turn on")[0]);
    await settle();
    expect(nodeApi.enableRemoteAccess).toHaveBeenCalledWith({ code: "3NVQ-8RKW-6HXD-2PMB", accept_ca_terms: true });
    expect(text()).not.toContain("moved to another computer");
    expect(text()).toContain("Getting a certificate…");
  });

  it("names what an administrator or a newer Stuga must fix", async () => {
    await mount({ ...ON, state: "error", last_error: problem("upgrade_required", "Update Stuga to use remote access.") });
    expect(text()).toContain("Update Stuga to use remote access.");
    expect(field("Code")).toBeUndefined();

    await mount({ ...ON, state: "error", last_error: problem("acme_action_required", "Accept the new terms at the CA.") });
    expect(text()).toContain("The certificate authority needs attention: Accept the new terms at the CA.");

    const dir = "/Users/liv/.stuga-remote can't be used for remote access: other users can write to it";
    await mount({ ...ON, state: "error", last_error: problem("remote_dir_unusable", dir) });
    expect(text()).toContain(dir);
  });

  it("points out the connector's new settings once this browser has seen earlier ones", async () => {
    await mount(ON);
    // The first settings seen here are the ones the connector starts with.
    expect(text()).not.toContain("Its settings changed");

    const changedAt = at(-60_000);
    await mount({ ...ON, connector: { ...ON.connector!, config_changed_at: changedAt } });
    expect(text()).toContain("Its settings changed at");
    expect(text()).toContain("Restart it if it was already running.");
    await click(host.querySelector('button[aria-label="Dismiss"]'));

    await mount({ ...ON, connector: { ...ON.connector!, config_changed_at: changedAt } });
    expect(text()).not.toContain("Its settings changed");
  });

  describe("where the packaging runs the connector", () => {
    it("shows how the connector stands, and no command or restart to do by hand", async () => {
      // Settings that changed since this browser saw them would be pointed out where someone runs the connector.
      localStorage.setItem("stuga:remote-access:connector-seen", at(-3 * DAY));
      await mount(MANAGED);
      expect(text()).toContain(ADDRESS);
      expect(text()).toContain("Connector: Running");
      expect(text()).not.toContain("frpc");
      expect(text()).not.toContain("Run the connector");
      expect(text()).not.toContain("Restart it");

      await mount({ ...MANAGED, connector: { ...MANAGED.connector!, status: helper("stopped") } });
      expect(text()).toContain("Connector: Stopped");
    });

    it("says it is installing the connector while a starting node waits on it", async () => {
      await mount({
        ...STARTING,
        certificate: ON.certificate,
        credential: ON.credential,
        connector: { ...MANAGED.connector!, reachable: false, status: helper("installing") },
      });
      expect(text()).toContain("Installing the connector…");
      expect(text()).not.toContain("frpc");
    });

    it("gives the connector's state while starting, unless it is installing", async () => {
      const starting = (connectorStatus: ConnectorStatus | null): Available => ({
        ...STARTING,
        certificate: ON.certificate,
        credential: ON.credential,
        connector: { ...MANAGED.connector!, reachable: false, status: connectorStatus },
      });
      await mount(starting(helper("unavailable")));
      expect(text()).toContain("Checking the address…");
      expect(text()).toContain("Connector: Not included in this installation");

      await mount(starting(helper("stopped")));
      expect(text()).toContain("Connector: Stopped");

      await mount(starting(helper("refused", "The connector's signature isn't Stuga's.")));
      expect(text()).toContain("Connector: The connector's signature isn't Stuga's.");

      await mount(starting(helper("installing")));
      expect(text()).toContain("Installing the connector…");
      expect(text()).not.toContain("Connector: ");

      await mount(starting(null));
      expect(text()).not.toContain("Connector: ");
    });

    it("says so when the installation has no connector, with nothing to retry", async () => {
      const message = "This installation doesn't include the connector.";
      await mount({
        ...MANAGED,
        state: "error",
        connector: { ...MANAGED.connector!, status: helper("unavailable", message) },
        last_error: problem("connector_unavailable", message),
      });
      expect(text()).toContain(message);
      expect(buttons("Retry")).toHaveLength(0);
      expect(buttons("Turn off")).toHaveLength(1);
    });

    it("doesn't ask whether the connector is running when the packaging runs it", async () => {
      await mount({ ...MANAGED, state: "degraded", last_error: problem("connector_unreachable", "couldn't reach it") });
      expect(text()).toContain("The connector is starting or can’t reach the relay.");
      expect(text()).not.toContain("Check that the connector is running");
    });

    it("gives the packaging's reason for a failure, and when the node asks again", async () => {
      await mount({
        ...MANAGED,
        state: "degraded",
        connector: { ...MANAGED.connector!, status: helper("failed", "Couldn't download the connector.") },
        last_error: problem("connector_failed", "Couldn't download the connector.", { retry_at: at(5 * 60_000) }),
      });
      expect(text()).toContain("The connector couldn’t start.");
      // The reason once, on the connector's line.
      expect(text()).toContain("Connector: Couldn't download the connector.");
      expect(text().split("Couldn't download the connector.")).toHaveLength(2);
      expect(text()).toContain("Next try ");
    });

    it("retries a refused connector when asked, and turns off beside it", async () => {
      const refused: Available = {
        ...MANAGED,
        state: "error",
        connector: { ...MANAGED.connector!, status: helper("refused", "The connector's signature isn't Stuga's.") },
        last_error: problem("connector_refused", "The connector's signature isn't Stuga's."),
      };
      nodeApi.retryRemoteConnector.mockResolvedValue({ ...MANAGED, state: "starting", connector: { ...MANAGED.connector!, status: helper("installing") } });
      await mount(refused);
      expect(text()).toContain("The connector didn’t pass its checks, so it isn’t running.");
      expect(text()).toContain("The connector's signature isn't Stuga's.");
      expect(buttons("Turn off")).toHaveLength(1);
      await click(buttons("Retry")[0]);
      await settle();
      expect(nodeApi.retryRemoteConnector).toHaveBeenCalledTimes(1);
      expect(text()).not.toContain("didn’t pass its checks");
      expect(buttons("Retry")).toHaveLength(0);
    });
  });

  it("says when the certificate expired, in place of when it renews", async () => {
    const expiredAt = at(-2 * DAY);
    await mount({
      ...ON,
      state: "degraded",
      certificate: { expires_at: expiredAt, renew_at: at(-10 * DAY) },
      last_error: problem("certificate_expired", "The certificate expired.", { at: expiredAt }),
    });
    expect(text()).toContain(`Certificate expired ${shortDate(expiredAt)}.`);
    expect(text()).not.toContain("Certificate renews");
    expect(text()).toContain("The certificate expired. The node is getting a new one.");
  });
});
