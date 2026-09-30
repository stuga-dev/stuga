// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaces = vi.hoisted(() => ({
  create: vi.fn(),
  createFromSample: vi.fn(),
  checkImport: vi.fn(),
  importHeld: vi.fn(),
  samples: vi.fn(),
  samplesAgain: vi.fn(),
  cachedSamples: vi.fn(),
}));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Workspaces: workspaces }));

const { SAMPLES_RECHECK_MS, StartWith, createWorkspaceFrom, importHeldFile, landingPath, useNewWorkspace, useWorkspaceSamples } = await import("./StartWith");
import { chooseRadio, chooseSegment, mountInto, pickFile, typeInto } from "../test/form-input";
import type { Creation } from "./StartWith";

const ARCHIVE = new File(["PK"], "Team handbook.stuga.zip", { type: "application/zip" });
const PYTHON = { id: "python-specs", title: "Python specs", description: "Specs and a release plan.", name: "Python specs (sample)", langs: ["en"] };
const LAWS = { id: "privacy-laws", title: "Privacy laws", description: "Six laws in their own languages.", name: "Privacy laws (sample)", langs: ["en", "zh"] };

let host: HTMLDivElement;
let root: Root;

/** StartWith with the name beside it, as the dialog and the onboarding page hold them. */
function Harness({ isOpen = true }: { isOpen?: boolean }) {
  const { name, setName, start, setStart, ready, nameOptional } = useNewWorkspace();
  const samples = useWorkspaceSamples(isOpen);
  const picked = start.kind === "file" ? (start.file?.name ?? null) : start.kind === "sample" ? (start.sample?.id ?? null) : null;
  return (
    <>
      <input aria-label="name" value={name} onChange={(e) => setName(e.target.value)} />
      <output data-testid="state">{JSON.stringify({ name, kind: start.kind, picked, ready, nameOptional })}</output>
      <StartWith value={start} onChange={setStart} samples={samples} />
    </>
  );
}

const state = () =>
  JSON.parse(host.querySelector('[data-testid="state"]')!.textContent!) as { name: string; kind: string; picked: string | null; ready: boolean; nameOptional: boolean };
const segments = () => [...host.querySelectorAll('button[role="radio"]')].map((b) => b.textContent);
/** The samples offered: the radios below the segments. */
const labels = () => [...host.querySelectorAll('input[type="radio"]')].map((r) => document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent);

const typeName = (value: string) => typeInto(host.querySelector<HTMLInputElement>('input[aria-label="name"]'), value);

beforeEach(() => {
  workspaces.create.mockReset();
  workspaces.createFromSample.mockReset();
  workspaces.checkImport.mockReset().mockResolvedValue({ import_id: "wsi_1", name: "Team handbook", expires_at: "2026-09-28T01:00:00Z" });
  workspaces.importHeld.mockReset();
  workspaces.samples.mockReset().mockResolvedValue({ samples: [] });
  workspaces.samplesAgain.mockReset().mockResolvedValue({ samples: [] });
  workspaces.cachedSamples.mockReset().mockReturnValue(undefined);
  ({ host, root } = mountInto());
});

describe("Start with", () => {
  it("offers an empty workspace, a sample or a file, and shows the file picker only for a file", async () => {
    await act(async () => root.render(<Harness />));
    expect(segments()).toEqual(["Empty", "Sample", "Import"]);
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(state()).toMatchObject({ kind: "empty", ready: false });

    await chooseSegment(host, "Import");
    expect(host.querySelector<HTMLInputElement>('input[type="file"]')?.accept).toBe(".zip,application/zip");
    expect(host.textContent).toContain("Choose a Notion export, a zipped Obsidian vault or Markdown folder, or a .stuga.zip");
    expect(state()).toMatchObject({ kind: "file", picked: null, ready: false });
    await chooseSegment(host, "Empty");
    expect(host.querySelector('input[type="file"]')).toBeNull();
  });

  it("leaves a file's workspace the name its archive carries, unless a name was typed", async () => {
    await act(async () => root.render(<Harness />));
    await chooseSegment(host, "Import");
    expect(state()).toEqual({ name: "", kind: "file", picked: null, ready: false, nameOptional: true });
    // Not the file's name, which a browser's " (1)" or a dropped character can change.
    await pickFile(host, new File(["PK"], "Team handbook.stuga (1).zip", { type: "application/zip" }));
    expect(state()).toEqual({ name: "", kind: "file", picked: "Team handbook.stuga (1).zip", ready: true, nameOptional: true });

    await typeName("Handbook");
    await pickFile(host, ARCHIVE);
    expect(state()).toMatchObject({ name: "Handbook", picked: "Team handbook.stuga.zip", ready: true });
    await chooseSegment(host, "Empty");
    expect(state()).toMatchObject({ name: "Handbook", kind: "empty", ready: true, nameOptional: false });
  });

  it("lists the node's samples only under Sample, each with its line, the first one chosen", async () => {
    workspaces.samples.mockResolvedValue({ samples: [PYTHON, LAWS] });
    await act(async () => root.render(<Harness />));
    expect(labels()).toEqual([]);
    expect(host.textContent).not.toContain("Six laws in their own languages.");
    await chooseSegment(host, "Sample");
    expect(labels()).toEqual(["Python specs", "Privacy laws"]);
    expect(host.textContent).toContain("Six laws in their own languages.");
    expect(state()).toEqual({ name: "Python specs (sample)", kind: "sample", picked: "python-specs", ready: true, nameOptional: false });
  });

  it("says the samples are loading until the node answers, and shows a list still fresh at once", async () => {
    let answer!: (list: { samples: unknown[] }) => void;
    workspaces.samples.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await act(async () => root.render(<Harness />));
    expect(host.textContent).not.toContain("Loading samples…");
    await chooseSegment(host, "Sample");
    expect(labels()).toEqual([]);
    expect(host.textContent).toContain("Loading samples…");
    expect(state()).toMatchObject({ name: "", kind: "sample", picked: null, ready: false });
    await act(async () => answer({ samples: [LAWS] }));
    expect(labels()).toEqual(["Privacy laws"]);
    expect(host.textContent).not.toContain("Loading samples…");
    await chooseRadio(host, "Privacy laws");
    expect(state()).toMatchObject({ name: "Privacy laws (sample)", picked: "privacy-laws", ready: true });

    act(() => root.unmount());
    ({ host, root } = mountInto());
    workspaces.cachedSamples.mockReturnValue({ samples: [LAWS] });
    workspaces.samples.mockReturnValue(new Promise(() => {}));
    await act(async () => root.render(<Harness />));
    await chooseSegment(host, "Sample");
    expect(labels()).toEqual(["Privacy laws"]);
    expect(host.textContent).not.toContain("Loading samples…");
  });

  it("shows each opening what is fresh, else loading, rather than the list an earlier opening had", async () => {
    workspaces.samples.mockResolvedValue({ samples: [PYTHON, LAWS] });
    await act(async () => root.render(<Harness />));
    await chooseSegment(host, "Sample");
    await chooseRadio(host, "Privacy laws");
    await act(async () => root.render(<Harness isOpen={false} />));

    // The client's minute is over, and the node takes its time.
    let answer!: (list: { samples: unknown[]; unavailable?: boolean }) => void;
    workspaces.samples.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await act(async () => root.render(<Harness isOpen />));
    expect(labels()).toEqual([]);
    expect(host.textContent).toContain("Loading samples…");
    // The sample chosen from the old list is gone with it, and so is the name it gave.
    expect(state()).toMatchObject({ name: "", kind: "sample", picked: null, ready: false });
    await act(async () => answer({ samples: [], unavailable: true }));
    expect(host.textContent).toContain("Samples need an internet connection.");
  });

  it("lets go of a chosen sample the latest list no longer offers", async () => {
    workspaces.cachedSamples.mockReturnValue({ samples: [PYTHON, LAWS] });
    let answer!: (list: { samples: unknown[] }) => void;
    workspaces.samples.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await act(async () => root.render(<Harness />));
    await chooseSegment(host, "Sample");
    await chooseRadio(host, "Privacy laws");
    expect(state()).toMatchObject({ name: "Privacy laws (sample)", kind: "sample" });
    await act(async () => answer({ samples: [PYTHON] }));
    expect(labels()).toEqual(["Python specs"]);
    expect(state()).toMatchObject({ name: "", kind: "sample", picked: null, ready: false });
    expect(host.querySelector('input[type="radio"]:checked')).toBeNull();
  });

  it("asks for the samples only once it is open", async () => {
    await act(async () => root.render(<Harness isOpen={false} />));
    expect(workspaces.samples).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness isOpen />));
    expect(workspaces.samples).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the node has no list", () => workspaces.samples.mockResolvedValue({ samples: [], unavailable: true })],
    ["the node cannot be asked", () => workspaces.samples.mockRejectedValue(new Error("offline"))],
  ])("says samples need an internet connection when %s", async (_case, arrange) => {
    arrange();
    await act(async () => root.render(<Harness />));
    await chooseSegment(host, "Sample");
    expect(labels()).toEqual([]);
    expect(host.textContent).toContain("Samples need an internet connection.");
    expect(state()).toMatchObject({ kind: "sample", picked: null, ready: false });
  });

  it("asks again for samples the node could not offer when the browser comes back online or to the page, and each minute", async () => {
    workspaces.samples.mockResolvedValue({ samples: [], unavailable: true });
    workspaces.samplesAgain.mockResolvedValue({ samples: [], unavailable: true });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await act(async () => root.render(<Harness />));
      await chooseSegment(host, "Sample");
      expect(workspaces.samplesAgain).not.toHaveBeenCalled();
      await act(async () => void window.dispatchEvent(new Event("online")));
      await act(async () => void window.dispatchEvent(new Event("focus")));
      expect(workspaces.samplesAgain).toHaveBeenCalledTimes(2);
      expect(host.textContent).toContain("Samples need an internet connection.");

      workspaces.samplesAgain.mockResolvedValue({ samples: [PYTHON] });
      await act(async () => void (await vi.advanceTimersByTimeAsync(SAMPLES_RECHECK_MS)));
      expect(labels()).toEqual(["Python specs"]);
      expect(host.textContent).not.toContain("Samples need an internet connection.");

      // Offered now, so asked for again only as usual.
      await act(async () => void window.dispatchEvent(new Event("online")));
      await act(async () => void (await vi.advanceTimersByTimeAsync(SAMPLES_RECHECK_MS)));
      expect(workspaces.samplesAgain).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not ask again while closed", async () => {
    workspaces.samples.mockResolvedValue({ samples: [], unavailable: true });
    await act(async () => root.render(<Harness />));
    await act(async () => root.render(<Harness isOpen={false} />));
    await act(async () => void window.dispatchEvent(new Event("online")));
    expect(workspaces.samplesAgain).not.toHaveBeenCalled();
  });

  it("names the workspace after the chosen sample, unless a name was typed, and takes that name away with the sample", async () => {
    workspaces.samples.mockResolvedValue({ samples: [PYTHON, LAWS] });
    await act(async () => root.render(<Harness />));
    await chooseSegment(host, "Sample");
    await chooseRadio(host, "Privacy laws");
    expect(state()).toEqual({ name: "Privacy laws (sample)", kind: "sample", picked: "privacy-laws", ready: true, nameOptional: false });
    await chooseRadio(host, "Python specs");
    expect(state()).toMatchObject({ name: "Python specs (sample)", picked: "python-specs" });
    await chooseSegment(host, "Empty");
    expect(state()).toMatchObject({ name: "", kind: "empty", ready: false });
    await chooseSegment(host, "Sample");
    expect(state()).toMatchObject({ name: "Python specs (sample)", picked: "python-specs" });
    await chooseSegment(host, "Import");
    expect(state()).toMatchObject({ name: "", kind: "file" });
    await chooseSegment(host, "Sample");

    await typeName("Our specs");
    await chooseRadio(host, "Privacy laws");
    expect(state()).toMatchObject({ name: "Our specs", picked: "privacy-laws" });
    await chooseSegment(host, "Empty");
    expect(state()).toMatchObject({ name: "Our specs", kind: "empty", picked: null });
  });
});

describe("creating from a start", () => {
  const opened = async (made: Promise<Creation>) => {
    const out = await made;
    if (!("workspace" in out)) throw new Error("held, not made");
    return landingPath(out.workspace);
  };

  it("creates nothing but an empty workspace from a start with no sample or file chosen", async () => {
    workspaces.create.mockResolvedValue({ workspace_id: "w_0" });
    await createWorkspaceFrom({ kind: "sample", sample: null }, "Notes", "private");
    await createWorkspaceFrom({ kind: "file", file: null }, "Notes", "private");
    expect(workspaces.create).toHaveBeenCalledTimes(2);
    expect(workspaces.createFromSample).not.toHaveBeenCalled();
    expect(workspaces.checkImport).not.toHaveBeenCalled();
  });

  it("creates an empty workspace, or checks the file and imports it at once when it leaves nothing out, opening the document it starts with", async () => {
    workspaces.create.mockResolvedValue({ workspace_id: "w_1" });
    workspaces.importHeld.mockResolvedValue({ workspace_id: "w_2", start_doc_id: "d 1" });
    expect(await opened(createWorkspaceFrom({ kind: "empty" }, "Notes", "private"))).toBe("/");
    expect(workspaces.create).toHaveBeenCalledWith("Notes", "private");
    expect(await opened(createWorkspaceFrom({ kind: "file", file: ARCHIVE }, "Handbook", "workspace_edit"))).toBe("/doc/d%201");
    expect(workspaces.checkImport).toHaveBeenCalledWith(ARCHIVE);
    expect(workspaces.importHeld).toHaveBeenCalledWith("wsi_1", "Handbook", "workspace_edit");
    // With no name, the node takes the file's.
    await createWorkspaceFrom({ kind: "file", file: ARCHIVE }, "", "private");
    expect(workspaces.importHeld).toHaveBeenLastCalledWith("wsi_1", "", "private");
  });

  it("holds a file that would leave files out, importing it only when asked", async () => {
    const held = { import_id: "wsi_2", name: "Notion", expires_at: "2026-09-28T01:00:00Z", left_out: { count: 1, files: ["Home/Brief.pdf"] } };
    workspaces.checkImport.mockResolvedValue(held);
    expect(await createWorkspaceFrom({ kind: "file", file: ARCHIVE }, "", "private")).toEqual({ held });
    expect(workspaces.importHeld).not.toHaveBeenCalled();
    workspaces.importHeld.mockResolvedValue({ workspace_id: "w_4" });
    expect(await importHeldFile(held, "Notes", "private")).toEqual({ workspace_id: "w_4" });
    expect(workspaces.importHeld).toHaveBeenCalledWith("wsi_2", "Notes", "private");
  });

  it("creates from a sample, which the node downloads, and opens the document it starts with", async () => {
    workspaces.createFromSample.mockResolvedValue({ workspace_id: "w_3", start_doc_id: "d_laws" });
    expect(await opened(createWorkspaceFrom({ kind: "sample", sample: LAWS }, "Laws", "private"))).toBe("/doc/d_laws");
    expect(workspaces.createFromSample).toHaveBeenCalledWith("privacy-laws", "Laws", "private");
    expect(workspaces.create).not.toHaveBeenCalled();
  });

  it("passes a sample's refusal on as the node words it, and says one it stopped waiting for may still land", async () => {
    workspaces.createFromSample.mockRejectedValue(Object.assign(new Error("could not download the sample"), { status: 502 }));
    await expect(createWorkspaceFrom({ kind: "sample", sample: LAWS }, "Laws", "private")).rejects.toThrow("could not download the sample");
    workspaces.createFromSample.mockRejectedValue(Object.assign(new Error("try again"), { code: "timeout" }));
    await expect(createWorkspaceFrom({ kind: "sample", sample: LAWS }, "Laws", "private")).rejects.toThrow(
      "The import may still finish. Check your workspaces before trying again.",
    );
  });

  it("says a file is past what the import takes in the node's words, and past a proxy's limit, which answers without any", async () => {
    const tooLarge = "this file is larger than 512 MB, the most an import takes";
    workspaces.checkImport.mockRejectedValue(Object.assign(new Error(tooLarge), { status: 413, code: tooLarge }));
    await expect(createWorkspaceFrom({ kind: "file", file: ARCHIVE }, "Handbook", "private")).rejects.toThrow(tooLarge);
    workspaces.checkImport.mockRejectedValue(Object.assign(new Error("That’s too large to send."), { status: 413 }));
    await expect(createWorkspaceFrom({ kind: "file", file: ARCHIVE }, "Handbook", "private")).rejects.toThrow("This file is larger than a proxy in front of this node accepts.");
    workspaces.checkImport.mockRejectedValue(Object.assign(new Error("cannot import this archive: stuga.json: is missing"), { status: 400 }));
    await expect(createWorkspaceFrom({ kind: "file", file: ARCHIVE }, "Handbook", "private")).rejects.toThrow("cannot import this archive");
  });

  it("says an import it stopped waiting for may still land, rather than invite a second", async () => {
    for (const failure of [{ code: "timeout" }, { status: 504 }]) {
      workspaces.importHeld.mockRejectedValue(Object.assign(new Error("try again"), failure));
      await expect(createWorkspaceFrom({ kind: "file", file: ARCHIVE }, "Handbook", "private")).rejects.toThrow(
        "The import may still finish. Check your workspaces before trying again.",
      );
    }
  });
});
