// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { AuditCursor, AuditEvent, AuditFacets, AuditFilters } from "../../api";
import { mountInto } from "../../test/form-input";
import { toastBodies, toasts } from "../../test/toast";

const audit = vi.hoisted(() => ({ list: vi.fn(), facets: vi.fn(), export: vi.fn() }));
const users = vi.hoisted(() => ({ resolve: vi.fn() }));
const navigations = vi.hoisted(() => ({ to: [] as string[] }));

vi.mock("../../api", async (orig) => ({
  ...(await orig<typeof import("../../api")>()),
  Audit: audit,
  Users: users,
}));

vi.mock("@astryxdesign/core/Toast", () => import("../../test/toast"));

vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => (to: string) => navigations.to.push(to),
}));

const { AuditLog } = await import("./AuditLog");

function row(over: Partial<AuditEvent> & { id: number }): AuditEvent {
  return {
    request_id: `req_${over.id}`,
    at: "2026-09-05T10:00:00.000Z",
    workspace_id: "ws_1",
    actor: "u_liv",
    actor_kind: "human",
    on_behalf_of: null,
    source: "web",
    action: "doc.recover",
    target_kind: null,
    target_id: null,
    target_label: null,
    status: "ok",
    detail: {},
    ...over,
  };
}

/** The co-author acting for a person no other loaded row names. */
const COAUTHOR = row({
  id: 4,
  actor: "panel:u_L6AV0888JmPTgqR_",
  actor_kind: "agent",
  on_behalf_of: "u_L6AV0888JmPTgqR_",
  action: "doc.propose",
  target_kind: "doc",
  target_id: "d_1",
  target_label: "Quarterly plan",
  detail: { mode: "auto_applied" },
});

/** A connector acting for a person who also has rows of their own. */
const MCP = row({
  id: 3,
  at: "2026-09-05T09:30:00.000Z",
  actor: "agent:claude-connector",
  actor_kind: "agent",
  on_behalf_of: "u_liv",
  source: "mcp",
  action: "mcp.doc.update",
  target_kind: "doc",
  target_id: "d_3",
  target_label: "Launch checklist",
});

/** A person's row whose title a spreadsheet would execute as a formula. */
const HUMAN = row({
  id: 2,
  at: "2026-09-05T09:00:00.000Z",
  action: "acl.set",
  target_kind: "doc",
  target_id: "d_2",
  target_label: "=cmd budget",
});

/** A refusal to an agent acting on its own authority. */
const DENIED = row({
  id: 1,
  at: "2026-09-05T08:00:00.000Z",
  actor: "agent:ci",
  actor_kind: "agent",
  source: "api-key",
  action: "access.denied",
  target_kind: "route",
  target_id: "/api/docs/d_9",
  status: "denied",
  detail: { method: "POST", http_status: 403 },
});

const PAGE = [COAUTHOR, MCP, HUMAN, DENIED];

/** `database.mutate` records the database's doc id. */
const DATABASE = row({
  id: 7,
  action: "database.mutate",
  target_kind: "database",
  target_id: "db_1",
  target_label: "Sales pipeline",
  detail: { summary: "3 rows updated" },
});

const OLDER = [
  row({
    id: 0,
    at: "2026-09-04T08:00:00.000Z",
    action: "key.mint",
    target_kind: "api_key",
    target_id: "k_7",
    target_label: "deploy bot",
  }),
];

/** Knows `u_sam`, whom only the facets mention, and Zoe as a directory row with an email and no username. */
const DIRECTORY = [
  { alias: "u_liv", username: "liv", display_name: "Liv", email: "liv@example.com" },
  { alias: "u_sam", username: "sam", display_name: "Sam", email: "sam@example.com" },
  { alias: "u_L6AV0888JmPTgqR_", username: "ada", display_name: "Ada", email: "ada@example.com" },
  { alias: "u_zoe", username: null, display_name: "Zoe", email: "zoe@example.com" },
  { alias: "u_liv_m", username: "liv.m", display_name: "Liv", email: null },
];

const FACETS: AuditFacets = {
  // Grouped by COALESCE(on_behalf_of, actor).
  principals: [
    { value: "u_liv", count: 2, last_at: MCP.at },
    { value: "u_L6AV0888JmPTgqR_", count: 1, last_at: COAUTHOR.at },
    { value: "agent:ci", count: 1, last_at: DENIED.at },
    { value: "u_sam", count: 9, last_at: "2026-08-30T08:00:00.000Z" },
  ],
  // Grouped by actor over agent rows.
  agents: [
    { value: "panel:u_L6AV0888JmPTgqR_", count: 1, last_at: COAUTHOR.at },
    { value: "agent:claude-connector", count: 1, last_at: MCP.at },
    { value: "agent:ci", count: 1, last_at: DENIED.at },
  ],
  actions: [
    { value: "doc.propose", count: 1, last_at: COAUTHOR.at },
    { value: "mcp.doc.update", count: 1, last_at: MCP.at },
    { value: "acl.set", count: 1, last_at: HUMAN.at },
    { value: "access.denied", count: 1, last_at: DENIED.at },
  ],
  statuses: [
    { value: "ok", count: 3, last_at: COAUTHOR.at },
    { value: "denied", count: 1, last_at: DENIED.at },
  ],
  truncated: false,
};

// jsdom has no object URLs; creates and revokes are recorded.
const objectUrls = { created: [] as Blob[], revoked: [] as string[] };
URL.createObjectURL = ((blob: Blob) => {
  objectUrls.created.push(blob);
  return `blob:stuga/${objectUrls.created.length}`;
}) as typeof URL.createObjectURL;
URL.revokeObjectURL = ((url: string) => {
  objectUrls.revoked.push(url);
}) as typeof URL.revokeObjectURL;

let container: HTMLDivElement;
let root: Root;

/** Only the table: the menus keep their options mounted. */
const tableText = () => document.querySelector("table")?.textContent ?? "";
const bodyRows = () => [...document.querySelectorAll("table tbody tr")];
const button = (re: RegExp) => [...document.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""));
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** Located through the header: the expansion plugin adds a column of its own. */
function whoCell(i: number): HTMLElement {
  const heads = [...document.querySelectorAll("table thead th")];
  const col = heads.findIndex((h) => h.textContent === "Who");
  expect(col, "the table has no Who column").toBeGreaterThanOrEqual(0);
  const cell = bodyRows()[i]!.querySelectorAll("td")[col];
  expect(cell, `row ${i} has no cell under Who`).toBeTruthy();
  return cell as HTMLElement;
}

/** Every menu's options stay in the DOM, so the option is found in the listbox this combobox controls. */
async function choose(labelText: string, optionText: RegExp): Promise<void> {
  const label = [...document.querySelectorAll("label")].find((l) => l.textContent === labelText);
  expect(label, `no selector labelled ${labelText}`).toBeTruthy();
  const trigger = document.getElementById(label!.getAttribute("for")!)!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  const option = [...listbox.querySelectorAll('[role="option"]')].find((o) => optionText.test(o.textContent ?? ""));
  expect(option, `no option matching ${optionText} under ${labelText}`).toBeTruthy();
  await act(async () => {
    option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function menuOptions(labelText: string): Promise<string[]> {
  const label = [...document.querySelectorAll("label")].find((l) => l.textContent === labelText);
  expect(label, `no selector labelled ${labelText}`).toBeTruthy();
  const trigger = document.getElementById(label!.getAttribute("for")!)!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const listbox = document.getElementById(trigger.getAttribute("aria-controls")!)!;
  return [...listbox.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? "");
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function LocationProbe() {
  return <span data-probe="location">{useLocation().search}</span>;
}
const locationSearch = () => document.querySelector('[data-probe="location"]')?.textContent ?? "";

const AUDIT = "/settings/workspace/audit";

async function renderAt(root: Root, path: string): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AuditLog />
        <LocationProbe />
      </MemoryRouter>,
    );
  });
  await settle();
}

/** Mount this test's page, over the mocks as they stand. */
async function mount(path = AUDIT): Promise<void> {
  ({ host: container, root } = mountInto());
  await renderAt(root, path);
}

/** Mount again over the current mocks. */
async function remount(): Promise<void> {
  act(() => root.unmount());
  container.remove();
  await mount();
}

/** One page over the default fixture for every case in the describe: they only read it. */
function shareOnePage(): void {
  let page: { host: HTMLDivElement; root: Root };
  beforeAll(async () => {
    arrange();
    const host = document.body.appendChild(document.createElement("div"));
    page = { host, root: createRoot(host) };
    await renderAt(page.root, AUDIT);
  });
  afterAll(() => {
    act(() => page.root.unmount());
    page.host.remove();
  });
}

const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

function arrange(): void {
  audit.list.mockImplementation(async (filters: AuditFilters = {}) => {
    if (filters.before_at) return { events: OLDER, next_before: null };
    const events = filters.status ? PAGE.filter((e) => e.status === filters.status) : PAGE;
    const last = events[events.length - 1];
    return { events, next_before: last ? { at: last.at, id: last.id } : null };
  });
  audit.facets.mockResolvedValue(FACETS);
  audit.export.mockResolvedValue({ blob: new Blob(["id,at\r\n"]), filename: "stuga-audit-2026-09-05.csv" });
  users.resolve.mockImplementation(async (ids: string[]) => ({
    users: DIRECTORY.filter((u) => ids.includes(u.alias)),
  }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  // Drain a previous case's deferred revoke before resetting the record.
  await new Promise((r) => setTimeout(r, 0));
  objectUrls.created = [];
  objectUrls.revoked = [];
  arrange();
  toasts.shown = [];
  navigations.to = [];
});

describe("AuditLog — who acted", () => {
  describe("on the default page", () => {
    shareOnePage();

    it("prints the minted alias nowhere in the table's text", () => {
      expect(tableText()).not.toContain("panel:");
      expect(tableText()).not.toContain("u_L6AV0888JmPTgqR_");
      // Still one hover away.
      expect(bodyRows()[0]!.innerHTML).toContain('title="panel:u_L6AV0888JmPTgqR_"');
    });

    it("names the person a connector acted for, with the connector under them", () => {
      const cell = whoCell(1).textContent ?? "";
      expect(cell.startsWith("Liv")).toBe(true);
      expect(cell).toContain("via claude-connector");
      expect(occurrences(cell, "Liv")).toBe(1);
      expect(cell).not.toContain("agent");
      expect(bodyRows()[1]!.innerHTML).toContain('title="agent:claude-connector"');
    });

    it("keeps an agent that acted for nobody as the subject of its own row", () => {
      const cell = whoCell(3).textContent ?? "";
      expect(cell).toContain("ci");
      expect(cell).toContain("agent");
      expect(cell).not.toContain("via");
    });

    it("names a human actor from the directory", () => {
      expect(whoCell(2).textContent ?? "").toContain("Liv");
      expect(tableText()).not.toContain("u_liv");
    });

    it("puts no handle beside an agent or the co-author under a person", () => {
      expect(whoCell(0).textContent).toBe("Ada@adavia AI co-author");
      expect(whoCell(3).textContent).not.toContain("@");
    });
  });

  it("tells apart two people of one name by their handles, in the table and the Who menu", async () => {
    audit.list.mockResolvedValue({ events: [HUMAN, row({ id: 9, actor: "u_liv_m" })], next_before: null });
    audit.facets.mockResolvedValue({
      ...FACETS,
      principals: [
        { value: "u_liv", count: 2, last_at: MCP.at },
        { value: "u_liv_m", count: 1, last_at: HUMAN.at },
      ],
    });
    await mount();
    await settle();
    expect(whoCell(0).textContent).toBe("Liv@liv");
    expect(whoCell(1).textContent).toBe("Liv@liv.m");
    const who = (await menuOptions("Who")).join("|");
    expect(who).toContain("Liv @liv (2)");
    expect(who).toContain("Liv @liv.m (1)");
  });

  it("falls back to the email for an account with no username", async () => {
    audit.list.mockResolvedValue({ events: [row({ id: 9, actor: "u_zoe" })], next_before: null });
    await mount();
    await settle();
    expect(whoCell(0).textContent).toBe("Zoezoe@example.com");
  });
});

describe("AuditLog — what happened", () => {
  shareOnePage();

  it("reads an auto-applied proposal as applied, not proposed", () => {
    const cell = bodyRows()[0]!.textContent ?? "";
    expect(cell).toContain("Edit applied at once");
    expect(cell).not.toContain("Edit proposed");
  });

  it("keeps the raw action code reachable beside the label", () => {
    expect(bodyRows()[2]!.innerHTML).toContain('title="acl.set"');
    expect(bodyRows()[2]!.textContent).toContain("Sharing changed");
  });

  it("shows the target's recorded name with its id underneath", () => {
    const cell = bodyRows()[0]!.textContent ?? "";
    expect(cell).toContain("Quarterly plan");
    expect(cell).toContain("d_1");
  });
});

describe("AuditLog — refusals", () => {
  it("marks a denied row so it reads as refused without being opened", async () => {
    await mount();
    expect(bodyRows()[3]!.textContent ?? "").toContain("Refused");
    expect(bodyRows()[2]!.textContent ?? "").not.toContain("Refused");
  });

  it("narrows the table to refusals through the Result filter", async () => {
    await mount();
    await choose("Result", /Refused only/);
    expect(audit.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: "denied" }));
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]!.textContent ?? "").toContain("Request refused");
  });
});

describe("AuditLog — paging", () => {
  it("asks for the page below the last row and appends what comes back", async () => {
    await mount();
    expect(bodyRows()).toHaveLength(PAGE.length);
    await act(async () => {
      button(/Load older/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(audit.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ before_at: DENIED.at, before_id: DENIED.id }),
    );
    expect(bodyRows()).toHaveLength(PAGE.length + OLDER.length);
    expect(bodyRows()[0]!.textContent ?? "").toContain("AI co-author");
    expect(bodyRows()[4]!.textContent ?? "").toContain("deploy bot");
  });

  it("says what is loaded rather than letting the table pass for the whole ledger", async () => {
    await mount();
    expect(document.body.textContent).toContain("There may be older ones");
    await act(async () => {
      button(/Load older/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(button(/Load older/)).toBeUndefined();
    expect(document.body.textContent).toContain("Nothing older in this window matches");
  });
});

describe("AuditLog — the detail panel", () => {
  it("opens a row onto both clocks and the raw alias the table hides", async () => {
    await mount();
    const chevron = bodyRows()[0]!.querySelector("button");
    expect(chevron, "the expansion plugin renders no toggle").toBeTruthy();
    await act(async () => {
      chevron!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const panel = document.querySelector("table tbody")!.textContent ?? "";
    expect(panel).toContain("panel:u_L6AV0888JmPTgqR_");
    expect(panel).toContain("2026-09-05T10:00:00.000Z");
    expect(panel).toContain("When (UTC, as exported)");
    expect(panel).toContain("req_4");
    expect(panel).toContain("Accountable");
    expect(panel).toContain("Ada @ada");
    expect(panel).toContain("On behalf of");
  });
});

describe("AuditLog — a query the reader has left", () => {
  it("discards an older page that answers the previous filters", async () => {
    await mount();
    // Hold the older page open so the filter change lands while it is in flight.
    let land!: (page: { events: AuditEvent[]; next_before: AuditCursor | null }) => void;
    audit.list.mockImplementation(async (filters: AuditFilters = {}) => {
      if (filters.before_at) {
        return new Promise<{ events: AuditEvent[]; next_before: AuditCursor | null }>((r) => {
          land = r;
        });
      }
      const events = filters.status ? PAGE.filter((e) => e.status === filters.status) : PAGE;
      const last = events[events.length - 1];
      return { events, next_before: last ? { at: last.at, id: last.id } : null };
    });

    await act(async () => {
      button(/Load older/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await choose("Result", /Refused only/);
    await settle();
    expect(bodyRows()).toHaveLength(1);

    await act(async () => {
      land({ events: OLDER, next_before: null });
    });
    await settle();
    expect(bodyRows()).toHaveLength(1);
    expect(tableText()).not.toContain("deploy bot");
    // Nor its cursor.
    expect(button(/Load older/)).toBeTruthy();
  });

  it("discards a first page that answers filters the reader has already left", async () => {
    await mount();
    let land!: (page: { events: AuditEvent[]; next_before: AuditCursor | null }) => void;
    audit.list.mockImplementationOnce(
      async () =>
        new Promise<{ events: AuditEvent[]; next_before: AuditCursor | null }>((r) => {
          land = r;
        }),
    );
    await choose("When", /All time/);
    await choose("Result", /Refused only/);
    await settle();
    expect(bodyRows()).toHaveLength(1);

    await act(async () => {
      land({ events: PAGE, next_before: null });
    });
    await settle();
    expect(bodyRows()).toHaveLength(1);
    expect(tableText()).not.toContain("AI co-author");
    expect(button(/Load older/)).toBeTruthy();
  });
});

describe("AuditLog — the two axes", () => {
  it("builds each menu from its own axis, and puts nothing on both", async () => {
    await mount();
    await settle();
    await settle();
    const who = (await menuOptions("Who")).join("|");
    const agentOptions = await menuOptions("Agent");
    const agent = agentOptions.join("|");
    expect(who).toContain("Liv @liv (2)");
    expect(who).toContain("Ada @ada (1)");
    // Named, though only the facets know Sam.
    expect(who).toContain("Sam @sam (9)");
    expect(who).not.toContain("u_sam");
    expect(who).not.toContain("AI co-author");
    expect(who).not.toContain("claude-connector");
    expect(agent).toContain("claude-connector (1)");
    expect(agent).toContain("AI co-author");
    // Each co-author under its own person.
    expect(agentOptions.some((o) => o.startsWith("AI co-author · Ada"))).toBe(true);
    expect(agent).not.toContain("Liv (2)");
    expect(agent).not.toContain("Sam");
  });

  it("reads the person out of a co-author's alias when no other axis names them", async () => {
    // Zoe appears only inside her co-author's alias on the agents axis.
    audit.facets.mockResolvedValue({
      ...FACETS,
      principals: FACETS.principals.filter((f) => f.value !== "u_sam"),
      agents: [...FACETS.agents, { value: "panel:u_zoe", count: 4, last_at: DENIED.at }],
      truncated: true,
    });
    await mount();
    await settle();
    await settle();
    expect((await menuOptions("Agent")).some((o) => o.startsWith("AI co-author · Zoe"))).toBe(true);
  });

  it("filters by the person, so what their agents did arrives with their own", async () => {
    await mount();
    await choose("Who", /^Liv/);
    expect(audit.list).toHaveBeenLastCalledWith(expect.objectContaining({ principal: "u_liv" }));
    expect(audit.list.mock.lastCall![0].actor).toBeUndefined();
  });

  it("filters by the instrument, which is how one key's reach is scoped", async () => {
    await mount();
    await choose("Agent", /claude-connector/);
    expect(audit.list).toHaveBeenLastCalledWith(expect.objectContaining({ actor: "agent:claude-connector" }));
    expect(audit.list.mock.lastCall![0].principal).toBeUndefined();
  });

  it("keeps the Agent menu selectable once a person is chosen, and sends both", async () => {
    await mount();
    await choose("Who", /^Liv/);
    expect((await menuOptions("Agent")).join("|")).toContain("claude-connector");
    await choose("Agent", /claude-connector/);
    expect(audit.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ principal: "u_liv", actor: "agent:claude-connector" }),
    );
  });

  it("falls back to what the loaded rows carry when the facets call fails", async () => {
    audit.facets.mockRejectedValue(new Error("facets"));
    await mount();
    await settle();
    const who = (await menuOptions("Who")).join("|");
    expect(who).toContain("Ada");
    expect(who).toContain("Liv");
    expect(who).not.toContain("Sam");
    const agent = (await menuOptions("Agent")).join("|");
    expect(agent).toContain("claude-connector");
    expect(agent).toContain("AI co-author");
    expect(agent).not.toContain("Liv");
  });

  it("says the menus are a subset when the server cut an axis short", async () => {
    await mount();
    expect(document.body.textContent).not.toContain("most frequent values");
    audit.facets.mockResolvedValue({ ...FACETS, truncated: true });
    await remount();
    expect(document.body.textContent).toContain("Menus show only the most frequent values in this range.");
  });
});

describe("AuditLog — an action that fails", () => {
  it("leaves the ledger on screen when the export fails", async () => {
    await mount();
    audit.export.mockRejectedValue(new Error("The export timed out."));
    await act(async () => {
      button(/Export (all|matches)/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(bodyRows()).toHaveLength(PAGE.length);
    expect(document.body.textContent).not.toContain("Couldn’t load the audit log");
    expect(toastBodies()).toContain("The export timed out.");
  });

  it("leaves the ledger on screen when an older page fails to arrive", async () => {
    await mount();
    audit.list.mockImplementationOnce(async () => {
      throw new Error("network");
    });
    await act(async () => {
      button(/Load older/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(bodyRows()).toHaveLength(PAGE.length);
    expect(document.body.textContent).not.toContain("Couldn’t load the audit log");
    expect(toastBodies()).toContain("Couldn’t load older events.");
    expect(button(/Load older/)).toBeTruthy();
  });
});

describe("AuditLog — what the export button ships", () => {
  it("ships the person filter, so a file named for one reader holds that reader's rows", async () => {
    await mount();
    await choose("Who", /^Liv/);
    await act(async () => {
      button(/Export matches/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(audit.export).toHaveBeenLastCalledWith(expect.objectContaining({ principal: "u_liv" }), "csv");
  });

  it("ships the reader's other filters the same way", async () => {
    await mount();
    await choose("Result", /Refused only/);
    await act(async () => {
      button(/Export matches/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(audit.export).toHaveBeenLastCalledWith(expect.objectContaining({ status: "denied" }), "csv");
  });

  it("ships no filter at all once every one of them is cleared, which is how it exports everything", async () => {
    await mount();
    await choose("When", /All time/);
    await act(async () => {
      button(/Export matches/)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();
    expect(audit.export).toHaveBeenLastCalledWith(
      expect.objectContaining({ principal: undefined, actor: undefined, action: undefined, status: undefined, since: undefined }),
      "csv",
    );
  });
});

describe("AuditLog — the target cell", () => {
  it("opens a database target, which is a docs row behind the same route", async () => {
    audit.list.mockResolvedValue({ events: [DATABASE, ...OLDER], next_before: null });
    await mount();
    const target = [...bodyRows()[0]!.querySelectorAll("button")].find((b) => b.textContent === "Sales pipeline");
    expect(target, "the database target is not a link").toBeTruthy();
    await act(async () => {
      target!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigations.to).toEqual(["/doc/db_1"]);
    // And an api_key target stays text: there is no page it could open.
    expect([...bodyRows()[1]!.querySelectorAll("button")].some((b) => b.textContent === "deploy bot")).toBe(false);
  });
});

describe("AuditLog — the filters in the URL", () => {
  it("reads its filters from the address, so a link is a view", async () => {
    await mount("/settings/workspace/audit?status=denied&principal=u_liv&actor=agent%3Aci&action=access.denied");
    expect(audit.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "denied", principal: "u_liv", actor: "agent:ci", action: "access.denied" }),
    );
  });

  it("writes a change back to the address, and drops a control that is back at its default", async () => {
    await mount();
    await choose("Result", /Refused only/);
    expect(locationSearch()).toContain("status=denied");
    await choose("When", /All time/);
    expect(locationSearch()).toContain("range=all");
    await choose("When", /Last 7 days/);
    expect(locationSearch()).not.toContain("range=");
    await choose("Result", /All results/);
    expect(locationSearch()).not.toContain("status=");
  });

  it("opens the default view on a range it does not offer", async () => {
    await mount("/settings/workspace/audit?range=fortnight");
    const sent = audit.list.mock.calls.at(-1)![0] as AuditFilters;
    const sevenDays = 7 * 86_400_000;
    expect(Date.now() - Date.parse(sent.since!)).toBeGreaterThan(sevenDays - 60_000);
    expect(Date.now() - Date.parse(sent.since!)).toBeLessThan(sevenDays + 60_000);
  });
});

describe("AuditLog — one target", () => {
  it("narrows to a target from the id under its name, says so, and lets it go", async () => {
    await mount();
    const idLink = [...document.querySelectorAll("table a, table button")].find((el) => el.textContent === "d_2");
    expect(idLink, "the id under a target's name is not a link").toBeTruthy();
    await click(idLink!);
    await settle();
    expect(audit.list).toHaveBeenLastCalledWith(expect.objectContaining({ targetKind: "doc", targetId: "d_2" }));
    expect(locationSearch()).toContain("target_id=d_2");
    expect(document.body.textContent).toContain("Only this target");
    expect(document.body.textContent).toContain("=cmd budget");
    const remove = [...document.querySelectorAll("button")].find((b) => /remove/i.test(b.getAttribute("aria-label") ?? ""));
    expect(remove, "the target chip has no remove button").toBeTruthy();
    await click(remove!);
    await settle();
    expect(locationSearch()).not.toContain("target_id");
    expect(audit.list).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: undefined }));
  });

  it("narrows from the detail panel too, which is where a row with no recorded name has to do it", async () => {
    await mount();
    // DENIED names its target by id alone, so its cell carries no second line.
    const chevron = bodyRows()[3]!.querySelector("button")!;
    await click(chevron);
    const only = button(/Show only this target/);
    expect(only).toBeTruthy();
    await click(only!);
    await settle();
    expect(audit.list).toHaveBeenLastCalledWith(expect.objectContaining({ targetKind: "route", targetId: "/api/docs/d_9" }));
  });

  it("arrives with the target set, and names it once the page puts a name to it", async () => {
    await mount("/settings/workspace/audit?target_kind=doc&target_id=d_1");
    expect(audit.list).toHaveBeenLastCalledWith(expect.objectContaining({ targetKind: "doc", targetId: "d_1" }));
    expect(document.body.textContent).toContain("Quarterly plan");
    expect(button(/Export matches/)).toBeTruthy();
    await click(button(/Export matches/)!);
    expect(audit.export).toHaveBeenCalledWith(expect.objectContaining({ targetKind: "doc", targetId: "d_1" }), "csv");
  });
});

describe("AuditLog — a custom range", () => {
  it("takes the reader's own days, the last one included", async () => {
    await mount("/settings/workspace/audit?range=custom&from=2026-09-01&to=2026-09-05");
    const since = new Date(2026, 8, 1).toISOString();
    const until = new Date(2026, 8, 6).toISOString();
    expect(audit.list).toHaveBeenLastCalledWith(expect.objectContaining({ since, until }));
    expect(audit.facets).toHaveBeenLastCalledWith({ since, until });
    expect(document.body.textContent).toContain("Between");
  });

  it("drops the days when the reader leaves the custom range", async () => {
    await mount("/settings/workspace/audit?range=custom&from=2026-09-01&to=2026-09-05");
    await choose("When", /Last 30 days/);
    expect(locationSearch()).not.toContain("from=");
    expect(locationSearch()).not.toContain("to=");
    expect(document.body.textContent).not.toContain("Between");
  });

  it("offers the picker on choosing the custom range, before any day is picked", async () => {
    await mount();
    await choose("When", /Custom range/);
    expect(locationSearch()).toContain("range=custom");
    expect(document.body.textContent).toContain("Between");
    // No days yet: no bound is sent.
    expect(audit.list).toHaveBeenLastCalledWith(expect.objectContaining({ since: undefined, until: undefined }));
    expect(button(/Export matches/)).toBeTruthy();
  });
});

describe("AuditLog — a filter change in flight", () => {
  it("keeps the rows on screen while the new page is on its way, and says it is updating", async () => {
    await mount();
    let release!: (v: { events: AuditEvent[]; next_before: AuditCursor | null }) => void;
    audit.list.mockImplementationOnce(() => new Promise((r) => (release = r)));
    await choose("Result", /Refused only/);
    expect(bodyRows()).toHaveLength(PAGE.length);
    expect(document.body.textContent).toContain("Updating");
    expect(document.body.textContent).not.toContain("events loaded");
    await act(async () => release({ events: [DENIED], next_before: null }));
    await settle();
    expect(bodyRows()).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Updating");
    expect(document.body.textContent).toContain("1 events loaded");
  });

  it("leaves the ledger on screen when the new page fails to arrive", async () => {
    await mount();
    audit.list.mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 500 }));
    await choose("Result", /Refused only/);
    await settle();
    expect(bodyRows()).toHaveLength(PAGE.length);
    expect(toastBodies()).toEqual([expect.stringMatching(/previous ones/)]);
  });

  it("closes the page when the server refuses a later page: the role that loaded the rows is gone", async () => {
    await mount();
    audit.list.mockRejectedValueOnce(Object.assign(new Error("no"), { status: 403 }));
    await choose("Result", /Refused only/);
    await settle();
    expect(document.querySelector("table")).toBeNull();
    expect(document.body.textContent).toContain("You can't see this workspace's audit log");
  });
});
