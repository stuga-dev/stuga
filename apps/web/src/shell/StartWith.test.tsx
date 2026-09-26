// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workspaces = vi.hoisted(() => ({
  create: vi.fn(),
  createFromSample: vi.fn(),
  importArchive: vi.fn(),
  samples: vi.fn(),
  samplesAgain: vi.fn(),
  cachedSamples: vi.fn(),
}));
vi.mock("../api", async (orig) => ({ ...(await orig<typeof import("../api")>()), Workspaces: workspaces }));

const { SAMPLES_RECHECK_MS, StartWith, createWorkspaceFrom, landingPath, useNewWorkspace, useWorkspaceSamples } = await import("./StartWith");
import { chooseRadio, pickFile } from "../test/form-input";

const ARCHIVE = new File(["PK"], "Team handbook.stuga.zip", { type: "application/zip" });
const PYTHON = { id: "python-specs", title: "Python specs", description: "Specs and a release plan.", name: "Python specs (sample)", langs: ["en"] };
const LAWS = { id: "privacy-laws", title: "Privacy laws", description: "Six laws in their own languages.", name: "Privacy laws (sample)", langs: ["en", "zh"] };

let host: HTMLDivElement;
let root: Root;

/** StartWith with the name beside it, as the dialog and the onboarding page hold them. */
function Harness({ isOpen = true }: { isOpen?: boolean }) {
  const { name, setName, start, setStart, ready, nameOptional } = useNewWorkspace();
  const samples = useWorkspaceSamples(isOpen);
  const picked = start.kind === "file" ? (start.file?.name ?? null) : start.kind === "sample" ? start.sample.id : null;
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
const labels = () => [...host.querySelectorAll('input[type="radio"]')].map((r) => document.getElementById(r.getAttribute("aria-labelledby") ?? "")?.textContent);

async function typeName(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="name"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  workspaces.create.mockReset();
  workspaces.createFromSample.mockReset();
  workspaces.importArchive.mockReset();
  workspaces.samples.mockReset().mockResolvedValue({ samples: [] });
  workspaces.samplesAgain.mockReset().mockResolvedValue({ samples: [] });
  workspaces.cachedSamples.mockReset().mockReturnValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Start with", () => {
  it("offers an empty workspace or one from a file, and shows the file picker only for a file", async () => {
    await act(async () => root.render(<Harness />));
    expect(host.textContent).toContain("Start with");
    expect(host.textContent).toContain("Empty workspace");
    expect(host.textContent).toContain("From a file");
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(state()).toMatchObject({ kind: "empty", ready: false });

    await chooseRadio(host, "From a file");
    expect(host.querySelector<HTMLInputElement>('input[type="file"]')?.accept).toBe(".zip,application/zip");
    expect(state()).toMatchObject({ kind: "file", picked: null, ready: false });
    await chooseRadio(host, "Empty workspace");
    expect(host.querySelector('input[type="file"]')).toBeNull();
  });

  it("leaves a file's workspace the name its archive carries, unless a name was typed", async () => {
    await act(async () => root.render(<Harness />));
    await chooseRadio(host, "From a file");
    expect(state()).toEqual({ name: "", kind: "file", picked: null, ready: false, nameOptional: true });
    // Not the file's name, which a browser's " (1)" or a dropped character can change.
    await pickFile(host, new File(["PK"], "Team handbook.stuga (1).zip", { type: "application/zip" }));
    expect(state()).toEqual({ name: "", kind: "file", picked: "Team handbook.stuga (1).zip", ready: true, nameOptional: true });

    await typeName("Handbook");
    await pickFile(host, ARCHIVE);
    expect(state()).toMatchObject({ name: "Handbook", picked: "Team handbook.stuga.zip", ready: true });
    await chooseRadio(host, "Empty workspace");
    expect(state()).toMatchObject({ name: "Handbook", kind: "empty", ready: true, nameOptional: false });
  });

  it("offers the node's samples between an empty workspace and a file, each with its line", async () => {
    workspaces.samples.mockResolvedValue({ samples: [PYTHON, LAWS] });
    await act(async () => root.render(<Harness />));
    expect(labels()).toEqual(["Empty workspace", "Python specs", "Privacy laws", "From a file"]);
    expect(host.textContent).toContain("Six laws in their own languages.");
    expect(host.textContent).not.toContain("Samples need an internet connection.");
    expect(host.textContent).not.toContain("Loading samples…");
  });

  it("says the samples are loading until the node answers, and shows a list still fresh at once", async () => {
    let answer!: (list: { samples: unknown[] }) => void;
    workspaces.samples.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await act(async () => root.render(<Harness />));
    expect(labels()).toEqual(["Empty workspace", "From a file"]);
    expect(host.textContent).toContain("Loading samples…");
    await act(async () => answer({ samples: [LAWS] }));
    expect(labels()).toEqual(["Empty workspace", "Privacy laws", "From a file"]);
    expect(host.textContent).not.toContain("Loading samples…");

    act(() => root.unmount());
    root = createRoot(host);
    workspaces.cachedSamples.mockReturnValue({ samples: [LAWS] });
    workspaces.samples.mockReturnValue(new Promise(() => {}));
    await act(async () => root.render(<Harness />));
    expect(labels()).toEqual(["Empty workspace", "Privacy laws", "From a file"]);
    expect(host.textContent).not.toContain("Loading samples…");
  });

  it("shows each opening what is fresh, else loading, rather than the list an earlier opening had", async () => {
    workspaces.samples.mockResolvedValue({ samples: [PYTHON, LAWS] });
    await act(async () => root.render(<Harness />));
    await chooseRadio(host, "Privacy laws");
    await act(async () => root.render(<Harness isOpen={false} />));

    // The client's minute is over, and the node takes its time.
    let answer!: (list: { samples: unknown[]; unavailable?: boolean }) => void;
    workspaces.samples.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await act(async () => root.render(<Harness isOpen />));
    expect(labels()).toEqual(["Empty workspace", "From a file"]);
    expect(host.textContent).toContain("Loading samples…");
    // The sample chosen from the old list is gone with it, and so is the name it gave.
    expect(state()).toMatchObject({ name: "", kind: "empty", ready: false });
    await act(async () => answer({ samples: [], unavailable: true }));
    expect(host.textContent).toContain("Samples need an internet connection.");
  });

  it("falls back to an empty workspace when the latest list no longer offers the chosen sample", async () => {
    workspaces.cachedSamples.mockReturnValue({ samples: [PYTHON, LAWS] });
    let answer!: (list: { samples: unknown[] }) => void;
    workspaces.samples.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await act(async () => root.render(<Harness />));
    await chooseRadio(host, "Privacy laws");
    expect(state()).toMatchObject({ name: "Privacy laws (sample)", kind: "sample" });
    await act(async () => answer({ samples: [PYTHON] }));
    expect(labels()).toEqual(["Empty workspace", "Python specs", "From a file"]);
    expect(state()).toMatchObject({ name: "", kind: "empty", ready: false });
    expect(host.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe("empty");
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
    expect(labels()).toEqual(["Empty workspace", "From a file"]);
    expect(host.textContent).toContain("Samples need an internet connection.");
  });

  it("asks again for samples the node could not offer when the browser comes back online or to the page, and each minute", async () => {
    workspaces.samples.mockResolvedValue({ samples: [], unavailable: true });
    workspaces.samplesAgain.mockResolvedValue({ samples: [], unavailable: true });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await act(async () => root.render(<Harness />));
      expect(workspaces.samplesAgain).not.toHaveBeenCalled();
      await act(async () => void window.dispatchEvent(new Event("online")));
      await act(async () => void window.dispatchEvent(new Event("focus")));
      expect(workspaces.samplesAgain).toHaveBeenCalledTimes(2);
      expect(host.textContent).toContain("Samples need an internet connection.");

      workspaces.samplesAgain.mockResolvedValue({ samples: [PYTHON] });
      await act(async () => void (await vi.advanceTimersByTimeAsync(SAMPLES_RECHECK_MS)));
      expect(labels()).toEqual(["Empty workspace", "Python specs", "From a file"]);
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
    await chooseRadio(host, "Privacy laws");
    expect(state()).toEqual({ name: "Privacy laws (sample)", kind: "sample", picked: "privacy-laws", ready: true, nameOptional: false });
    await chooseRadio(host, "Python specs");
    expect(state()).toMatchObject({ name: "Python specs (sample)", picked: "python-specs" });
    await chooseRadio(host, "Empty workspace");
    expect(state()).toMatchObject({ name: "", kind: "empty", ready: false });
    await chooseRadio(host, "Privacy laws");
    await chooseRadio(host, "From a file");
    expect(state()).toMatchObject({ name: "", kind: "file" });
    await chooseRadio(host, "Python specs");

    await typeName("Our specs");
    await chooseRadio(host, "Privacy laws");
    expect(state()).toMatchObject({ name: "Our specs", picked: "privacy-laws" });
    await chooseRadio(host, "Empty workspace");
    expect(state()).toMatchObject({ name: "Our specs", kind: "empty", picked: null });
  });
});

describe("creating from a start", () => {
  it("creates an empty workspace, or imports the file, and opens the document an archive starts with", async () => {
    workspaces.create.mockResolvedValue({ workspace_id: "w_1" });
    workspaces.importArchive.mockResolvedValue({ workspace_id: "w_2", start_doc_id: "d 1" });
    expect(landingPath(await createWorkspaceFrom({ kind: "empty" }, "Notes", "private"))).toBe("/");
    expect(workspaces.create).toHaveBeenCalledWith("Notes", "private");
    expect(landingPath(await createWorkspaceFrom({ kind: "file", file: ARCHIVE }, "Handbook", "workspace_edit"))).toBe("/doc/d%201");
    expect(workspaces.importArchive).toHaveBeenCalledWith(ARCHIVE, "Handbook", "workspace_edit");
    // With no name, the node takes the archive's.
    await createWorkspaceFrom({ kind: "file", file: ARCHIVE }, "", "private");
    expect(workspaces.importArchive).toHaveBeenLastCalledWith(ARCHIVE, "", "private");
  });

  it("creates from a sample, which the node downloads, and opens the document it starts with", async () => {
    workspaces.createFromSample.mockResolvedValue({ workspace_id: "w_3", start_doc_id: "d_laws" });
    expect(landingPath(await createWorkspaceFrom({ kind: "sample", sample: LAWS }, "Laws", "private"))).toBe("/doc/d_laws");
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

  it("says a file is past the node's upload limit, which answers without a message of its own", async () => {
    workspaces.importArchive.mockRejectedValue(Object.assign(new Error("That’s too large to send."), { status: 413 }));
    await expect(createWorkspaceFrom({ kind: "file", file: ARCHIVE }, "Handbook", "private")).rejects.toThrow("This file is larger than this node accepts.");
    workspaces.importArchive.mockRejectedValue(Object.assign(new Error("cannot import this archive: stuga.json: is missing"), { status: 400 }));
    await expect(createWorkspaceFrom({ kind: "file", file: ARCHIVE }, "Handbook", "private")).rejects.toThrow("cannot import this archive");
  });

  it("says an import it stopped waiting for may still land, rather than invite a second", async () => {
    for (const failure of [{ code: "timeout" }, { status: 504 }]) {
      workspaces.importArchive.mockRejectedValue(Object.assign(new Error("try again"), failure));
      await expect(createWorkspaceFrom({ kind: "file", file: ARCHIVE }, "Handbook", "private")).rejects.toThrow(
        "The import may still finish. Check your workspaces before trying again.",
      );
    }
  });
});
