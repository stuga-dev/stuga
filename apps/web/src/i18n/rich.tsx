/**
 * A message with elements inside it, so a translation can move a link or a bold word to where
 * its grammar puts it: `"Open <link>Settings</link> to change it."` with
 * `{ link: (chunks) => <Link to="/settings">{chunks}</Link> }`.
 */
import { Fragment, type ReactNode } from "react";
import { formatParts, type MessageKey } from "./i18n";

export type RichValues = Record<string, ReactNode | Date | ((chunks: ReactNode[]) => ReactNode)>;

export function tRich(key: MessageKey, values: RichValues): ReactNode {
  const parts = formatParts(key, values);
  if (!Array.isArray(parts)) return parts as ReactNode;
  return parts.map((part, i) => <Fragment key={i}>{part as ReactNode}</Fragment>);
}
