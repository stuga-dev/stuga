/**
 * A workspace's members and roles. Owners manage everything, including roles;
 * admins move people between member and guest. Removal revokes the person's live
 * connections and the agent keys they minted here, so it is confirmed first, as
 * are making someone an owner and giving up your own ownership, which you cannot
 * undo yourself. The only owner cannot leave, and is told so on their row.
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
import { List, ListItem } from "@astryxdesign/core/List";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { VStack } from "@astryxdesign/core/VStack";
import { useToast } from "../../ui/use-toast";
import { Link as LinkIcon, UserPlus, Users as UsersIcon } from "lucide-react";
import { LoadFailed } from "../../ui/LoadFailed";
import { useSettingsScope } from "./SettingsLayout";
import { InviteLinkDialog } from "./InviteLinkDialog";
import { PageColumn } from "../../ui/PageColumn";
import { SettingsTitle } from "./SettingsTitle";
import { PersonPicker, type PersonItem } from "../../ui/PersonPicker";
import { Avatar, rememberUsers } from "../../state/identity";
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

/** A member as the page names them. */
function memberName(m: MemberInfo): string {
  return m.display_name || m.username || m.email || m.alias;
}

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
  const { isReady, workspace, canManage, isOwner, me, reload: scopeReload } = useSettingsScope();
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
  /** A role change waiting for its confirmation: making someone an owner, or giving up your own ownership. */
  const [pendingRole, setPendingRole] = useState<{ member: MemberInfo; role: WorkspaceRole } | null>(null);
  /** The invite link the turn-off confirmation is open for. */
  const [revoking, setRevoking] = useState<InviteInfo | null>(null);

  const reload = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const { members } = await Workspaces.members(workspaceId);
      setFailed(false);
      setMembers(members);
      // Avatars elsewhere on the page read names from the same cache, renamed members included.
      rememberUsers(members.map((m) => ({ ...m, display_name: m.display_name ?? "" })));
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
    setRevoking(null);
    try {
      await Workspaces.revokeInvite(workspaceId, invite.token_hash);
      toast({ body: t("settings.members.linkRevoked"), type: "info" });
      await reloadInvites();
    } catch (e) {
      toast({ body: errorMessage(e, t("settings.members.revokeFailed")), type: "error" });
    }
  }

  /** Making someone an owner, or giving up your own ownership, is asked first: neither can be undone from your seat. */
  function chooseRole(member: MemberInfo, role: WorkspaceRole) {
    if (role === member.role) return;
    if (role === "owner" || (member.alias === me && member.role === "owner")) setPendingRole({ member, role });
    else void changeRole(member.alias, role);
  }

  async function changeRole(alias: string, role: WorkspaceRole) {
    if (!workspaceId) return;
    setPendingRole(null);
    try {
      await Workspaces.setRole(workspaceId, alias, role);
      // Your own role decides what this page offers you.
      if (alias === me) await scopeReload();
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
    return m ? memberName(m) : t("settings.members.formerMember");
  }

  const owners = members.filter((x) => x.role === "owner").length;

  return (
    <PageColumn>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center">
          <SettingsTitle>{t("settings.members.heading")}</SettingsTitle>
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
                emptySearchText={t("settings.members.noMatch")}
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
                      { value: "admin", label: t("settings.roles.admin") },
                      { value: "member", label: t("settings.roles.member") },
                      { value: "guest", label: t("settings.roles.guest") },
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
        <Text size="sm" color="secondary">
          {t("settings.members.rolesNote")}
        </Text>

        <ul className="member-list">
          {members.map((m) => {
            const self = m.alias === me;
            const onlyOwner = m.role === "owner" && owners <= 1;
            // A menu only where there is a choice: an admin sees an owner's or another admin's role as a badge.
            const canEditThis = canManage && !onlyOwner && assignableRoles(m).length > 1;
            // An admin cannot remove an admin or an owner; the only owner cannot leave.
            const canRemoveThis = !onlyOwner && (self || (canManage && !(isOwner === false && (m.role === "admin" || m.role === "owner"))));
            return (
              <li key={m.alias} className="member-row">
                <HStack gap={3} vAlign="center">
                  {/* i18n-exempt: a principal id */}
                  <Avatar principal={`user:${m.alias}`} size={28} />
                  <VStack gap={0}>
                    <Text>{memberName(m)}</Text>
                    {m.display_name && (m.username || m.email) && (
                      <Text size="sm" color="secondary">{m.username ? `@${m.username}` : m.email}</Text>
                    )}
                  </VStack>
                </HStack>
                <HStack gap={2} vAlign="center">
                  {self && onlyOwner && (
                    <span title={t("settings.members.onlyOwnerHint")}>
                      <Text size="sm" color="secondary">
                        {t("settings.members.onlyOwner")}
                      </Text>
                    </span>
                  )}
                  {canEditThis ? (
                    <Selector
                      label={t("settings.members.roleOf", { name: memberName(m) })}
                      isLabelHidden
                      size="sm"
                      width={130}
                      value={m.role}
                      onChange={(v) => chooseRole(m, v as WorkspaceRole)}
                      options={assignableRoles(m).map((r) => ({ value: r, label: t(ROLE_LABEL[r]) }))}
                    />
                  ) : (
                    <Badge variant={ROLE_VARIANT[m.role]} label={t(ROLE_LABEL[m.role])} />
                  )}
                  {/* Words, not an icon: on your own row it means leaving, on anyone else's removing them. */}
                  {canRemoveThis &&
                    (self ? (
                      <Button label={t("settings.members.leave")} variant="secondary" size="sm" onClick={() => setRemoving(m)} />
                    ) : (
                      <Button
                        label={t("common.remove")}
                        tooltip={t("settings.members.removeNamed", { name: memberName(m) })}
                        variant="ghost"
                        size="sm"
                        onClick={() => setRemoving(m)}
                      />
                    ))}
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
                    label={[
                      ...(link.note ? [t("settings.members.linkFor", { note: link.note })] : []),
                      t(ROLE_LABEL[link.role]),
                      admitsLabel(link),
                      ...(link.token_hint ? [t("settings.members.endsIn", { hint: link.token_hint })] : []),
                    ].join(" · ")}
                    description={describeInvite(link, creatorName(link.created_by))}
                    endContent={<Button label={t("settings.members.revokeLink")} variant="ghost" size="sm" onClick={() => setRevoking(link)} />}
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

      {/* Names the person and the workspace: rows are close together. */}
      <AlertDialog
        isOpen={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={
          removing?.alias === me
            ? t("settings.members.leaveTitle", { workspace: workspace.name })
            : removing
              ? t("settings.members.removeTitle", { name: memberName(removing), workspace: workspace.name })
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
      <AlertDialog
        isOpen={pendingRole !== null}
        onOpenChange={(o) => !o && setPendingRole(null)}
        title={
          pendingRole?.role === "owner"
            ? t("settings.members.makeOwnerTitle", { name: memberName(pendingRole.member) })
            : t("settings.members.stepDownTitle")
        }
        description={
          pendingRole?.role === "owner"
            ? t("settings.members.makeOwnerDescription")
            : t("settings.members.stepDownDescription", { role: pendingRole?.role ?? "member" })
        }
        actionLabel={pendingRole?.role === "owner" ? t("settings.members.makeOwner") : t("settings.members.stepDown")}
        onAction={() => pendingRole && changeRole(pendingRole.member.alias, pendingRole.role)}
      />
      <AlertDialog
        isOpen={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={revoking?.note ? t("settings.members.revokeTitleFor", { note: revoking.note }) : t("settings.members.revokeTitle")}
        description={t("settings.members.revokeDescription")}
        actionLabel={t("settings.members.revokeLink")}
        onAction={() => revoking && revokeLink(revoking)}
      />
    </PageColumn>
  );
}
