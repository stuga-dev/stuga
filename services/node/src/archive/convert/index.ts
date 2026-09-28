/**
 * Another app's export read as a workspace archive: a Notion export (Markdown & CSV), or a folder
 * of Markdown such as an Obsidian vault. The archive it makes is checked and imported as one from a
 * file is, so a conversion writes nothing an archive could not.
 */
import type { ZipArchive } from "../../lib/zip.js";
import { buildArchive, type Built } from "./build.js";
import { convertVault, isVault } from "./markdown.js";
import { convertNotion, isNotionExport } from "./notion.js";
import { readSource } from "./source.js";

export type ExportKind = "notion" | "markdown";

export interface Converted extends Built {
  kind: ExportKind;
}

/** The archive the export in `zip` makes, or null when it holds nothing Stuga reads. */
export async function convertExport(zip: ZipArchive, limits: { maxImageBytes: number }): Promise<Converted | null> {
  const source = await readSource(zip);
  if (isNotionExport(source)) return { kind: "notion", ...(await buildArchive(await convertNotion(source), source, limits)) };
  if (isVault(source)) return { kind: "markdown", ...(await buildArchive(await convertVault(source), source, limits)) };
  return null;
}
