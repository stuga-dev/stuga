// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_IMPORT_MAX_BYTES } from "@stuga/protocol/domain/workspaces";
import { chooseRadio, chooseSegment, mountInto, pickFile, typeInto } from "../test/form-input";

const samples = vi.hoisted(() => vi.fn());
const importHeld = vi.hoisted(() => vi.fn());
const discardImport = vi.hoisted(() => vi.fn());
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Workspaces: { samples, cachedSamples: () => undefined, importHeld, discardImport },
}));

const { CreateWorkspaceDialog } = await import("./CreateWorkspaceDialog");
const { ImportMayFinish } = await import("./StartWith");

const ARCHIVE = new File(["PK"], "Team handbook.stuga.zip", { type: "application/zip" });
const LAWS = { id: "privacy-laws", title: "Privacy laws", description: "Six laws in their own languages.", name: "Privacy laws (sample)", langs: ["en", "zh"] };

let root: Root;
/** Each element brought into view; jsdom has no scrollIntoView. */
let scrolled: Element[];
const onSubmit = vi.fn();
const onOpen = vi.fn();
const onClose = vi.fn();
const CREATED = { workspace_id: "w_2", name: "Team notes" };

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((b) => b.textContent === label);
const nameInput = () => document.querySelector<HTMLInputElement>('dialog input[type="text"], dialog input:not([type])')!;
const dialog = () => document.querySelector("dialog")!;

async function render(isOpen: boolean) {
  await act(async () => root.render(<CreateWorkspaceDialog isOpen={isOpen} onSubmit={onSubmit} onOpen={onOpen} onClose={onClose} />));
}

const typeName = (value: string) => typeInto(nameInput(), value);

async function click(label: string) {
  const target = button(label);
  expect(target, `no button ${label}`).toBeDefined();
  await act(async () => target!.click());
}

beforeEach(() => {
  onSubmit.mockReset().mockResolvedValue({ workspace: CREATED });
  importHeld.mockReset().mockResolvedValue(CREATED);
  discardImport.mockReset().mockResolvedValue(undefined);
  onOpen.mockReset();
  samples.mockReset().mockResolvedValue({ samples: [LAWS] });
  onClose.mockReset();
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  ({ root } = mountInto());
});

describe("CreateWorkspaceDialog", () => {
  it("creates an empty workspace by default, and opens it once it exists", async () => {
    await render(true);
    expect(dialog().querySelector('[role="radiogroup"][aria-label="Start with"] [aria-checked="true"]')?.textContent).toBe("Empty");
    expect(button("Create workspace")!.disabled).toBe(true);
    await typeName("  Team notes ");
    await click("Create workspace");
    expect(onSubmit).toHaveBeenCalledWith("Team notes", "workspace_edit", { kind: "empty" });
    expect(onOpen).toHaveBeenCalledWith(CREATED);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lists what a file would leave out and why, imports it only on Import, or goes back to the form", async () => {
    const files = [
      { path: "Notes/Brief.pdf", reason: "too_large", size: 13_002_342, limit: 10 * 1024 * 1024 },
      { path: "Board.canvas", reason: "not_linked" },
      { path: "Notes/Old/Scan.png", reason: "unreadable_image" },
    ];
    const held = { import_id: "wsi_1", name: "Notion", expires_at: "2026-09-28T01:00:00Z", left_out: { count: 12, files } };
    onSubmit.mockResolvedValue({ held });
    await render(true);
    await chooseSegment(dialog(), "Import");
    await pickFile(dialog(), ARCHIVE);
    await click("Create workspace");
    expect(onOpen).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("Import a workspace");
    expect(dialog().querySelector('.astryx-banner[data-status="warning"]')?.textContent).toContain("12 files won’t be imported");
    for (const text of ["Notes/Brief.pdf", "Too large: 12.4 MB (up to 10 MB per file)", "Not a page, and no page links to it", "Not a readable image", "and 9 more"]) {
      expect(dialog().textContent).toContain(text);
    }
    expect(dialog().textContent).not.toContain("Stuga holds");
    expect(button("Create workspace")).toBeUndefined();
    // The name can still be given here; left empty, the file's is taken.
    expect(nameInput().placeholder).toBe("Notion");

    await click("Back");
    expect(discardImport).toHaveBeenCalledWith("wsi_1");
    expect(button("Create workspace")).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();

    await click("Create workspace");
    await typeName("Notes");
    await click("Import");
    expect(importHeld).toHaveBeenCalledWith("wsi_1", "Notes", "workspace_edit");
    // An import ends with its summary; the workspace opens from there.
    expect(onOpen).not.toHaveBeenCalled();
    await click("Open workspace");
    expect(onOpen).toHaveBeenCalledWith(CREATED);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ends an import with what came in, what was left out and what changed on the way", async () => {
    const imported = {
      ...CREATED,
      name: "Vault",
      imported: { folders: 1, docs: 9, databases: 1, pages: 2, rows: 3, images: 2, files: 1, comments: 0 },
      left_out: { count: 1, files: [{ path: "Slides.key", reason: "not_linked" }] },
      changed: [
        { kind: "front_matter", count: 2, where: ["Home", "Plan"] },
        { kind: "unresolved_link", count: 7, where: ["A", "B", "C", "D", "E", "F", "G"] },
      ],
    };
    onSubmit.mockResolvedValue({ workspace: imported });
    await render(true);
    await chooseSegment(dialog(), "Import");
    await pickFile(dialog(), ARCHIVE);
    await click("Create workspace");
    const text = dialog().textContent;
    for (const part of [
      "Imported “Vault”",
      "9 documents, 1 database and 3 files came in.",
      "1 file left out",
      "Slides.key",
      "Front matter shown as a list under the title",
      "Home, Plan",
      "Links to pages the file doesn’t hold, kept as text",
      "A, B, C, D, E and 2 more",
    ]) {
      expect(text).toContain(part);
    }
    // Closing it opens the workspace, which exists by now.
    await act(async () => dialog().querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click());
    expect(onOpen).toHaveBeenCalledWith(imported);
  });

  it("creates from a chosen file, named as its archive is unless a name is typed, and waits for a file before it can", async () => {
    await render(true);
    await chooseSegment(dialog(), "Import");
    expect(button("Create workspace")!.disabled).toBe(true);
    expect(nameInput().placeholder).toBe("Taken from the file");
    expect(nameInput().required).toBe(false);
    await pickFile(dialog(), ARCHIVE);
    expect(nameInput().value).toBe("");
    await click("Create workspace");
    expect(onSubmit).toHaveBeenCalledWith("", "workspace_edit", { kind: "file", file: ARCHIVE });
  });

  it("refuses a file larger than an import takes before sending it", async () => {
    const huge = new File(["PK"], "Everything.zip", { type: "application/zip" });
    Object.defineProperty(huge, "size", { value: WORKSPACE_IMPORT_MAX_BYTES + 1 });
    await render(true);
    await chooseSegment(dialog(), "Import");
    await pickFile(dialog(), huge);
    expect(dialog().textContent).toContain("Everything.zip");
    expect(button("Create workspace")!.disabled).toBe(true);
  });

  it("asks for the samples as it opens, not while closed, and creates from a chosen one, named after it", async () => {
    await render(false);
    expect(samples).not.toHaveBeenCalled();
    await render(true);
    expect(samples).toHaveBeenCalledTimes(1);
    await chooseSegment(dialog(), "Sample");
    await chooseRadio(dialog(), "Privacy laws");
    expect(nameInput().value).toBe("Privacy laws (sample)");
    await click("Create workspace");
    expect(onSubmit).toHaveBeenCalledWith("Privacy laws (sample)", "workspace_edit", { kind: "sample", sample: LAWS });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open and busy while the workspace is made, with Cancel off, then says why it failed", async () => {
    let fail!: (err: Error) => void;
    onSubmit.mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
    await render(true);
    await typeName("Team notes");
    await click("Create workspace");
    const primary = [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find((b) => b.textContent?.includes("Create workspace"))!;
    expect(primary.disabled).toBe(true);
    expect(primary.getAttribute("aria-busy")).toBe("true");
    expect(button("Cancel")!.disabled).toBe(true);
    await click("Cancel");
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => fail(new Error("cannot import this archive: stuga.json: is missing")));
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("Couldn’t create the workspace");
    // Brought into view, since the dialog may be scrolled down to the file picker.
    expect(scrolled.filter((el) => el.textContent?.includes("Couldn’t create the workspace"))).toHaveLength(1);
    expect(dialog().textContent).toContain("cannot import this archive: stuga.json: is missing");
    expect(button("Cancel")!.disabled).toBe(false);
    expect(button("Create workspace")!.disabled).toBe(false);
  });

  it("says an import it stopped waiting for may still finish, not that it failed, and asks for no second", async () => {
    onSubmit.mockRejectedValue(new ImportMayFinish());
    await render(true);
    await chooseSegment(dialog(), "Sample");
    await chooseRadio(dialog(), "Privacy laws");
    await click("Create workspace");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(dialog().querySelector('.astryx-banner[data-status="info"]')?.textContent).toContain("The import may still finish");
    expect(dialog().textContent).toContain("The workspace switcher lists it once it does.");
    expect(dialog().textContent).not.toContain("Couldn’t create the workspace");
    expect(scrolled.filter((el) => el.textContent?.includes("The import may still finish"))).toHaveLength(1);
    expect(button("Create workspace")!.disabled).toBe(true);
    await act(async () => nameInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    await render(false);
    await render(true);
    expect(dialog().textContent).not.toContain("The import may still finish");
  });

  it("starts over when reopened", async () => {
    onSubmit.mockRejectedValue(new Error("offline"));
    await render(true);
    await chooseSegment(dialog(), "Import");
    await pickFile(dialog(), ARCHIVE);
    await click("Create workspace");
    expect(dialog().textContent).toContain("offline");

    await render(false);
    await render(true);
    expect(nameInput().value).toBe("");
    expect(dialog().textContent).not.toContain("offline");
    expect(dialog().querySelector('input[type="file"]')).toBeNull();
    expect(button("Create workspace")!.disabled).toBe(true);
  });
});
