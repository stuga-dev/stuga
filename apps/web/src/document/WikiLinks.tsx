/**
 * The wiki around an open page: the pages that link to it or cite it, under its text, and, above it,
 * the pages it cites that changed after it was approved, which a person who can edit it may mark as
 * checked. Both come from the node as the reader reads the workspace: a page they cannot open is
 * neither named nor counted.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { Database, FileText } from "lucide-react";
import type { WikiLinkKind } from "@stuga/protocol/domain/wiki";
import { Wiki, type DocWikiLinks } from "../api";
import { errorMessage } from "../lib/http/client";
import { useToast } from "../ui/use-toast";
import { t, type MessageKey } from "../i18n/i18n";
import { folderPathLabel } from "../wiki/names";

/** The page's links as the node gives them, read once it opens; null until they arrive, or when they cannot. */
export function useDocWikiLinks(docId: string): { links: DocWikiLinks | null; set: (next: DocWikiLinks) => void } {
  const [links, setLinks] = useState<DocWikiLinks | null>(null);
  useEffect(() => {
    let alive = true;
    setLinks(null);
    // Nothing to show is the same as not knowing: the page opens either way.
    Wiki.links(docId).then(
      (got) => alive && setLinks(got),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [docId]);
  const set = useCallback((next: DocWikiLinks) => setLinks(next), []);
  return { links, set };
}

/** Above the text: what it cites changed since, each a link to that page, and Mark as checked for whoever may. */
export function NeedsCheckingBanner({ docId, links, onChange }: { docId: string; links: DocWikiLinks; onChange: (next: DocWikiLinks) => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (links.needs_checking.length === 0) return null;

  async function markChecked() {
    setBusy(true);
    try {
      onChange(await Wiki.markChecked(docId));
      toast({ body: t("document.wiki.markedChecked"), type: "info" });
    } catch (e) {
      toast({ body: errorMessage(e, t("document.wiki.markFailed")), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Banner
      status="warning"
      title={t("document.wiki.needsChecking")}
      description={
        <VStack gap={1}>
          <Text>{t("document.wiki.changedSince", { count: links.needs_checking.length })}</Text>
          <HStack gap={3} wrap="wrap">
            {links.needs_checking.map((s) => (
              <Link
                key={s.doc_id}
                href={`/doc/${s.doc_id}`}
                hasUnderline
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  nav(`/doc/${s.doc_id}`);
                }}
              >
                {s.title || t("common.untitled")}
              </Link>
            ))}
          </HStack>
        </VStack>
      }
      endContent={
        links.can_mark_checked ? (
          <Button label={t("document.wiki.markChecked")} variant="secondary" size="sm" isDisabled={busy} onClick={() => void markChecked()} />
        ) : undefined
      }
    />
  );
}

/** How a page names this one. */
function kindKey(kinds: readonly WikiLinkKind[]): MessageKey {
  if (kinds.includes("link") && kinds.includes("citation")) return "document.wiki.kind.both";
  return kinds.includes("citation") ? "document.wiki.kind.citation" : "document.wiki.kind.link";
}

/** Under the text: the pages the reader can open that link to it or cite it. */
export function LinkedFrom({ links }: { links: DocWikiLinks }) {
  const nav = useNavigate();
  if (links.linked_from.length === 0) return null;
  return (
    <section className="doc-backlinks editor-shell" aria-label={t("document.wiki.linkedFrom")}>
      <List hasDividers density="compact" header={<Heading level={3}>{t("document.wiki.linkedFrom")}</Heading>}>
        {links.linked_from.map((p) => (
          <ListItem
            key={p.doc_id}
            label={p.title || t("common.untitled")}
            startContent={p.doc_type === "database" ? <Database size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
            onClick={() => nav(`/doc/${p.doc_id}`)}
            description={
              <Text type="supporting" color="secondary" maxLines={1}>
                {p.path && p.path.length > 0 ? `${t(kindKey(p.kinds))} · ${folderPathLabel(p.path)}` : t(kindKey(p.kinds))}
              </Text>
            }
          />
        ))}
      </List>
      {links.linked_from_truncated && (
        <Text type="supporting" color="secondary">
          {t("document.wiki.linkedFromFirst", { count: links.linked_from.length })}
        </Text>
      )}
    </section>
  );
}
