/**
 * The English catalog, which every other language is translated from and falls back to. One
 * file per namespace; a key is `<namespace>.<name>`, and its type comes from these imports.
 */
import activity from "./messages/en/activity.json";
import agents from "./messages/en/agents.json";
import ai from "./messages/en/ai.json";
import auth from "./messages/en/auth.json";
import comments from "./messages/en/comments.json";
import common from "./messages/en/common.json";
import database from "./messages/en/database.json";
import document from "./messages/en/document.json";
import editor from "./messages/en/editor.json";
import errors from "./messages/en/errors.json";
import format from "./messages/en/format.json";
import library from "./messages/en/library.json";
import node from "./messages/en/node.json";
import nodeAccess from "./messages/en/nodeAccess.json";
import notifications from "./messages/en/notifications.json";
import pages from "./messages/en/pages.json";
import review from "./messages/en/review.json";
import settings from "./messages/en/settings.json";
import shell from "./messages/en/shell.json";
import ui from "./messages/en/ui.json";

export const EN_NAMESPACES = {
  activity,
  agents,
  ai,
  auth,
  comments,
  common,
  database,
  document,
  editor,
  errors,
  format,
  library,
  node,
  nodeAccess,
  notifications,
  pages,
  review,
  settings,
  shell,
  ui,
};

type Namespaces = typeof EN_NAMESPACES;

export type MessageKey = {
  [N in keyof Namespaces]: `${N}.${Extract<keyof Namespaces[N], string>}`;
}[keyof Namespaces];

/** Namespaced files flattened to `<namespace>.<name>` keys. */
export function flatten(namespaces: Record<string, Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ns, messages] of Object.entries(namespaces)) {
    for (const [name, message] of Object.entries(messages)) out[`${ns}.${name}`] = message;
  }
  return out;
}

export const EN: Record<string, string> = flatten(EN_NAMESPACES);
