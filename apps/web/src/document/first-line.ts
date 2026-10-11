/**
 * The document's first line, which names a document nobody renamed. The node
 * derives the same name when it indexes the document (doc-actor text-extract:
 * deriveTitle over extractText), seconds or a minute later; the header shows
 * this one meanwhile, so the name follows the typing.
 */
import { useEffect, useState } from "react";
import * as Y from "yjs";
import { getStugaSchema } from "@stuga/crdt-ops";

/** As the node keeps it. */
const TITLE_MAX = 200;

/** Typing settles this long before the name is read again. */
const SETTLE_MS = 300;

/** The first non-empty line of the document's text, trimmed; "" when it has none. */
export function firstLine(doc: Y.Doc): string {
  const line: string[] = [];
  let found = "";
  // Pieces of one line are concatenated; a block's end or a hard break ends the line.
  const endLine = (): boolean => {
    const text = line.join("").trim();
    line.length = 0;
    if (text) found = text;
    return text !== "";
  };
  const walk = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText): boolean => {
    if (node instanceof Y.XmlText) {
      for (const op of node.toDelta() as Array<{ insert?: unknown }>) {
        if (typeof op.insert !== "string") continue;
        const parts = op.insert.split("\n");
        for (let i = 0; i < parts.length; i++) {
          if (i > 0 && endLine()) return true;
          line.push(parts[i]!);
        }
      }
      return false;
    }
    for (let i = 0; i < node.length; i++) {
      const child = node.get(i);
      if ((child instanceof Y.XmlText || child instanceof Y.XmlElement) && walk(child)) return true;
    }
    if (node instanceof Y.XmlElement && (node.nodeName === "hardBreak" || getStugaSchema().nodes[node.nodeName]?.isBlock === true)) {
      return endLine();
    }
    return false;
  };
  if (!walk(doc.getXmlFragment("default"))) endLine();
  return found.slice(0, TITLE_MAX);
}

/** The first line of `doc` as it is typed, read again once typing settles; "" until there is one. */
export function useFirstLine(doc: Y.Doc | null, enabled: boolean): string {
  const [line, setLine] = useState("");
  useEffect(() => {
    if (!doc || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => setLine(firstLine(doc));
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(read, SETTLE_MS);
    };
    read();
    doc.on("update", onUpdate);
    return () => {
      clearTimeout(timer);
      doc.off("update", onUpdate);
    };
  }, [doc, enabled]);
  return enabled ? line : "";
}
