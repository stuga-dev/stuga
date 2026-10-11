/**
 * The document @mentions are typed in. Inside one, the people list is asked
 * about that document: `@` alone suggests the people who can open it, and
 * someone who cannot is marked. Picking them says so, with Share for a person
 * who may share the document, since a mention never grants access and they
 * will not be notified.
 */
import { createContext, useCallback, useContext } from "react";
import { Button } from "@astryxdesign/core/Button";
import { useToast } from "../ui/use-toast";
import type { UserInfo } from "../api";
import { t } from "../i18n/i18n";

export interface MentionScope {
  docId: string;
  /** Opens the document's Share dialog. */
  share: () => void;
}

const Ctx = createContext<MentionScope | null>(null);

export const MentionScopeProvider = Ctx.Provider;

export function useMentionScope(): MentionScope | null {
  return useContext(Ctx);
}

/** What to tell the author once they picked someone; nothing for a person who can open the document. */
export function useMentionPicked(): (person: UserInfo, canShare: boolean) => void {
  const scope = useMentionScope();
  const toast = useToast();
  return useCallback(
    (person, canShare) => {
      if (person.can_open !== false) return;
      const name = person.display_name || person.username || person.alias;
      toast({
        body: t("document.mentions.cantOpenNotice", { name }),
        type: "info",
        endContent:
          canShare && scope ? <Button label={t("common.share")} variant="ghost" size="sm" onClick={scope.share} /> : undefined,
      });
    },
    [scope, toast],
  );
}
