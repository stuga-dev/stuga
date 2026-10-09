/**
 * A workspace's members and roles. Owners manage everything, including roles;
 * admins move people between member and guest. Removal revokes the person's live
 * connections and the agent keys they minted here, so it is confirmed first.
 * Owners and admins add people who already have an account by picking them from
 * a search. Invite links are how anyone new gets an account on this server: each
 * admits a set number of people or anyone holding it, lapses or not, and can be revoked here.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { VStack } from "@astryxdesign/core/VStack";
import { useToast } from "@astryxdesign/core/Toast";
import { Link2Off, Link as LinkIcon, Trash2, UserPlus, Users as UsersIcon } from "lucide-react";
import { LoadFailed } from "../../ui/LoadFailed";
import { useSettingsScope } from "./SettingsLayout";
import { InviteLinkDialog } from "./InviteLinkDialog";
import { PageColumn } from "../../ui/PageColumn";
import { PersonPicker, type PersonItem } from "../../ui/PersonPicker";
import { Workspaces, type InviteInfo, type MemberInfo } from "../../api";
import type { WorkspaceRole } from "@stuga/protocol/domain/roles";
import { errorMessage } from "../../lib/http/client";
import { relativeTime, versionLabel } from "../../lib/format";
import { t, type MessageKey } from "../../i18n/i18n";

const ROLE_LABEL: Record<WorkspaceRole, MessageKey> = {
  owner: "settings.roles.owner",
  admin: "settings.roles.admin",
  member: "settings.roles.member",
  guest: "settings.roles.guest",
};
const ROLE_VARIANT: Record<WorkspaceRole, "purple" | "blue" | "neutral" | "green"> = {
  owner: "purple",
  admin: "blue",
  member: "neutral",
  guest: "green",
};

/** Who a link admits, in the words of the row that lists it. */
function admitsLabel(invite: InviteInfo): string {
  return invite.max_uses === null ? t("settings.members.admitsAnyone") : t("settings.members.admits", { count: invite.max_uses });
}

/** "Not used yet · expires Sep 18, 2:32 PM · created by Liv 3d ago" */
function describeInvite(invite: InviteInfo, creator: string): string {
  const used =
    invite.use_count === 0
      ? t("settings.members.notUsed")
      : invite.max_uses === null
        ? t("settings.members.usedTimes", { count: invite.use_count })
        : t("settings.members.usedOf", { count: invite.use_count, max: invite.max_uses });
  const expires = invite.expires_at
    ? t("settings.members.expires", { date: versionLabel(invite.expires_at) })
    : t("settings.members.neverExpires");
  const created = t("settings.members.createdBy", { name: creator, time: relativeTime(invite.created_at) });
  return [used, expires, created].join(" · ");
}

export function WorkspaceMembers() {
  const toast = useToast();
  const { isReady, workspace, canManage, isOwner, me } = useSettingsScope();
  const workspaceId = workspace?.workspace_id ?? null;
  const [members, setMembers] = useState<MemberInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [candidate, setCandidate] = useState<PersonItem | null>(null);
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("member");
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [invites, setInvites] = useState<InviteInfo[] | null>(null);
  const [invitesFailed, setInvitesFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  /** The member the removal confirmation is open for; null when it is closed. */
  const [removing, setRemoving] = useState<MemberInfo | null>(null);

  const reload = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const { members } = await Workspaces.members(workspaceId);
      setFailed(false);
      setMembers(members);
    } catch {
      setFailed(true);
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Only owners and admins may list links; a failure costs the list, not the page.
  const reloadInvites = useCallback(async () => {
    if (!workspaceId || !canManage) return;
    try {
      const { invites } = await Workspaces.listInvites(workspaceId);
      setInvitesFailed(false);
      setInvites(invites);
    } catch {
      setInvitesFailed(true);
    }
  }, [workspaceId, canManage]);

  useEffect(() => {
    void reloadInvites();
  }, [reloadInvites]);

  if (!isReady || !workspace) {
    return (
      <PageColumn>
        <VStack gap={2} hAlign="center" style={{ paddingTop: "20vh" }}>
          <Spinner label={t("common.loading")} />
        </VStack>
      </PageColumn>
    );
  }
  if (failed) {
    return (
      <PageColumn>
        <LoadFailed
          icon={<UsersIcon size={28} />}
          title={t("settings.members.loadFailed")}
          onRetry={() => void reload()}
        />
      </PageColumn>
    );
  }
  if (!members) {
    return (
      <PageColumn>
        <VStack gap={2} hAlign="center" style={{ paddingTop: "20vh" }}>
          <Spinner label={t("settings.members.loading")} />
        </VStack>
      </PageColumn>
    );
  }

  async function addPerson() {
    if (!workspaceId || !candidate) return;
    setAdding(true);
    try {
      await Workspaces.invite(workspaceId, { alias: candidate.id }, inviteRole);
      // The route adds an existing account at once; nothing is sent.
      toast({ body: t("settings.members.added", { name: candidate.label, role: inviteRole }), type: "info" });
      setCandidate(null);
      await reload();
    } catch (e) {
      toast({ body: errorMessage(e, t("settings.members.addFailed")), type: "error" });
    } finally {
      setAdding(false);
    }
  }

  async function revokeLink(invite: InviteInfo) {
    if (!workspaceId) return;
    try {
      await Workspaces.revokeInvite(workspaceId, invite.token_hash);
      toast({ body: t("settings.members.linkRevoked"), type: "info" });
      await reloadInvites();
    } catch (e) {
      toast({ body: errorMessage(e, t("settings.members.revokeFailed")), type: "error" });
    }
  }

  async function changeRole(alias: string, role: WorkspaceRole) {
    if (!workspaceId) return;
    try {
      await Workspaces.setRole(workspaceId, alias, role);
      await reload();
    } catch (e) {
      toast({ body: errorMessage(e, t("settings.members.roleFailed")), type: "error" });
    }
  }

  async function remove(alias: string) {
    if (!workspaceId) return;
    const self = alias === me;
    setRemoving(null);
    try {
      await Workspaces.remove(workspaceId, alias);
      toast({ body: self ? t("settings.members.left") : t("settings.members.removed"), type: "info" });
      if (self) {
        window.location.assign("/");
        return;
      }
      await reload();
    } catch (e) {
      // One endpoint backs both leaving and removing.
      const fallback = self ? t("settings.members.leaveFailed") : t("settings.members.removeFailed");
      toast({ body: errorMessage(e, fallback), type: "error" });
    }
  }

  // Which roles the current caller may assign to a given target.
  function assignableRoles(target: MemberInfo): WorkspaceRole[] {
    if (isOwner) return ["owner", "admin", "member", "guest"];
    // Admins may only move members ↔ guests.
    if (target.role === "member" || target.role === "guest") return ["member", "guest"];
    return [target.role];
  }

  /** Whoever created a link, as the member list names them; the creator may since have left. */
  function creatorName(alias: string): string {
    const m = members?.find((x) => x.alias === alias);
    return m ? m.display_name || m.username || m.email || alias : t("settings.members.formerMember");
  }

  return (
    <PageColumn>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center">
          <Heading level={2}>{t("settings.members.heading")}</Heading>
          {/* Labelled by what it counts, since guests are in the list too. */}
          <Badge
            variant="neutral"
            label={t("settings.members.count", { count: members.length })}
            icon={<UsersIcon size={13} />}
          />
        </HStack>

        {canManage && (
          <HStack gap={2} vAlign="end">
            <StackItem size="fill">
              <PersonPicker
                label={t("settings.members.addPeople")}
                search={(q, signal) => Workspaces.memberCandidates(workspace.workspace_id, q, { signal }).then((r) => r.users)}
                value={candidate}
                onChange={setCandidate}
                emptySearchResultsText={t("settings.members.noMatch")}
              />
            </StackItem>
            <Selector
              label={t("settings.members.role")}
              width={130}
              value={inviteRole}
              onChange={(v) => setInviteRole(v as WorkspaceRole)}
              options={
                isOwner
                  ? [
                      { value: "member", label: t("settings.roles.member") },
                      { value: "guest", label: t("settings.roles.guest") },
                      { value: "admin", label: t("settings.roles.admin") },
                    ]
                  : [
                      { value: "member", label: t("settings.roles.member") },
                      { value: "guest", label: t("settings.roles.guest") },
                    ]
              }
            />
            <Button
              label={t("settings.members.add")}
              variant="secondary"
              icon={<UserPlus size={15} />}
              onClick={addPerson}
              isDisabled={!candidate}
              isLoading={adding}
            />
          </HStack>
        )}

        <ul className="member-list">
          {members.map((m) => {
            const canEditThis =
              canManage && !(m.role === "owner" && members.filter((x) => x.role === "owner").length <= 1);
            const canRemoveThis =
              m.alias === me ||
              (canManage && !(isOwner === false && (m.role === "admin" || m.role === "owner")));
            return (
              <li key={m.alias} className="member-row">
                <VStack gap={0}>
                  <Text>{m.display_name || m.username || m.email || m.alias}</Text>
                  {m.display_name && (m.username || m.email) && (
                    <Text size="sm" color="secondary">{m.username ? `@${m.username}` : m.email}</Text>
                  )}
                </VStack>
                <HStack gap={2} vAlign="center">
                  {canEditThis ? (
                    <Selector
                      label={t("settings.members.role")}
                      isLabelHidden
                      size="sm"
                      width={130}
                      value={m.role}
                      onChange={(v) => changeRole(m.alias, v as WorkspaceRole)}
                      options={assignableRoles(m).map((r) => ({ value: r, label: t(ROLE_LABEL[r]) }))}
                    />
                  ) : (
                    <Badge variant={ROLE_VARIANT[m.role]} label={t(ROLE_LABEL[m.role])} />
                  )}
                  {canRemoveThis && (
                    <IconButton
                      label={m.alias === me ? t("settings.members.leave") : t("settings.members.removeNamed", { name: m.display_name || m.username || m.email || m.alias })}
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 size={16} />}
                      onClick={() => setRemoving(m)}
                    />
                  )}
                </HStack>
              </li>
            );
          })}
        </ul>

        {canManage && workspaceId && (
          <VStack gap={2}>
            <HStack justify="between" vAlign="center" gap={2}>
              <Heading level={3}>{t("settings.members.invitesHeading")}</Heading>
              <Button
                label={t("settings.invite.createLink")}
                variant="secondary"
                icon={<LinkIcon size={15} />}
                onClick={() => setLinkDialogOpen(true)}
              />
            </HStack>
            <Text color="secondary">{t("settings.members.invitesNote")}</Text>
            {invitesFailed ? (
              <Text size="sm" color="secondary">
                {t("settings.members.invitesFailed")}
              </Text>
            ) : invites && invites.length === 0 ? (
              <Text size="sm" color="secondary">
                {t("settings.members.noLinks")}
              </Text>
            ) : invites ? (
              <List hasDividers density="compact">
                {invites.map((link) => (
                  <ListItem
                    key={link.token_hash}
                    label={[t(ROLE_LABEL[link.role]), admitsLabel(link), ...(link.token_hint ? [t("settings.members.endsIn", { hint: link.token_hint })] : [])].join(" · ")}
                    description={describeInvite(link, creatorName(link.created_by))}
                    endContent={
                      <IconButton
                        label={t("settings.members.revokeLink")}
                        variant="ghost"
                        size="sm"
                        icon={<Link2Off size={16} />}
                        onClick={() => void revokeLink(link)}
                      />
                    }
                  />
                ))}
              </List>
            ) : null}
            <InviteLinkDialog
              isOpen={linkDialogOpen}
              workspaceId={workspaceId}
              canInviteAdmin={isOwner}
              onCreated={() => void reloadInvites()}
              onClose={() => setLinkDialogOpen(false)}
            />
          </VStack>
        )}
      </VStack>

      {/* Names the person and the workspace: the icon means "leave" on your own row, and rows are close together. */}
      <AlertDialog
        isOpen={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={
          removing?.alias === me
            ? t("settings.members.leaveTitle", { workspace: workspace.name })
            : removing
              ? t("settings.members.removeTitle", {
                  name: removing.display_name || removing.username || removing.email || removing.alias,
                  workspace: workspace.name,
                })
              : t("settings.members.removeSomeoneTitle", { workspace: workspace.name })
        }
        description={
          removing?.alias === me
            ? t("settings.members.leaveDescription")
            : t("settings.members.removeDescription")
        }
        actionLabel={removing?.alias === me ? t("settings.members.leave") : t("common.remove")}
        actionVariant="destructive"
        onAction={() => removing && remove(removing.alias)}
      />
    </PageColumn>
  );
}
