/**
 * The Share dialog's link row: Off, or a level for anyone with an account here who opens the link.
 * It acts at once, unlike the rest of the dialog: turning it on makes one link, a new level changes
 * it at the same address (so a link already sent keeps working), and Off ends every live link after
 * asking. People who already opened a link keep the access it gave them until someone removes it.
 */
import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { ListItem } from "@astryxdesign/core/List";
import { Selector } from "@astryxdesign/core/Selector";
import { StackItem } from "@astryxdesign/core/Stack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Link as LinkIcon } from "lucide-react";
import { Docs, type ShareLinkInfo, type ShareRole } from "../api";
import { copyText } from "../lib/clipboard";
import { errorMessage } from "../lib/http/client";
import { t, type MessageKey } from "../i18n/i18n";
import { describe, ROLE_WIDTH, RowIcon, wrapLabel } from "./share-rows";

const LINK_LABELS: Record<ShareRole, MessageKey> = {
  viewer: "library.share.canView",
  commenter: "library.share.canComment",
  editor: "library.share.canEdit",
};

export function ShareLinkSection({
  docId,
  hasComments,
  onError,
}: {
  docId: string;
  hasComments: boolean;
  onError: (message: string | null) => void;
}) {
  /** Null until listed; the newest live link is the one shown. */
  const [links, setLinks] = useState<ShareLinkInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    Docs.shareLinks(docId)
      .then((r) => alive && setLinks(r.links))
      .catch((e) => alive && onError(errorMessage(e, t("library.share.linkLoadFailed"))));
    return () => {
      alive = false;
    };
  }, [docId, onError]);

  const live = links?.[0] ?? null;

  /** Every listed link ends. */
  async function revokeAll(current: ShareLinkInfo[]): Promise<void> {
    for (const link of current) await Docs.revokeShareLink(docId, link.token_hash);
  }

  /** One link at `role`: the new one first, so a failure leaves the old one working. */
  async function mint(role: ShareRole): Promise<ShareLinkInfo | null> {
    const previous = links ?? [];
    await Docs.createShareLink(docId, { role });
    await revokeAll(previous);
    const { links: now } = await Docs.shareLinks(docId);
    setLinks(now);
    return now[0] ?? null;
  }

  async function run(action: () => Promise<void>, fallback: MessageKey) {
    setBusy(true);
    onError(null);
    try {
      await action();
    } catch (e) {
      onError(errorMessage(e, t(fallback)));
      Docs.shareLinks(docId)
        .then((r) => setLinks(r.links))
        .catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  function choose(value: string) {
    if (value === "off") {
      if (live) setConfirmingOff(true);
      return;
    }
    setConfirmingOff(false);
    if (live?.role === value) return;
    const role = value as ShareRole;
    void run(async () => {
      if (!live) return void (await mint(role));
      await Docs.setShareLinkRole(docId, live.token_hash, role);
      setLinks((await Docs.shareLinks(docId)).links);
    }, "library.share.linkFailed");
  }

  function turnOff() {
    setConfirmingOff(false);
    void run(async () => {
      await revokeAll(links ?? []);
      setLinks([]);
    }, "library.share.linkOffFailed");
  }

  /**
   * Copies the live link. The address is always shown too: the clipboard does not exist on an
   * insecure origin such as a plain-HTTP LAN address, and "Copied" appears only when it worked.
   */
  function copy() {
    if (!live) return;
    void run(async () => {
      // A link whose address the node cannot show again is replaced by one at the same level.
      const url = live.link_url ?? (await mint(live.role))?.link_url ?? null;
      if (url && (await copyText(url))) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
    }, "library.share.linkFailed");
  }

  const tiers: ShareRole[] = hasComments ? ["viewer", "commenter", "editor"] : ["viewer", "editor"];
  const options = [
    { value: "off", label: t("library.share.linkOff") },
    ...tiers.map((r) => ({ value: r, label: t(LINK_LABELS[r]) })),
  ];

  return (
    <>
      <ListItem
        label={wrapLabel(t("library.share.anyoneWithLink"))}
        description={describe([live ? t("library.share.linkOnHint") : t("library.share.linkOffHint")])}
        startContent={<RowIcon icon={<LinkIcon size={16} />} />}
        endContent={
          <Selector
            label={t("library.share.linkRole")}
            isLabelHidden
            variant="ghost"
            size="sm"
            width={ROLE_WIDTH}
            className="share-role"
            value={live ? live.role : "off"}
            isDisabled={links === null || busy}
            onChange={choose}
            options={options}
          />
        }
      />
      {confirmingOff && (
        <li className="share-confirm">
          <Banner status="warning" title={t("library.share.linkOffTitle")} description={t("library.share.linkOffBody")} collapsible={false}>
            <HStack gap={2} justify="end">
              <Button label={t("common.cancel")} variant="ghost" size="sm" onClick={() => setConfirmingOff(false)} />
              <Button label={t("library.share.linkOffAction")} variant="destructive" size="sm" onClick={turnOff} />
            </HStack>
          </Banner>
        </li>
      )}
      {live && (
        <li className="share-link-copy">
          <HStack gap={2} vAlign="center">
            <StackItem size="fill">
              <TextInput label={t("library.share.linkLabel")} isLabelHidden value={live.link_url ?? ""} isReadOnly />
            </StackItem>
            <Button
              label={copied ? t("common.copied") : t("library.options.copyLink")}
              variant="secondary"
              icon={<LinkIcon size={15} />}
              isDisabled={busy}
              onClick={copy}
            />
          </HStack>
        </li>
      )}
    </>
  );
}
