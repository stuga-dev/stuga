/**
 * Create an invite link: who it admits, how many times, and for how long. The
 * link is shown once, in the same dialog, since the node keeps only its hash.
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

/** How long a new link works, in days; "never" keeps it working until someone revokes it. */
type LinkExpiry = "1" | "7" | "30" | "never";
/** How many people a new link admits; "unlimited" admits anyone holding it. */
type LinkUses = "1" | "5" | "10" | "25" | "unlimited";

const ROLE_OPTIONS: { value: InviteRole; label: string; description: string }[] = [
  { value: "member", label: "Member", description: "Sees what is shared with the workspace." },
  { value: "guest", label: "Guest", description: "Sees only what is shared with them." },
  { value: "admin", label: "Admin", description: "A member who also manages people and links." },
];

const USES_OPTIONS: { value: LinkUses; label: string }[] = [
  { value: "1", label: "Once" },
  { value: "5", label: "5 times" },
  { value: "10", label: "10 times" },
  { value: "25", label: "25 times" },
  { value: "unlimited", label: "No limit" },
];

const EXPIRY_OPTIONS: { value: LinkExpiry; label: string }[] = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "never", label: "Never" },
];

/** What a link does, in one sentence: "Admits one person as a member. Expires in 7 days." */
function linkSummary(role: InviteRole, uses: LinkUses, expiry: LinkExpiry): string {
  const who = uses === "1" ? "one person" : uses === "unlimited" ? "anyone with the link" : `up to ${uses} people`;
  const as = role === "admin" ? "an admin" : `a ${role}`;
  const lapses = expiry === "never" ? "Works until revoked." : `Expires in ${expiry === "1" ? "1 day" : `${expiry} days`}.`;
  return `Admits ${who} as ${as}. ${lapses}`;
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
  const [created, setCreated] = useState<{ url: string; summary: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setRole("member");
    setUses("1");
    setExpiry("7");
    setCreated(null);
    setCopied(false);
  }, [isOpen]);

  // An admin link admits one person; the node refuses any other.
  const effectiveUses = role === "admin" ? "1" : uses;

  function close() {
    if (!creating) onClose();
  }

  async function create() {
    setCreating(true);
    try {
      const { join_url } = await Workspaces.createInvite(workspaceId, {
        role,
        ...(effectiveUses === "unlimited" ? {} : { max_uses: Number(effectiveUses) }),
        ...(expiry === "never" ? {} : { expires_in_days: Number(expiry) }),
      });
      setCreated({ url: join_url, summary: linkSummary(role, effectiveUses, expiry) });
      onCreated();
      await copy(join_url);
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't create invite link."), type: "error" });
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
            title={created ? "Invite link created" : "Create invite link"}
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
                    <TextInput label="Invite link" isLabelHidden width="100%" value={created.url} onChange={() => {}} isReadOnly />
                  </StackItem>
                  <Button
                    label={copied ? "Copied" : "Copy"}
                    variant="secondary"
                    icon={copied ? <Check size={15} /> : <Copy size={15} />}
                    onClick={() => void copy(created.url)}
                  />
                </HStack>
                <Text size="sm" color="secondary">
                  This link isn’t shown again once you close this.
                </Text>
              </VStack>
            ) : (
              <VStack gap={4}>
                <Selector
                  label="Joins as"
                  value={role}
                  onChange={(v) => setRole(v as InviteRole)}
                  options={canInviteAdmin ? ROLE_OPTIONS : ROLE_OPTIONS.filter((o) => o.value !== "admin")}
                />
                <HStack gap={3}>
                  <StackItem size="fill">
                    <Selector
                      label="Can be used"
                      width="100%"
                      value={effectiveUses}
                      onChange={(v) => setUses(v as LinkUses)}
                      options={USES_OPTIONS}
                      isDisabled={role === "admin"}
                      disabledMessage="An admin link can be used once."
                    />
                  </StackItem>
                  <StackItem size="fill">
                    <Selector
                      label="Expires after"
                      width="100%"
                      value={expiry}
                      onChange={(v) => setExpiry(v as LinkExpiry)}
                      options={EXPIRY_OPTIONS}
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
                <Button label="Done" variant="primary" onClick={close} />
              ) : (
                <>
                  <Button label="Cancel" variant="ghost" onClick={close} isDisabled={creating} />
                  <Button label="Create link" variant="primary" onClick={() => void create()} isLoading={creating} />
                </>
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
