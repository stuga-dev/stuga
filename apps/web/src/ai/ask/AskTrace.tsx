/**
 * The steps used to produce an answer, collapsed until the reader opens them.
 * A database step keeps the SQL it ran: it is the one place a reader can check
 * which column and unit a computed answer used.
 */
import { Code } from "@astryxdesign/core/Code";
import type { AskStep } from "@stuga/protocol/api/ask";
import { Database, FileText, List, Search } from "lucide-react";
import { t } from "../../i18n/i18n";
import { listOf } from "../../lib/format";

function stepLine(s: AskStep): { icon: React.ReactNode; text: string } {
  if (s.kind === "search") {
    // A step stored before titles were recorded has only the count.
    const text = !s.titles
      ? t("ai.trace.searched", { query: s.query, hits: s.hits })
      : s.titles.length
        ? t("ai.trace.searchedFound", { query: s.query, titles: listOf(s.titles.map((x) => x || t("common.untitled"))) })
        : t("ai.trace.searchedNothing", { query: s.query });
    return { icon: <Search size={13} aria-hidden />, text };
  }
  if (s.kind === "read") {
    return {
      icon: <FileText size={13} aria-hidden />,
      text: t("ai.trace.read", { title: s.title || t("common.untitled") }),
    };
  }
  if (s.kind === "query") {
    return {
      icon: <Database size={13} aria-hidden />,
      text: t("ai.trace.checked", { title: s.title || t("common.untitled"), rows: s.rows }),
    };
  }
  const values = { count: s.count, folders: s.folders, query: s.query };
  const text = s.folders
    ? s.query
      ? t("ai.trace.listedWithFoldersMatching", values)
      : t("ai.trace.listedWithFolders", values)
    : s.query
      ? t("ai.trace.listedMatching", values)
      : t("ai.trace.listed", values);
  return { icon: <List size={13} aria-hidden />, text };
}

export function AskTrace({ steps, isWorking }: { steps: AskStep[]; isWorking?: boolean }) {
  if (steps.length === 0) return null;

  return (
    <details className="ask-trace">
      <summary>{isWorking ? t("ai.trace.working") : t("ai.trace.done")}</summary>
      <ul>
        {steps.map((s, i) => {
          const { icon, text } = stepLine(s);
          return (
            <li key={i}>
              {icon}
              <span>{text}</span>
              {s.kind === "query" && (
                <Code color="secondary" size="inherit" className="ask-trace__sql">
                  {s.sql}
                </Code>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
