/** Directory search for the mention list, debounced, newest query wins. */
import { useEffect, useRef, useState } from "react";
import { Users, Workspaces, type UserInfo } from "../api";
import { rememberUsers } from "../state/identity";
import { MIN_MENTION_QUERY } from "./mention-query";
import { useMentionScope } from "./mention-scope";

export interface PeopleSearch {
  people: UserInfo[];
  /** A request for the current query is outstanding. */
  loading: boolean;
  /** The query is too short to search; outside a document the directory needs two characters. */
  tooShort: boolean;
  /** The caller may share the document with someone who cannot open it. */
  canShare: boolean;
  /** Only people who can open the document are searched, as for a guest. */
  readersOnly: boolean;
}

/**
 * `null` searches nothing. Inside a document (MentionScope) the node is asked
 * about that document, from the bare `@`; its answer marks who can open it, and
 * a guest finds the people who can. Elsewhere the node refuses a guest the
 * directory, so a guest is not sent to ask (a refusal would land in the audit
 * log) and sees no matches. Anyone can still type an @username by hand.
 */
export function usePeopleSearch(query: string | null): PeopleSearch {
  const scope = useMentionScope();
  const docId = scope?.docId ?? null;
  const [result, setResult] = useState<{ key: string; people: UserInfo[]; canShare: boolean; readersOnly: boolean } | null>(null);
  const seq = useRef(0);
  const q = query?.trim() ?? "";
  const tooShort = query !== null && docId === null && q.length < MIN_MENTION_QUERY;
  const searchable = query !== null && !tooShort;
  const key = `${docId ?? ""}\n${q}`;

  useEffect(() => {
    if (!searchable) return;
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      const request =
        docId !== null
          ? Users.searchForMention(q, docId)
          : Workspaces.activeRole()
              .catch(() => null)
              .then((role) => (role === "guest" ? { users: [] } : Users.search(q)))
              .then((r) => ({ ...r, can_share: false, readers_only: false }));
      request
        .then((r) => {
          if (mine !== seq.current) return;
          rememberUsers(r.users);
          setResult({ key, people: r.users, canShare: r.can_share, readersOnly: !!r.readers_only });
        })
        .catch(() => mine === seq.current && setResult({ key, people: [], canShare: false, readersOnly: false }));
    }, 150);
    return () => clearTimeout(timer);
  }, [key, q, docId, searchable]);

  if (!searchable) return { people: [], loading: false, tooShort, canShare: false, readersOnly: false };
  // The previous answer stays up while the next one is on its way, so the list does not flicker.
  return {
    people: result?.people ?? [],
    loading: result?.key !== key,
    tooShort: false,
    canShare: result?.canShare ?? false,
    readersOnly: result?.readersOnly ?? false,
  };
}
