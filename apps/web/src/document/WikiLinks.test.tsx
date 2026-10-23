// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { DocWikiLinks } from "@stuga/protocol/domain/wiki";
import { mountInto } from "../test/form-input";

const wiki = vi.hoisted(() => ({ links: vi.fn(), markChecked: vi.fn() }));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Wiki: wiki }));

const { LinkedFrom, NeedsCheckingBanner } = await import("./WikiLinks");
const { authorRefLabel } = await import("../wiki/names");
const { askedLine, outcomeLine, tableLine } = await import("../pages/WikiLogPage");

let host: HTMLDivElement;
let root: Root;

async function render(node: React.ReactNode): Promise<void> {
  await act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>));
}

const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

const LINKS: DocWikiLinks = {
  linked_from: [
    { doc_id: "d2", title: "Support", doc_type: "prose", kinds: ["citation", "link"], path: ["Policies"] },
    { doc_id: "d3", title: "Welcome", doc_type: "prose", kinds: ["link"], path: [] },
  ],
  linked_from_truncated: false,
  needs_checking: [{ doc_id: "d4", title: "Refund policy", changed_at: "2026-10-21T10:00:00.000Z" }],
  can_mark_checked: true,
};

beforeEach(() => {
  wiki.markChecked.mockReset();
  ({ host, root } = mountInto());
});

describe("Linked from", () => {
  it("lists each page that links here, how, and where it sits", async () => {
    await render(<LinkedFrom links={LINKS} />);
    expect(host.textContent).toContain("Linked from");
    expect(host.textContent).toContain("Support");
    expect(host.textContent).toContain("Links here and cites this page · Policies");
    expect(host.textContent).toContain("Welcome");
    expect(host.textContent).not.toContain("The first");
  });

  it("shows nothing when no page the reader opens links here", async () => {
    await render(<LinkedFrom links={{ ...LINKS, linked_from: [] }} />);
    expect(host.textContent).toBe("");
  });
});

describe("Needs checking", () => {
  it("names what changed, and offers Mark as checked to whoever may", async () => {
    const onChange = vi.fn();
    wiki.markChecked.mockResolvedValue({ ...LINKS, needs_checking: [], can_mark_checked: false, marked: 1 });
    await render(<NeedsCheckingBanner docId="d1" links={LINKS} onChange={onChange} />);
    expect(host.textContent).toContain("Needs checking");
    expect(host.textContent).toContain("A page it cites changed after it was approved:");
    expect(host.textContent).toContain("Refund policy");
    await act(async () => button("Mark as checked")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(wiki.markChecked).toHaveBeenCalledWith("d1");
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ needs_checking: [] }));
  });

  it("tells a reader who may not mark it, without the button, and shows nothing when nothing changed", async () => {
    await render(<NeedsCheckingBanner docId="d1" links={{ ...LINKS, can_mark_checked: false }} onChange={() => {}} />);
    expect(host.textContent).toContain("Refund policy");
    expect(button("Mark as checked")).toBeUndefined();
    await render(<NeedsCheckingBanner docId="d1" links={{ ...LINKS, needs_checking: [] }} onChange={() => {}} />);
    expect(host.textContent).toBe("");
  });
});

describe("the wiki's names", () => {
  it("names an agent and a co-author by the person they worked for", () => {
    expect(authorRefLabel({ kind: "person", name: "Sam" })).toBe("Sam");
    expect(authorRefLabel({ kind: "agent", name: "Liv" })).toBe("Liv’s agent");
    expect(authorRefLabel({ kind: "coauthor", name: "Liv" })).toBe("AI co-author · Liv");
  });

  it("says who decided an entry of the Log, and who asked through which AI", () => {
    expect(outcomeLine({ outcome: "approved", decided_by: [{ kind: "person", name: "Sam" }] })).toBe("Approved by Sam");
    expect(outcomeLine({ outcome: "applied", decided_by: [] })).toBe("Applied directly");
    expect(outcomeLine({ outcome: "partly", decided_by: [{ kind: "person", name: "Sam" }, { kind: "person", name: "Liv" }] })).toBe(
      "Partly approved by Sam, Liv",
    );
    expect(
      askedLine({ asked_by: { kind: "person", name: "Liv" }, agent: { name: "Claude", alias: "agent-1", client: "claude-code", source: "connector" } }),
    ).toBe("Asked by Liv through Claude");
  });

  it("names the rows a change touched in a table, and counts the rest", () => {
    expect(tableLine({ table: "Customers", rows: ["Initech", "Hooli"], count: 2 })).toBe("Customers: Initech, Hooli");
    expect(tableLine({ table: "Customers", rows: ["Initech"], count: 4 })).toBe("Customers: Initech and 3 more rows");
    expect(tableLine({ table: "Customers", rows: [], count: 1 })).toBe("Customers: 1 row");
  });
});
