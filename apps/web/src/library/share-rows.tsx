/** Pieces the Share dialog's rows share: the access column, wrapping descriptions and round icons. */
import type { ReactNode } from "react";

/** One column for every row's access control, so they line up down the dialog; a longer translation widens it. */
export const ROLE_WIDTH = "max-content";

/**
 * A row's description lines, as an element: the list truncates a plain string to one line, and on a
 * phone or in a longer language the words that say what access means must stay readable.
 */
export function describe(lines: Array<string | null | undefined>): ReactNode {
  const kept = lines.filter((l): l is string => !!l);
  if (kept.length === 0) return undefined;
  return (
    <span className="share-row-desc">
      {kept.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </span>
  );
}

/** A row's name as an element, for the same reason: a phone must not cut "Everyone in …" short. */
export function wrapLabel(label: string): ReactNode {
  return <span className="share-row-label">{label}</span>;
}

/** A round icon in an avatar's place, for rows that are not a person. */
export function RowIcon({ icon }: { icon: ReactNode }) {
  return <span className="share-row-icon">{icon}</span>;
}
