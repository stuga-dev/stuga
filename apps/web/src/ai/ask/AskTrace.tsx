/**
 * The steps used to produce an answer, collapsed until the reader opens them.
 * A database step keeps the SQL it ran: it is the one place a reader can check
 * which column and unit a computed answer used.
 */
import { Code } from "@astryxdesign/core/Code";
import type { AskStep } from "@stuga/protocol/api/ask";
import { Database, FileText, List, Search } from "lucide-react";

function stepLine(s: AskStep): { icon: React.ReactNode; text: string } {
  if (s.kind === "search") {
    return {
      icon: <Search size={13} aria-hidden />,
      text: `Searched for “${s.query}” — ${s.hits} result${s.hits === 1 ? "" : "s"}`,
    };
  }
  if (s.kind === "read") {
    return {
      icon: <FileText size={13} aria-hidden />,
      text: `Read “${s.title || "Untitled"}”`,
    };
  }
  if (s.kind === "query") {
    return {
      icon: <Database size={13} aria-hidden />,
      text: `Checked “${s.title || "Untitled"}” — ${s.rows} row${s.rows === 1 ? "" : "s"}`,
    };
  }
  const scope = s.query ? ` matching “${s.query}”` : "";
  const docs = `${s.count} document${s.count === 1 ? "" : "s"}`;
  const folders = s.folders ? ` and ${s.folders} folder${s.folders === 1 ? "" : "s"}` : "";
  return { icon: <List size={13} aria-hidden />, text: `Looked through ${docs}${folders}${scope}` };
}

export function AskTrace({ steps, isWorking }: { steps: AskStep[]; isWorking?: boolean }) {
  if (steps.length === 0) return null;

  return (
    <details className="ask-trace">
      <summary>{isWorking ? "Looking through your documents…" : "How this answer was found"}</summary>
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
