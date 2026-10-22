/** How the wiki's pages name people and places: an agent by the person it worked for, a folder by its path. */
import type { AuthorRef } from "@stuga/protocol/domain/wiki";
import { formatParts, t } from "../i18n/i18n";
import { aiCoauthorLabel } from "../lib/format";
import { nameList } from "../document/name-list";

/** Plain text of a rich message whose only tag is `bdi`. */
function plain(parts: unknown): string {
  return Array.isArray(parts) ? parts.join("") : String(parts);
}

/** "Liv", "Liv’s agent", "AI co-author · Liv", or the sample agent, in the reader's language. */
export function authorRefLabel(ref: AuthorRef): string {
  switch (ref.kind) {
    case "person":
      return ref.name;
    case "sample":
      return t("ui.author.sampleAgent");
    case "agent":
      return plain(formatParts("ui.author.agentOf", { name: ref.name, bdi: (chunks: unknown[]) => chunks.join("") }));
    case "coauthor":
      return `${aiCoauthorLabel()} · ${ref.name}`;
  }
}

/** Several of them as a short list, each once. */
export function authorRefList(refs: readonly AuthorRef[]): string {
  return nameList([...new Set(refs.map(authorRefLabel))]);
}

/** A folder path as a reader reads it, root first: "Policies / HR". */
export function folderPathLabel(path: readonly string[]): string {
  return path.join(" / ");
}
