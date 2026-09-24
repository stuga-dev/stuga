/**
 * Pick one account on this node by typing part of a username or name. Behind
 * adding people to a workspace, appointing a node administrator and account
 * recovery; each passes its own search.
 */
import { useMemo, useRef } from "react";
import { Typeahead, TypeaheadItem, type SearchSource, type SearchableItem } from "@astryxdesign/core/Typeahead";
import { Search } from "lucide-react";
import type { MemberCandidate } from "../api";
import { Avatar, rememberUsers } from "../state/identity";

/** A picker row: the account rides along so choosing it needs no second lookup. */
export type PersonItem = SearchableItem<MemberCandidate>;

interface PersonPickerProps {
  label: string;
  search: (query: string, signal: AbortSignal) => Promise<MemberCandidate[]>;
  value: PersonItem | null;
  onChange: (item: PersonItem | null) => void;
  /** Aliases never offered, such as people who already hold what is being given. */
  exclude?: readonly string[];
  emptySearchResultsText?: string;
}

export function PersonPicker({ label, search, value, onChange, exclude, emptySearchResultsText }: PersonPickerProps) {
  // Read at search time, so a new function or list each render does not rebuild the source.
  const latest = useRef({ search, exclude });
  latest.current = { search, exclude };

  // Newest query wins: a slower answer to an older one is aborted, not shown.
  const source = useMemo<SearchSource<PersonItem>>(() => {
    let controller: AbortController | null = null;
    return {
      cancel() {
        controller?.abort();
      },
      async search(query) {
        controller?.abort();
        controller = new AbortController();
        try {
          const users = await latest.current.search(query, controller.signal);
          rememberUsers(users.map((u) => ({ ...u, email: null })));
          const skip = new Set(latest.current.exclude ?? []);
          return users
            .filter((u) => !skip.has(u.alias))
            .map((u) => ({ id: u.alias, label: u.display_name || u.username || u.alias, auxiliaryData: u }));
        } catch {
          return [];
        }
      },
      bootstrap: () => [],
    };
  }, []);

  return (
    <Typeahead<PersonItem>
      label={label}
      placeholder="Search by username or name"
      width="100%"
      startIcon={<Search size={15} />}
      searchSource={source}
      value={value}
      onChange={onChange}
      emptySearchResultsText={emptySearchResultsText ?? "No one matches."}
      renderItem={(item) => (
        <TypeaheadItem
          item={item}
          icon={<Avatar principal={`user:${item.id}`} size={24} />}
          description={
            item.auxiliaryData?.username && item.auxiliaryData.username !== item.label
              ? `@${item.auxiliaryData.username}`
              : undefined
          }
        />
      )}
    />
  );
}
