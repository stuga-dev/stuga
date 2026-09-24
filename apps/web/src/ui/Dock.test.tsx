// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Dock, availableTabs, dockOpen, dockToggle, pruneDockState, readDockState, type DockController } from "./Dock";
import { COMPACT_QUERY } from "./narrow";

const ALL = ["ai", "comments", "versions", "sources"] as const;
type Id = (typeof ALL)[number];

const FIRST_VISIT = { active: "ai" as Id, visible: true, previous: null };

describe("availableTabs", () => {
  it("keeps the declared order and withholds slots whose condition fails", () => {
    expect(availableTabs<Id>([{ id: "comments" }, { id: "ai", when: false }, { id: "sources", when: true }])).toEqual(["comments", "sources"]);
  });
});

describe("readDockState", () => {
  it("gives the first-visit state with nothing stored, with garbage, or with an unknown panel in front", () => {
    expect(readDockState(null, ALL, FIRST_VISIT)).toBe(FIRST_VISIT);
    expect(readDockState("{not json", ALL, FIRST_VISIT)).toBe(FIRST_VISIT);
    expect(readDockState("5", ALL, FIRST_VISIT)).toBe(FIRST_VISIT);
    expect(readDockState(JSON.stringify({ active: "bogus", visible: true }), ALL, FIRST_VISIT)).toBe(FIRST_VISIT);
  });

  it("reads what was stored, dropping an unknown previous panel", () => {
    expect(readDockState(JSON.stringify({ active: "comments", visible: true, previous: "ai" }), ALL, FIRST_VISIT)).toEqual({
      active: "comments",
      visible: true,
      previous: "ai",
    });
    expect(readDockState(JSON.stringify({ active: "comments", visible: true, previous: "bogus" }), ALL, FIRST_VISIT).previous).toBeNull();
  });

  it("keeps a hidden dock hidden, and shows only on a stored true", () => {
    expect(readDockState(JSON.stringify({ active: "ai", visible: false }), ALL, FIRST_VISIT).visible).toBe(false);
    expect(readDockState(JSON.stringify({ active: "ai", visible: "yes" }), ALL, FIRST_VISIT).visible).toBe(false);
  });
});

describe("transitions", () => {
  it("open brings a panel to the front of a visible dock and remembers the one it replaced", () => {
    const s = dockOpen(FIRST_VISIT, "comments");
    expect(s).toEqual({ active: "comments", visible: true, previous: "ai" });
    expect(dockOpen(s, "versions")).toEqual({ active: "versions", visible: true, previous: "comments" });
  });

  it("open shows a hidden dock with nothing to go back to", () => {
    const hidden = { active: "comments" as Id, visible: false, previous: "ai" as Id };
    expect(dockOpen(hidden, "sources")).toEqual({ active: "sources", visible: true, previous: null });
    expect(dockOpen(hidden, "comments")).toEqual({ active: "comments", visible: true, previous: null });
  });

  it("opening the panel already in front changes nothing", () => {
    const s = { active: "comments" as Id, visible: true, previous: "ai" as Id };
    expect(dockOpen(s, "comments")).toBe(s);
  });

  it("toggle hides and re-shows with the same panel in front", () => {
    const shown = { active: "versions" as Id, visible: true, previous: "ai" as Id };
    const hidden = dockToggle(shown);
    expect(hidden).toEqual({ ...shown, visible: false });
    expect(dockToggle(hidden)).toEqual(shown);
  });

  it("toggle cannot show a dock with no panel", () => {
    expect(dockToggle({ active: null, visible: false, previous: null }).visible).toBe(false);
  });
});

describe("pruneDockState", () => {
  type DbId = "ai" | "activity" | "row";

  it("returns the same object while the panel in front is available, so memoised consumers don't churn", () => {
    const s = { active: "row" as DbId, visible: true, previous: "ai" as DbId };
    expect(pruneDockState(s, ["ai", "activity", "row"])).toBe(s);
  });

  it("goes back to the panel the withheld one replaced, e.g. when the open row closes", () => {
    const s = { active: "row" as DbId, visible: true, previous: "ai" as DbId };
    expect(pruneDockState(s, ["ai", "activity"])).toEqual({ active: "ai", visible: true, previous: null });
  });

  it("hides a dock that came up for the withheld panel, keeping a panel to show next time", () => {
    const cameUpForRow = { active: "row" as DbId, visible: true, previous: null };
    expect(pruneDockState(cameUpForRow, ["ai", "activity"])).toEqual({ active: "ai", visible: false, previous: null });
    // The first visit to a read-only item: the dock does not open by itself for another panel.
    expect(pruneDockState({ active: "ai" as DbId, visible: true, previous: null }, ["activity"])).toEqual({
      active: "activity",
      visible: false,
      previous: null,
    });
  });

  it("hides when the replaced panel is withheld too", () => {
    const s = { active: "ai" as DbId, visible: true, previous: "row" as DbId };
    expect(pruneDockState(s, ["activity"])).toEqual({ active: "activity", visible: false, previous: null });
  });

  it("leaves a hidden dock hidden", () => {
    const s = { active: "row" as DbId, visible: false, previous: "ai" as DbId };
    expect(pruneDockState(s, ["ai", "activity"])).toEqual({ active: "ai", visible: false, previous: null });
  });

  it("has no panel in front when the page offers none", () => {
    expect(pruneDockState({ active: "ai" as DbId, visible: true, previous: null }, [])).toEqual({ active: null, visible: false, previous: null });
  });
});

describe("Dock", () => {
  let compact = false;
  let host: HTMLDivElement;
  let root: Root;

  const dock: DockController<Id> = {
    state: { active: "comments", visible: true, previous: null },
    available: ["comments"],
    open: () => {},
    toggle: () => {},
  };

  async function mount(onResize?: (next: number) => void) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <Dock dock={dock} width={360} onResize={onResize} tabs={[{ id: "comments", label: "Comments", icon: null, render: () => <p>Panel</p> }]} />,
      ),
    );
  }

  const handle = () => host.querySelector('[role="separator"][aria-label="Resize side panels"]');
  const aside = () => host.querySelector<HTMLElement>("aside.dock")!;

  beforeEach(() => {
    const real = window.matchMedia;
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ ...real(query), matches: query === COMPACT_QUERY && compact }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    compact = false;
  });

  it("sits beside the page at its width, with the resize handle just before it", async () => {
    await mount(() => {});
    expect(aside().style.width).toBe("360px");
    expect(handle()?.nextElementSibling).toBe(aside());
  });

  it("keeps its width but draws no handle when it cannot be resized", async () => {
    await mount();
    expect(aside().style.width).toBe("360px");
    expect(handle()).toBeNull();
  });

  it("leaves its width to the stylesheet and draws no handle in a compact window", async () => {
    compact = true;
    await mount(() => {});
    expect(aside().style.width).toBe("");
    expect(handle()).toBeNull();
  });
});
