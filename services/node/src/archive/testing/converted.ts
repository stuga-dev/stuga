/** Another app's export, zipped and converted, with the archive it makes held to `archive check`. For tests only. */
import { expect } from "vitest";
import { openZip, zipFiles } from "../../lib/zip.js";
import { checkArchive } from "../check.js";
import { convertExport } from "../convert/index.js";
import { MANIFEST_NAME } from "../format.js";
import { LIMITS, PNG, text, type Json } from "./fixture.js";

/** A zip of `files`, by path. */
export const zipOf = (files: Record<string, string | Uint8Array>): Uint8Array =>
  zipFiles(
    Object.entries(files).map(([name, data]) => ({ name, data: typeof data === "string" ? text(data) : data })),
    "deflate",
  );

/** `files` converted; the archive must pass `archive check`, so every body is Markdown as Stuga writes it. */
export async function converted(files: Record<string, string | Uint8Array>) {
  const out = await convertExport(openZip(zipOf(files)), LIMITS);
  if (!out) throw new Error("the export was not recognised");
  const { zip } = out;
  const check = await checkArchive({ sizes: new Map([...zip.files].map(([name, info]) => [name, info.size])), read: (path) => zip.read(path), others: new Map() });
  expect(check.issues).toEqual([]);
  const read = async (path: string): Promise<string> => new TextDecoder().decode(await zip.read(path));
  const manifest = JSON.parse(await read(MANIFEST_NAME)) as Json;
  return { kind: out.kind, manifest, leftOut: out.leftOut, changed: out.changed, body: read };
}

/** A Notion id: 32 of the digit `n`. */
export const notionId = (n: number): string => String(n).repeat(32).slice(0, 32);
const id = notionId;
const HOME = `Home ${id(1)}`;
const PROJECTS = `Projects ${id(2)}`;
const NOTES = `Notes ${id(3)}`;
const enc = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

const PROPERTIES = `Status: In progress\nDue: September 27, 2026\nDone: No\nPoints: 3\nOwner: Liv\nRelated: Notes (../${enc(`Notes ${id(3)}`)}.md)`;
const CSV = [
  "﻿Name,Status,Due,Done,Points,Owner,Related",
  `Launch,In progress,"September 27, 2026",No,3,Liv,Notes (../${enc(NOTES)}.md)`,
  `Docs,Done,"October 1, 2026 3:00 PM",Yes,5,Sam,`,
  "Hiring,In progress,,No,8,Liv,",
].join("\r\n");

/** A Notion export: one top-level page holding a page, a database with row pages, an image and a file. */
export const NOTION_EXPORT: Record<string, string | Uint8Array> = {
  [`${HOME}.md`]: [
    "# Home",
    "",
    `Start with [Notes](${enc(`${HOME}/${NOTES}.md`)}) and [Projects](${enc(`${HOME}/${PROJECTS}.csv`)}).`,
    "",
    "<aside>",
    "💡 Keep it short.",
    "",
    "</aside>",
    "",
    `![Untitled](${enc(`${HOME}/Untitled.png`)})`,
    "",
    `[Brief.pdf](${enc(`${HOME}/Brief.pdf`)})`,
  ].join("\n"),
  [`${HOME}/${NOTES}.md`]: [
    "# Notes",
    "",
    `Back [home](../${enc(HOME)}.md), on to [Launch](${enc(`${PROJECTS}/Launch ${id(4)}.md`)}) and [Docs](${enc(`${PROJECTS}/Docs ${id(5)}.md`)}), or [by URL](https://www.notion.so/Launch-${id(4)}?pvs=21).`,
    "",
    "- [ ] Draft",
    "- [x] Review",
  ].join("\n"),
  [`${HOME}/${PROJECTS}.csv`]: CSV,
  [`${HOME}/${PROJECTS}_all.csv`]: CSV,
  [`${HOME}/${PROJECTS}/Launch ${id(4)}.md`]: `# Launch\n\n${PROPERTIES}\n\nThe plan.`,
  [`${HOME}/${PROJECTS}/Docs ${id(5)}.md`]: "# Docs\n\nStatus: Done\nDue: October 1, 2026 3:00 PM\nDone: Yes\nPoints: 5\nOwner: Sam",
  [`${HOME}/${PROJECTS}/Hiring ${id(6)}.md`]: "# Hiring\n\nStatus: In progress\nDone: No\nPoints: 8\nOwner: Liv",
  [`${HOME}/Untitled.png`]: PNG,
  [`${HOME}/Brief.pdf`]: "%PDF-1.7",
};
