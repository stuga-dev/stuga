/**
 * A file chosen in the library to make a database from, handed to the new
 * database's page, which imports it. Memory only: a reload drops it, and the
 * page then opens the Import dialog empty.
 */
/** The files an import reads: CSV (or tab-separated) and JSON lines. */
export const IMPORT_FILE_ACCEPT = ".csv,.tsv,.txt,.jsonl,.ndjson,.json,text/csv,text/tab-separated-values,text/plain,application/json";

let handed: { docId: string; file: File } | null = null;

export function handOverImport(docId: string, file: File): void {
  handed = { docId, file };
}

/** The file handed to this database, once. */
export function takeHandedImport(docId: string): File | null {
  if (handed?.docId !== docId) return null;
  const { file } = handed;
  handed = null;
  return file;
}
