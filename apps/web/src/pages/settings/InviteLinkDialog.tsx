/**
 * Create an invite link: who it admits, how many times, for how long, and, while
 * the remote address is on, whether it is for someone on this network or anywhere
 * (ui/LinkAddress.tsx). The link is shown once, in the same dialog, since the
 * node keeps only its hash. One for anywhere opens at the remote address, where a
 * link with no limit or no expiry would be an open sign-up: those are not offered.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Selector } from "@astryxdesign/core/Selector";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useToast } from "@astryxdesign/core/Toast";
import { Check, Copy } from "lucide-react";
import { Workspaces } from "../../api";
import type { InviteRole } from "@stuga/protocol/domain/roles";
import { errorMessage } from "../../lib/http/client";
import { copyText } from "../../lib/clipboard";
import { atRemoteAddress } from "../../lib/session/auth-config";
import { t } from "../../i18n/i18n";
import { LinkAddressSwitch, LocalOnlyNote, useLinkAddresses, type LinkAddress } from "../../ui/LinkAddress";

/** How long a new link works, in days; "never" keeps it working until someone revokes it. */
type LinkExpiry = "1" | "7" | "30" | "never";
/** How many people a new link admits; "unlimited" admits anyone holding it. */
type LinkUses = "1" | "5" | "10" | "25" | "unlimited";

function roleOptions(): { value: InviteRole; label: string; description: string }[] {
  return [
    { value: "member", label: t("settings.roles.member"), description: t("settings.invite.memberNote") },
    { value: "guest", label: t("settings.roles.guest"), description: t("settings.invite.guestNote") },
    { value: "admin", label: t("settings.roles.admin"), description: t("settings.invite.adminNote") },
  ];
}

const USES: readonly LinkUses[] = ["1", "5", "10", "25", "unlimited"];
const EXPIRIES: readonly LinkExpiry[] = ["1", "7", "30", "never"];

function usesLabel(uses: LinkUses): string {
  return uses === "unlimited" ? t("settings.invite.noLimit") : t("settings.invite.uses", { count: Number(uses) });
}

function expiryLabel(expiry: LinkExpiry): string {
  return expiry === "never" ? t("settings.invite.never") : t("settings.invite.days", { count: Number(expiry) });
}

/** What a link does, in one sentence: "Admits one person as a member. Expires in 7 days." */
function linkSummary(role: InviteRole, uses: LinkUses, expiry: LinkExpiry): string {
  return t("settings.invite.summary", {
    who: uses === "1" ? "one" : uses === "unlimited" ? "unlimited" : "other",
    count: uses === "unlimited" ? 0 : Number(uses),
    role,
    expiry: expiry === "never" ? "never" : "days",
    days: expiry === "never" ? 0 : Number(expiry),
  });
}

interface InviteLinkDialogProps {
  isOpen: boolean;
  workspaceId: string;
  /** Only an owner may hand out admin. */
  canInviteAdmin: boolean;
  onCreated: () => void;
  onClose: () => void;
}

export function InviteLinkDialog({ isOpen, workspaceId, canInviteAdmin, onCreated, onClose }: InviteLinkDialogProps) {
  const toast = useToast();
  const [role, setRole] = useState<InviteRole>("member");
  const [uses, setUses] = useState<LinkUses>("1");
  const [expiry, setExpiry] = useState<LinkExpiry>("7");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ url: string; summary: string; address: LinkAddress } | null>(null);
  const [copied, setCopied] = useState(false);
  const addresses = useLinkAddresses(isOpen);
  /** Chosen with the switch; the maker's own address until then. */
  const [picked, setPicked] = useState<LinkAddress | null>(null);
  const address: LinkAddress = picked ?? addresses?.default ?? (atRemoteAddress() ? "remote" : "local");

  useEffect(() => {
    if (!isOpen) return;
    setRole("member");
    setUses("1");
    setExpiry("7");
    setPicked(null);
    setCreated(null);
    setCopied(false);
  }, [isOpen]);

  /** For someone anywhere: one person and seven days again, the limits that link must have. */
  function pick(next: LinkAddress) {
    setPicked(next);
    if (next === "remote") {
      setUses("1");
      setExpiry("7");
    }
  }

  // The addresses arrive after the dialog opens: a choice made before then that a link for anywhere
  // cannot have falls back to the default limits too.
  useEffect(() => {
    if (address !== "remote") return;
    setUses((u) => (u === "unlimited" ? "1" : u));
    setExpiry((e) => (e === "never" ? "7" : e));
  }, [address]);

  // An admin link admits one person; the node refuses any other.
  const effectiveUses = role === "admin" ? "1" : uses;
  const remote = address === "remote";
  const usesOptions = USES.filter((u) => !remote || u !== "unlimited").map((u) => ({ value: u, label: usesLabel(u) }));
  const expiryOptions = EXPIRIES.filter((e) => !remote || e !== "never").map((e) => ({ value: e, label: expiryLabel(e) }));
  const roles = roleOptions();

  function close() {
    if (!creating) onClose();
  }

  async function create() {
    setCreating(true);
    try {
      const { join_url } = await Workspaces.createInvite(workspaceId, {
        role,
        max_uses: effectiveUses === "unlimited" ? null : Number(effectiveUses),
        expires_in_days: expiry === "never" ? null : Number(expiry),
        // Only when there is a choice: otherwise the node points it where its maker is, as it always has.
        ...(addresses?.remote ? { address } : {}),
      });
      setCreated({ url: join_url, summary: linkSummary(role, effectiveUses, expiry), address });
      onCreated();
      await copy(join_url);
    } catch (e) {
      toast({ body: errorMessage(e, t("settings.invite.createFailed")), type: "error" });
    } finally {
      setCreating(false);
    }
  }

  /** When no copy works at all the link stays in the field to copy by hand. */
  async function copy(url: string) {
    setCopied(await copyText(url));
  }

  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && close()} purpose="form" width={440}>
      <Layout
        header={
          <DialogHeader
            title={created ? t("settings.invite.createdTitle") : t("settings.invite.createTitle")}
            subtitle={created?.summary}
            onOpenChange={(o) => !o && close()}
          />
        }
        content={
          <LayoutContent>
            {created ? (
              <VStack gap={2}>
                <HStack gap={2} vAlign="center">
                  <StackItem size="fill">
                    <TextInput label={t("settings.invite.linkLabel")} isLabelHidden width="100%" value={created.url} onChange={() => {}} isReadOnly />
                  </StackItem>
                  <Button
                    label={copied ? t("common.copied") : t("common.copy")}
                    variant="secondary"
                    icon={copied ? <Check size={15} /> : <Copy size={15} />}
                    onClick={() => void copy(created.url)}
                  />
                </HStack>
                <LocalOnlyNote addresses={addresses} address={created.address} />
                <Text size="sm" color="secondary">
                  {t("settings.invite.notShownAgain")}
                </Text>
              </VStack>
            ) : (
              <VStack gap={4}>
                <LinkAddressSwitch addresses={addresses} value={address} onChange={pick} isDisabled={creating} />
                <Selector
                  label={t("settings.invite.joinsAs")}
                  value={role}
                  onChange={(v) => setRole(v as InviteRole)}
                  options={canInviteAdmin ? roles : roles.filter((o) => o.value !== "admin")}
                />
                <HStack gap={3}>
                  <StackItem size="fill">
                    <Selector
                      label={t("settings.invite.canBeUsed")}
                      width="100%"
                      value={effectiveUses}
                      onChange={(v) => setUses(v as LinkUses)}
                      options={usesOptions}
                      isDisabled={role === "admin"}
                      disabledMessage={t("settings.invite.adminOnce")}
                    />
                  </StackItem>
                  <StackItem size="fill">
                    <Selector
                      label={t("settings.invite.expiresAfter")}
                      width="100%"
                      value={expiry}
                      onChange={(v) => setExpiry(v as LinkExpiry)}
                      options={expiryOptions}
                    />
                  </StackItem>
                </HStack>
              </VStack>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              {created ? (
                <Button label={t("common.done")} variant="primary" onClick={close} />
              ) : (
                <>
                  <Button label={t("common.cancel")} variant="ghost" onClick={close} isDisabled={creating} />
                  <Button label={t("settings.invite.createLink")} variant="primary" onClick={() => void create()} isLoading={creating} />
                </>
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
