/**
 * The cell and choice validators in `@stuga/protocol/databases/cells` refuse in English, which the
 * node and agents read as it is. A person reads the refusal in their language: each reason maps to
 * a catalog message here, and cell-problems.test.ts holds every reason to its sentence.
 */
import { t, type MessageKey, type MessageValues } from "../../i18n/i18n";
import { presentServerMessage } from "../../lib/http/server-messages";

interface Reason {
  match: string | RegExp;
  key: MessageKey;
  values?: (groups: RegExpExecArray) => MessageValues;
}

const REASONS: readonly Reason[] = [
  { match: "expected a string", key: "database.cell.expectedText" },
  { match: /^text too long \(max (\d+) bytes\)$/, key: "database.cell.textTooLong", values: (g) => ({ max: Number(g[1]) }) },
  { match: "expected a finite number", key: "database.cell.expectedNumber" },
  { match: "expected true/false", key: "database.cell.expectedCheckbox" },
  { match: "expected YYYY-MM-DD", key: "database.cell.expectedDate" },
  { match: "not a real calendar date", key: "database.cell.notRealDate" },
  { match: /^not one of the column's choices \((.*)\)$/s, key: "database.cell.notAChoice", values: (g) => ({ choices: g[1] }) },
  { match: "expected file links, one per line", key: "database.cell.expectedFileLinks" },
  {
    match: /^not a file link: (.*) \(upload the file to this database first\)$/s,
    key: "database.cell.notFileLink",
    values: (g) => ({ link: g[1] }),
  },
  { match: /^too many files \(max (\d+)\)$/, key: "database.cell.tooManyFiles", values: (g) => ({ max: Number(g[1]) }) },
  { match: /^file links too long \(max (\d+) bytes\)$/, key: "database.cell.fileLinksTooLong", values: (g) => ({ max: Number(g[1]) }) },
  { match: "single_select needs a non-empty choices array", key: "database.choices.required" },
  { match: /^too many choices \(max (\d+)\)$/, key: "database.choices.tooMany", values: (g) => ({ max: Number(g[1]) }) },
  { match: "choices must be non-empty strings", key: "database.choices.empty" },
  { match: /^choice too long \(max (\d+) chars\)$/, key: "database.choices.tooLong", values: (g) => ({ max: Number(g[1]) }) },
  { match: /^duplicate choice: (.*)$/s, key: "database.choices.duplicate", values: (g) => ({ choice: g[1] }) },
];

/** A validator's reason in the reader's language, or null for a reason this app does not know. */
export function knownCellProblem(reason: string): string | null {
  for (const r of REASONS) {
    if (typeof r.match === "string") {
      if (r.match === reason) return t(r.key);
      continue;
    }
    const groups = r.match.exec(reason);
    if (groups) return t(r.key, r.values?.(groups));
  }
  return null;
}

/** A validator's reason as a person reads it; an unknown one goes through the server-message table. */
export function cellProblem(reason: string): string {
  return knownCellProblem(reason) ?? presentServerMessage(reason);
}
