/** Directory search for the mention list, debounced, newest query wins. */
import { useEffect, useRef, useState } from "react";
import { Users, type UserInfo } from "../api";
import { rememberUsers } from "../state/identity";
import { MIN_MENTION_QUERY } from "./mention-query";

export interface PeopleSearch {
  people: UserInfo[];
  /** A request for the current query is outstanding. */
  loading: boolean;
}

/**
 * `null` searches nothing. A guest's search is refused by the node, which
 * reads here as no matches: a guest can still type an @username by hand.
 */
export function usePeopleSearch(query: string | null): PeopleSearch {
  const [result, setResult] = useState<{ query: string; people: UserInfo[] } | null>(null);
  const seq = useRef(0);
  const q = query?.trim() ?? "";
  const searchable = query !== null && q.length >= MIN_MENTION_QUERY;

  useEffect(() => {
    if (!searchable) return;
    const mine = ++seq.current;
    const t = setTimeout(() => {
      Users.search(q)
        .then((r) => {
          if (mine !== seq.current) return;
          rememberUsers(r.users);
          setResult({ query: q, people: r.users });
        })
        .catch(() => mine === seq.current && setResult({ query: q, people: [] }));
    }, 150);
    return () => clearTimeout(t);
  }, [q, searchable]);

  if (!searchable) return { people: [], loading: false };
  // The previous answer stays up while the next one is on its way, so the list does not flicker.
  return { people: result?.people ?? [], loading: result?.query !== q };
}
