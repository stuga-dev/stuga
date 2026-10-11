import { describe, expect, it } from "vitest";
import { openZip } from "../../lib/zip.js";
import { NOTION_EXPORT as EXPORT, converted, notionId, zipOf } from "../testing/converted.js";
import { IMAGE, sha256, text, type Json } from "../testing/fixture.js";
import { convertExport } from "./index.js";
import { notionMarkdown, propertyList } from "./notion.js";

const id = notionId;

const shape = (manifest: Json) => manifest.items.map((i: Json) => [i.kind, i.path, i.title]);

describe("converting a Notion export", () => {
  it("makes a page with subpages a folder holding the page, and a database of each CSV", async () => {
    const { kind, manifest, leftOut } = await converted(EXPORT);
    expect(kind).toBe("notion");
    expect(manifest.workspace.name).toBe("Notion");
    expect(shape(manifest)).toEqual([
      ["folder", "Home", "Home"],
      ["doc", "Home/Home.md", "Home"],
      ["doc", "Home/Notes.md", "Notes"],
      ["database", "Home/Projects", "Projects"],
    ]);
    expect(manifest.start).toBe("Home/Home.md");
    expect(leftOut).toEqual([]);
  });

  it("types each column by what its cells hold, and gives a row a page only when its page holds more than its properties", async () => {
    const { manifest, body } = await converted(EXPORT);
    const [table] = manifest.items.find((i: Json) => i.kind === "database").tables;
    expect(table.columns).toEqual([
      { name: "Name", type: "text" },
      // A Status property offers the options Notion starts it with.
      { name: "Status", type: "single_select", choices: ["Not started", "In progress", "Done"] },
      { name: "Due", type: "date" },
      { name: "Done", type: "checkbox" },
      { name: "Points", type: "number" },
      { name: "Owner", type: "single_select", choices: ["Liv", "Sam"] },
      { name: "Related", type: "text" },
    ]);
    expect((await body(table.file)).split("\n")).toEqual([
      `{"_id":"${id(4)}","Name":"Launch","Status":"In progress","Due":"2026-09-27","Done":false,"Points":3,"Owner":"Liv","Related":"Notes"}`,
      `{"_id":"${id(5)}","Name":"Docs","Status":"Done","Due":"2026-10-01","Done":true,"Points":5,"Owner":"Sam"}`,
      `{"_id":"${id(6)}","Name":"Hiring","Status":"In progress","Done":false,"Points":8,"Owner":"Liv"}`,
      "",
    ]);
    expect(table.pages.map((p: Json) => [p.row, p.file, p.title])).toEqual([[id(4), "Home/Projects/pages/Launch.md", "Launch"]]);
    expect(await body("Home/Projects/pages/Launch.md")).toBe("# Launch\n\nThe plan.\n");
  });

  it("points links at pages and rows by id, spells callouts and tasks as Stuga's Markdown, and keeps a file's name", async () => {
    const { body } = await converted(EXPORT);
    expect(await body("Home/Home.md")).toBe(
      ["# Home", "", "Start with [Notes](Notes.md) and [Projects](Projects).", "", "> 💡 Keep it short.", "", `![Untitled](../${IMAGE})`, "", `[Brief.pdf](../media/${sha256(text("%PDF-1.7"))}/Brief.pdf)`, ""].join("\n"),
    );
    expect(await body("Home/Notes.md")).toBe(
      [
        "# Notes",
        "",
        `Back [home](Home.md), on to [Launch](Projects/pages/Launch.md) and [Docs](Projects#row=${id(5)}), or [by URL](Projects/pages/Launch.md).`,
        "",
        "* [ ] Draft",
        "",
        "* [x] Review",
        "",
      ].join("\n"),
    );
  });

  it("reads a large export's parts, each its own Export folder zipped inside the zip, as one, named as Notion's index names the workspace", async () => {
    const root = "Export-0a1b2c3d-0000-4000-8000-00000000000a";
    const files = Object.entries({ ...EXPORT, "index.html": "<p>Workspace name: Liv&#x27;s Notion</p>" });
    const part = (entries: typeof files) => zipOf(Object.fromEntries(entries.map(([path, data]) => [`${root}/${path}`, data])));
    const { manifest, leftOut } = await converted({ [`${root}-Part-1.zip`]: part(files.slice(0, 4)), [`${root}-Part-2.zip`]: part(files.slice(4)) });
    expect(manifest.workspace.name).toBe("Liv's Notion");
    expect(shape(manifest)).toEqual(shape((await converted(EXPORT)).manifest));
    expect(leftOut).toEqual([]);
  });

  it("makes a linked view a link to the database it shows, and a full-page database's stub page the database", async () => {
    const tasks = `Tasks ${id(7)}`;
    const { manifest, body } = await converted({
      [`${tasks}_all.csv`]: "Name,Status\r\nA,Done\r\n",
      [`${tasks}.csv`]: "Name,Status\r\nA,Done\r\n",
      [`${tasks}.md`]: "# Tasks",
      [`Plan ${id(8)}.md`]: `# Plan\n\n[Tasks](Plan%20${id(8)}/Tasks%20${id(9)}.csv) and [the stub](Tasks%20${id(7)}.md)`,
      [`Plan ${id(8)}/Tasks ${id(9)}.csv`]: "Name\r\nA\r\n",
    });
    expect(shape(manifest)).toEqual([
      ["doc", "Plan.md", "Plan"],
      ["database", "Tasks", "Tasks"],
    ]);
    expect(await body("Plan.md")).toBe("# Plan\n\n[Tasks](Tasks) and [the stub](Tasks)\n");
  });

  it("makes a files property a files column holding the files its cells name", async () => {
    const pdf = text("%PDF-1.7");
    const png = text("%PNG-ish");
    const { manifest, body, leftOut } = await converted({
      [`Welcome ${id(6)}.md`]: "# Welcome",
      [`Patents ${id(2)}_all.csv`]: `Name,Attachment\r\nLight BIM,"Patents/Light%20BIM/2021.pdf, Patents/Light%20BIM/fig.png"\r\nPlain,\r\n`,
      [`Patents/Light BIM/2021.pdf`]: pdf,
      [`Patents/Light BIM/fig.png`]: png,
    });
    const [table] = manifest.items.find((i: Json) => i.kind === "database").tables;
    expect(table.columns).toEqual([
      { name: "Name", type: "text" },
      { name: "Attachment", type: "files" },
    ]);
    expect(table.pages).toEqual([]);
    expect((await body(table.file)).split("\n")).toEqual([
      `{"_id":"row-1","Name":"Light BIM","Attachment":["media/${sha256(pdf)}/2021.pdf","media/${sha256(png)}/fig.png"]}`,
      `{"_id":"row-2","Name":"Plain"}`,
      "",
    ]);
    expect(leftOut).toEqual([]);
  });

  it("keeps a folder no page owns, such as a teamspace's, and a page no row names, with its database, only when it holds more than properties", async () => {
    const { manifest } = await converted({
      [`Welcome ${id(6)}.md`]: "# Welcome",
      [`Team space ${id(1)}/Wiki ${id(2)}.md`]: "# Wiki",
      [`Team space ${id(1)}/Bugs ${id(3)}_all.csv`]: "Name,Status\r\n@August 6, 2025,Open\r\n",
      [`Team space ${id(1)}/Bugs ${id(3)}/@Today ${id(4)}.md`]: "# @Today\n\nStatus: Open",
      [`Team space ${id(1)}/Bugs ${id(3)}/Bug template ${id(5)}.md`]: "# Bug template\n\nStatus: Open\n\n## Steps",
    });
    expect(shape(manifest)).toEqual([
      ["doc", "Welcome.md", "Welcome"],
      ["folder", "Team space", "Team space"],
      ["folder", "Team space/Bugs", "Bugs"],
      ["database", "Team space/Bugs/Bugs", "Bugs"],
      ["doc", "Team space/Bugs/Bug template.md", "Bug template"],
      ["doc", "Team space/Wiki.md", "Wiki"],
    ]);
  });

  it("makes a status column a select even when no value repeats, and says which columns list several values in a cell", async () => {
    const { manifest, changed } = await converted({
      [`Tasks ${id(7)}_all.csv`]: "Name,Status,Tags\r\nA,Done,\"x, y\"\r\nB,Not started,z\r\nC,In progress,\r\n",
    });
    const [table] = manifest.items[0].tables;
    expect(table.columns).toEqual([
      { name: "Name", type: "text" },
      { name: "Status", type: "single_select", choices: ["Not started", "In progress", "Done"] },
      { name: "Tags", type: "text" },
    ]);
    expect(changed).toEqual([{ kind: "text_column", where: ["Tags"] }]);
  });

  it("lists a page's property lines, and makes a one-line toggle its bold title and text", async () => {
    const { body } = await converted({
      [`Plan ${id(8)}.md`]: "# Plan\n\nCreated: October 1, 2026 9:00 AM\nStatus: In progress\nOwner: Liv\n\nNote: one line stays.\n\n<details><summary>More</summary>hidden stuff</details>",
    });
    expect(await body("Plan.md")).toBe(
      "# Plan\n\n* Created: October 1, 2026 9:00 AM\n\n* Status: In progress\n\n* Owner: Liv\n\nNote: one line stays.\n\n**More**\n\nhidden stuff\n",
    );
  });

  it("leaves a numbered list under a page's title a numbered list", () => {
    const steps = "# Steps\n\n1. Mix: flour and water\n2. Bake: 40 minutes";
    expect(propertyList(steps)).toBe(steps);
    expect(propertyList("# Plan\n\nOwner: Liv\nDue: Friday")).toBe("# Plan\n\n- Owner: Liv\n- Due: Friday");
  });

  it("refuses Notion's HTML export, naming the one it reads", async () => {
    await expect(convertExport(openZip(zipOf({ [`Home ${id(1)}.html`]: "<html></html>" })), { maxImageBytes: 1024 })).rejects.toThrow(
      "this is Notion's HTML export; export as Markdown & CSV instead",
    );
  });
});

describe("Notion's Markdown", () => {
  it("lifts a block's children, which Notion indents, out of what CommonMark would read as code", () => {
    expect(notionMarkdown("## Toggle\n\n    Child\n\n        Grandchild\n\n    - Item\n        - Nested")).toBe("## Toggle\n\nChild\n\nGrandchild\n\n- Item\n    - Nested");
    expect(notionMarkdown("- Item\n\n    More of the item")).toBe("- Item\n\n    More of the item");
    expect(notionMarkdown("```\n    kept\n```")).toBe("```\n    kept\n```");
  });

  it("makes a callout a block quote without its icon and a toggle its bold title, and keeps a task box", () => {
    const icon = '<img src="https://www.notion.so/icons/stars_gray.svg" alt="" width="40px" />';
    expect(notionMarkdown(`<aside>\n${icon} **Tip:** Share it.\n\n</aside>`)).toBe("> **Tip:** Share it.\n>\n");
    expect(notionMarkdown("<details>\n<summary>More</summary>\n\nInside\n</details>")).toBe("**More**\n\nInside");
    expect(notionMarkdown("<details><summary>More</summary>Inside</details>")).toBe("**More**\n\nInside");
    expect(notionMarkdown("<aside>\n<details><summary>More</summary></details>\n</aside>")).toBe("> **More**\n");
    expect(notionMarkdown("- [ ]  Draft\n- [x]  Ship")).toBe("- [ ]  Draft\n- [x]  Ship");
  });
});
