// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { toasts } from "../test/toast";
import { mountInto } from "../test/form-input";

const uploadWithProgress = vi.hoisted(() => vi.fn());
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Media: { uploadWithProgress } }));
vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));

const { FilesCell } = await import("./FilesCell");

const link = (hash: string, name: string) => `/api/docs/db1/media/${hash.repeat(64)}/${encodeURIComponent(name)}`;
const BRIEF = link("a", "Q3 brief.pdf");
const CHART = link("b", "chart.png");

let host: HTMLDivElement;
let root: Root;
const onChange = vi.fn();

async function render(value: string | null, readOnly = false) {
  await act(async () => root.render(<FilesCell databaseId="db1" label="Files" value={value} readOnly={readOnly} onChange={onChange} />));
}

beforeEach(() => {
  vi.clearAllMocks();
  toasts.shown = [];
  ({ host, root } = mountInto());
});

describe("a files cell", () => {
  it("downloads a file under its name, previews an image, and removes one with an Undo", async () => {
    await render(`${BRIEF}\n${CHART}`);
    const links = [...host.querySelectorAll("a")];
    expect(links.map((a) => [a.getAttribute("href"), a.getAttribute("download"), a.textContent])).toEqual([
      [BRIEF, "Q3 brief.pdf", "Q3 brief.pdf"],
      [CHART, null, "chart.png"],
    ]);
    await act(async () => links[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(host.ownerDocument.querySelector('img[alt="chart.png"]')).toBeTruthy();

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Remove Q3 brief.pdf"]')!.click());
    expect(onChange).toHaveBeenCalledWith(CHART);
    expect(toasts.shown.map((t) => t.body)).toEqual(["Removed Q3 brief.pdf."]);

    // Undo puts it back in its place, once the cell holds the removal.
    await render(CHART);
    const undo = (toasts.shown[0] as unknown as { endContent: { props: { onClick: () => void } } }).endContent.props.onClick;
    act(() => undo());
    expect(onChange).toHaveBeenLastCalledWith(`${BRIEF}\n${CHART}`);
  });

  it("shows an empty cell's add button as a hint", async () => {
    await render(null);
    expect(host.querySelector(".db-files--empty .db-files__add")).toBeTruthy();
  });

  it("uploads picked files into the database and adds their links; a failed one is named", async () => {
    uploadWithProgress.mockImplementation(async (_db: string, file: File) => {
      if (file.name === "bad.bin") throw new Error("file too large (max 10 MB)");
      return { url: CHART, hash: "b".repeat(64) };
    });
    await render(BRIEF);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const files = [new File(["x"], "chart.png", { type: "image/png" }), new File(["y"], "bad.bin")];
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(uploadWithProgress.mock.calls.map(([db, file]) => [db, (file as File).name])).toEqual([
      ["db1", "chart.png"],
      ["db1", "bad.bin"],
    ]);
    expect(onChange).toHaveBeenCalledWith(`${BRIEF}\n${CHART}`);
    expect(toasts.shown.map((t) => t.body)).toEqual(["file too large (max 10 MB)"]);
  });

  it("offers neither adding nor removing to a reader", async () => {
    await render(BRIEF, true);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(host.querySelector('input[type="file"]')).toBeNull();
  });
});
