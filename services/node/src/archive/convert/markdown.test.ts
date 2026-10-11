import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ArchiveError } from "../format.js";
import { readArchive } from "../import.js";
import { converted, zipOf } from "../testing/converted.js";
import { IMAGE, LIMITS, PNG, sha256, text } from "../testing/fixture.js";

/** Where the vault's PDF lands: a file of the archive, named for its bytes and its name. */
const BRIEF = `media/${sha256(text("%PDF-1.7"))}/Brief.pdf`;

const VAULT = {
  "Notes/.obsidian/app.json": "{}",
  "Notes/.trash/Old.md": "gone",
  "Notes/Home.md": [
    "---",
    "tags: [start]",
    "---",
    "See [[Projects/Launch plan|the plan]], [[Launch plan#Risks]] and [[Someday]].",
    "",
    "![[chart.png|300]]",
    "",
    "![[Brief.pdf]]",
    "",
    "> [!warning] Mind the date",
    "> Ships ==Friday==. %%not yet%%",
    "",
    "%%",
    "A private draft.",
    "%%",
    "- [ ] Book the room ^task1",
    "- [x] Send the invite",
    "",
    "```",
    "[[Not a link]] ==kept==",
    "```",
    "",
    "`[[kept]]` and [the plan](Projects/Launch%20plan.md).",
  ].join("\n"),
  "Notes/Projects/Launch plan.md": "# Launch plan\n\n## Risks\n\nBack to [[Home]].",
  "Notes/Projects/Plain.md": "---\ntitle: Quarterly goals\n---\nGrow.",
  "Notes/attachments/chart.png": PNG,
  "Notes/attachments/Brief.pdf": "%PDF-1.7",
  "Notes/attachments/Board.canvas": "{}",
};

describe("converting a folder of Markdown", () => {
  it("makes a workspace of the vault's folders and notes, named for the vault", async () => {
    const { manifest, leftOut } = await converted(VAULT);
    expect(manifest.workspace.name).toBe("Notes");
    expect(manifest.items.map((i: { kind: string; path: string; title: string; title_source?: string }) => [i.kind, i.path, i.title, i.title_source])).toEqual([
      ["doc", "Home.md", "Home", "user"],
      ["folder", "Projects", "Projects", undefined],
      ["doc", "Projects/Launch plan.md", "Launch plan", "heading"],
      ["doc", "Projects/Quarterly goals.md", "Quarterly goals", "user"],
    ]);
    // Settings and the vault's trash are not notes; a file no note links to is listed, with why.
    expect(leftOut).toEqual([{ path: "attachments/Board.canvas", reason: "not_linked" }]);
  });

  it("spells Obsidian's links, embeds, callouts, highlights, comments, block ids and tasks as Stuga's Markdown", async () => {
    const { body, changed } = await converted(VAULT);
    expect(await body("Home.md")).toBe(
      [
        "* tags: start",
        "",
        "See [the plan](Projects/Launch%20plan.md), [Launch plan > Risks](Projects/Launch%20plan.md) and Someday.",
        "",
        `![](${IMAGE})`,
        "",
        `[Brief.pdf](${BRIEF})`,
        "",
        "> **Mind the date**",
        ">",
        "> Ships **Friday**.",
        "",
        "* [ ] Book the room",
        "",
        "* [x] Send the invite",
        "",
        "```",
        "[[Not a link]] ==kept==",
        "```",
        "",
        "`[[kept]]` and [the plan](Projects/Launch%20plan.md).",
        "",
      ].join("\n"),
    );
    expect(await body("Projects/Launch plan.md")).toBe("# Launch plan\n\n## Risks\n\nBack to [Home](../Home.md).\n");
    expect(await body("Projects/Quarterly goals.md")).toBe("Grow.\n");
    // What reads differently is said, by the documents it happened in.
    expect(changed).toEqual([
      { kind: "front_matter", where: ["Home"] },
      { kind: "unresolved_link", where: ["Home"] },
      { kind: "heading_link", where: ["Home"] },
      { kind: "highlight", where: ["Home"] },
    ]);
  });

  it("keeps a note's properties as a list under its heading, and says when their title is not the one it takes", async () => {
    const { manifest, body, changed } = await converted({
      "Plan.md": "---\ntitle: Shop plan\nauthor: Liv\ncssclasses: wide\n---\n# Opening week\n\nText with $x^2$ and ![[Missing.png]] and ![[Other]].",
      "Other.md": "# Other",
    });
    expect(manifest.items.map((i: { title: string }) => i.title)).toEqual(["Other", "Opening week"]);
    expect(await body("Opening week.md")).toBe("# Opening week\n\n* title: Shop plan\n\n* author: Liv\n\nText with $x^2$ and Missing.png and [Other](Other.md).\n");
    expect(changed).toEqual([
      { kind: "front_matter", where: ["Opening week"] },
      { kind: "title_differs", where: ["Opening week"] },
      { kind: "missing_image", where: ["Opening week"] },
      { kind: "embedded_note", where: ["Opening week"] },
      { kind: "math", where: ["Opening week"] },
    ]);
  });

  it("resolves a name shared by two notes to the one in the linking note's folder, else the one nearest the top", async () => {
    // An archive names a document for its title, as an export does.
    const { body } = await converted({
      "Index.md": "[[Ideas]]",
      "Deep/Down/Ideas.md": "# Deep ideas",
      "Work/Ideas.md": "# Work ideas",
      "Work/Log.md": "[[Ideas]] and [[Down/Ideas]]",
    });
    expect(await body("Index.md")).toBe("[Ideas](Work/Work%20ideas.md)\n");
    expect(await body("Work/Log.md")).toBe("[Ideas](Work%20ideas.md) and [Down/Ideas](../Deep/Down/Deep%20ideas.md)\n");
  });

  it("reads an image's size out of its text, keeps an image written into the note, and leaves an Excalidraw drawing out", async () => {
    const inline = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
    const { body, leftOut } = await converted({
      "Note.md": `![Chart|300](chart.png)\n\n![Dot](${inline})`,
      "chart.png": PNG,
      "Sketch.excalidraw.md": "---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data",
    });
    expect(await body("Note.md")).toBe(`![Chart](${IMAGE})\n\n![Dot](${IMAGE})\n`);
    expect(leftOut).toEqual([{ path: "Sketch.excalidraw.md", reason: "not_kept" }]);
  });

  it("takes a first-level heading as the title, else the file's name, adding no heading", async () => {
    const { manifest, body } = await converted({ "a.md": "# Real title\n\nText.", "2026-09-27.md": "## Tasks\n\n- One" });
    expect(manifest.items.map((i: { title: string }) => i.title)).toEqual(["2026-09-27", "Real title"]);
    expect(await body("2026-09-27.md")).toBe("## Tasks\n\n* One\n");
  });

  it("says why each file is left out: too large, not a readable image, not text", async () => {
    // Random, so the zip cannot pack it tighter than it takes.
    const big = new Uint8Array(randomBytes(LIMITS.maxImageBytes + 1));
    const { leftOut } = await converted({
      "Note.md": "![Big](big.png) ![Broken](broken.png) [Big file](big.pdf)",
      "big.png": big,
      "broken.png": text("not an image"),
      "big.pdf": big,
      "latin1.md": new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
    });
    expect(leftOut).toEqual([
      { path: "big.pdf", reason: "too_large", size: big.byteLength, limit: LIMITS.maxImageBytes },
      { path: "big.png", reason: "too_large", size: big.byteLength, limit: LIMITS.maxImageBytes },
      { path: "broken.png", reason: "unreadable_image" },
      { path: "latin1.md", reason: "unreadable_text" },
    ]);
  });

  it("imports through the same checks as an archive, only when asked to convert", async () => {
    const zip = zipOf({ "Vault/Note.md": "Hello" });
    const contents = await readArchive(zip, { ...LIMITS, convert: true });
    expect(contents.kind).toBe("markdown");
    expect(await contents.body("Note.md")).toBe("Hello");
    await expect(readArchive(zip, LIMITS)).rejects.toThrow("stuga.json: is missing, so this is not a Stuga workspace archive");
    await expect(readArchive(zipOf({ "notes.txt": "hi" }), { ...LIMITS, convert: true })).rejects.toThrow(ArchiveError);
  });
});
