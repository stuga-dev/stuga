/**
 * The files of an export someone zipped or downloaded from another app: a Notion export, an
 * Obsidian vault, any folder of Markdown. What a converter reads, before it is an archive.
 */
import { openZip, type ZipArchive } from "../../lib/zip.js";
import { ARCHIVE_MAX_BYTES, ARCHIVE_MAX_UNPACKED_BYTES, ArchiveError } from "../format.js";

/** One file of an export, by its path from the export's top. */
export interface SourceFile {
  path: string;
  /** Unpacked, as the zip states it. */
  size: number;
  /** Its bytes, counted against the export's read budget. */
  read(): Promise<Uint8Array>;
}

export interface Source {
  /** The folder the export's files sat in, when the zip wraps them in one: a vault's name. */
  name: string | null;
  /** By path; `__MACOSX/` and anything under a name starting with a dot are left aside. */
  files: Map<string, SourceFile>;
}

/** What a Mac's Compress puts beside the files it packs. */
const MAC_FORKS = "__MACOSX/";

/** Whether `path` is something the export's app keeps for itself: `.obsidian/`, `.trash/`, `.DS_Store`, a Mac's forks. */
const setAside = (path: string): boolean => path.startsWith(MAC_FORKS) || path.split("/").some((segment) => segment.startsWith("."));

/** The zip's own name for a part of a larger Notion export: `Export-<id>-Part-1.zip`. */
const PART = /\.zip$/i;

/**
 * The export in `zip`: its files, less what is set aside, with the one folder that wraps them all
 * taken off, and the parts a large Notion export packs as zips inside the zip opened into one.
 * Every file read, a part included, counts once against ARCHIVE_MAX_UNPACKED_BYTES, so no export
 * unpacks to more than an archive may, however tightly it packs.
 */
export async function readSource(zip: ZipArchive): Promise<Source> {
  let budget = ARCHIVE_MAX_UNPACKED_BYTES;
  const spent = new Set<string>();
  // A file read again, as an image is when the archive is checked and again when it is imported, counts once.
  const spend = (path: string, size: number): void => {
    if (spent.has(path)) return;
    spent.add(path);
    budget -= size;
    if (budget < 0) throw new ArchiveError(path, `takes what the export unpacks to past ${ARCHIVE_MAX_UNPACKED_BYTES} bytes`);
  };
  const filesOf = (archive: ZipArchive): Map<string, SourceFile> => {
    const files = new Map<string, SourceFile>();
    for (const [path, info] of archive.files) {
      if (setAside(path)) continue;
      files.set(path, {
        path,
        size: info.size,
        read: () => {
          spend(path, info.size);
          // The most any file a converter reads can be: a part of a large export.
          return archive.read(path, ARCHIVE_MAX_BYTES);
        },
      });
    }
    return files;
  };

  let files = filesOf(zip);
  const parts = [...files.values()];
  if (parts.length > 0 && parts.every((file) => PART.test(file.path))) {
    files = new Map();
    for (const part of parts) {
      if (part.size > ARCHIVE_MAX_BYTES) throw new ArchiveError(part.path, `is larger than ${ARCHIVE_MAX_BYTES} bytes`);
      for (const [path, file] of filesOf(openZip(await part.read(), { maxEntries: 0xffff, maxEntryBytes: Infinity, maxTotalBytes: Infinity, maxRatio: Infinity }))) {
        if (!files.has(path)) files.set(path, file);
      }
    }
  }
  return unwrapped(files);
}

/** The folder a Notion export unzips to, `Export-<uuid>`; a Mac names a second one `Export-<uuid> 2`. */
const EXPORT_ROOT = /^Export-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?: \d+)?$/i;

/**
 * `files` with the folders that wrap them all taken off: the one folder at their top that holds
 * every file, as often as there is one, its name the export's; and Notion's `Export-<uuid>`
 * folders, merged, as each part of a large export unzips to one.
 */
function unwrapped(files: Map<string, SourceFile>): Source {
  let name: string | null = null;
  for (;;) {
    const tops = new Set([...files.keys()].map((path) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : null)));
    if (tops.size === 0 || tops.has(null)) return { name, files };
    const exportRoots = [...tops].every((top) => EXPORT_ROOT.test(top!));
    if (tops.size > 1 && !exportRoots) return { name, files };
    const out = new Map<string, SourceFile>();
    for (const [path, file] of files) {
      const inner = path.slice(path.indexOf("/") + 1);
      if (!out.has(inner)) out.set(inner, { ...file, path: inner });
    }
    if (!exportRoots) name = [...tops][0]!;
    files = out;
  }
}
