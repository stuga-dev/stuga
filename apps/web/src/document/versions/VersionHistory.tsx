/**
 * The version list, grouped by day and titled by time rather than by sequence
 * number. Each row shows its character counts; a version whose baseline was
 * pruned has no counts and shows none, rather than a misleading zero.
 */
import { Fragment } from "react";
import type { Version } from "../../api";
import { authorLabel, nameLoading } from "../../state/identity";
import { absoluteTime, dayLabel, fmtInt, timeOfDay, versionLabel } from "../../lib/format";

/**
 * Who made a version; null while a person's name is still loading, so no raw alias shows.
 * A restore's `restore:v<seq>` author is named by that version's time while it is still in the list.
 */
export function authorsOf(v: Version, versions: Version[]): string | null {
  if (v.authors.some((a) => !a.startsWith("restore:") && nameLoading(`user:${a}`))) return null;
  const names = v.authors.map((a) => {
    const restored = /^restore:v(\d+)$/.exec(a);
    if (!restored) return authorLabel(a);
    const source = versions.find((x) => x.seq === Number(restored[1]));
    return source ? `restored from ${versionLabel(source.ts)}` : authorLabel(a);
  });
  return names.join(", ") || "—";
}

/** Consecutive versions, newest first, under their calendar day. */
function byDay(versions: Version[]): Array<{ day: string; items: Version[] }> {
  const groups: Array<{ day: string; items: Version[] }> = [];
  for (const v of versions) {
    const day = dayLabel(v.ts);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(v);
    else groups.push({ day, items: [v] });
  }
  return groups;
}

/** `+312 −45`; "No text change" when the Markdown is identical, as after restoring an identical version. */
function ChangeCounts({ v }: { v: Version }) {
  const added = v.chars_added;
  const removed = v.chars_removed;
  if (added == null || removed == null) return null;
  const size = v.chars == null ? "" : ` · ${fmtInt(v.chars)} characters in this version`;
  if (added === 0 && removed === 0) {
    return (
      <span className="vchange vchange--none" title={`No characters added or removed${size}`}>
        No text change
      </span>
    );
  }
  return (
    <span className="vchange" title={`${fmtInt(added)} characters added, ${fmtInt(removed)} removed${size}`}>
      {added > 0 && <span className="vchange__ins">+{fmtInt(added)}</span>}
      {removed > 0 && <span className="vchange__del">−{fmtInt(removed)}</span>}
    </span>
  );
}

export function VersionHistory({
  versions,
  currentSeq,
  onOpen,
}: {
  /** Newest first. */
  versions: Version[];
  /** The version the document matches, labelled Current; null once edits moved past every one. */
  currentSeq: number | null;
  onOpen: (seq: number) => void;
}) {
  if (versions.length === 0) return <p className="empty">No versions yet.</p>;

  return (
    <div className="version-history">
      {byDay(versions).map(({ day, items }) => (
        // Keyed by seq: an out-of-order list can repeat a day label.
        <Fragment key={items[0]!.seq}>
          <h3 className="version-day">{day}</h3>
          <ul className="version-list">
            {items.map((v) => (
              <li key={v.seq}>
                <button className="version-open" onClick={() => onOpen(v.seq)} title="View and compare this version">
                  <span className="version-open__head">
                    <span className="vtime" title={absoluteTime(v.ts)}>
                      {timeOfDay(v.ts)}
                    </span>
                    <ChangeCounts v={v} />
                  </span>
                  <span className="version-open__sub">
                    {/* A blank keeps the row's height until the names arrive. */}
                    <span className="vauthors">{authorsOf(v, versions) ?? "\u00a0"}</span>
                    {v.seq === currentSeq && <span className="vcurrent">Current</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Fragment>
      ))}
    </div>
  );
}
