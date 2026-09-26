// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

const HEADINGS = [
  { level: 1, text: "المقدمة" },
  { level: 3, text: "التعريفات" },
  { level: 3, text: "Definitions" },
];

/** The editor fields Outline reads; no `.doc-main` around it, so no section is tracked. */
const editor = {
  state: {
    doc: {
      descendants: (visit: (node: unknown, pos: number) => boolean) =>
        HEADINGS.forEach((h, i) => visit({ type: { name: "heading" }, attrs: { level: h.level }, textContent: h.text }, i * 10)),
    },
  },
  view: { dom: { closest: () => null } },
  on: () => {},
  off: () => {},
};

vi.mock("../editor/editor-context", () => ({ useSharedEditor: () => ({ editor, setEditor: () => {} }) }));

const { Outline } = await import("./Outline");

describe("Outline", () => {
  it("indents each heading from the side its text starts on", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(<Outline />));
    const rows = [...host.querySelectorAll<HTMLElement>(".outline-row")];
    expect(rows.map((r) => [r.textContent, r.dir, r.style.paddingInlineStart])).toEqual([
      ["المقدمة", "auto", "0rem"],
      ["التعريفات", "auto", "1.6rem"],
      ["Definitions", "auto", "1.6rem"],
    ]);
    act(() => root.unmount());
    host.remove();
  });
});
