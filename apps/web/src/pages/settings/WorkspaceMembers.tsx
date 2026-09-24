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

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};
const ROLE_VARIANT: Record<WorkspaceRole, "purple" | "blue" | "neutral" | "green"> = {
  owner: "purple",
  admin: "blue",
  member: "neutral",
  guest: "green",
};

/** Who a link admits, in the words of the row that lists it. */
function admitsLabel(invite: InviteInfo): string {
  if (invite.max_uses === 1) return "one person";
  return invite.max_uses === null ? "anyone with the link" : `up to ${invite.max_uses} people`;
}

/** "Not used yet · expires Sep 18, 2:32 PM · created by Liv 3d ago" */
function describeInvite(invite: InviteInfo, creator: string): string {
  const used =
    invite.use_count === 0
      ? "Not used yet"
      : invite.max_uses === null
        ? `Used ${invite.use_count === 1 ? "once" : `${invite.use_count} times`}`
        : `${invite.use_count} of ${invite.max_uses} used`;
  const expires = invite.expires_at
    ? `expires ${versionLabel(invite.expires_at)}`
    : "never expires";
  return `${used} · ${expires} · created by ${creator} ${relativeTime(invite.created_at)}`;
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
          <Spinner label="Loading…" />
        </VStack>
      </PageColumn>
    );
  }
  if (failed) {
    return (
      <PageColumn>
        <LoadFailed
          icon={<UsersIcon size={28} />}
          title="Couldn’t load this workspace’s members"
          onRetry={() => void reload()}
        />
      </PageColumn>
    );
  }
  if (!members) {
    return (
      <PageColumn>
        <VStack gap={2} hAlign="center" style={{ paddingTop: "20vh" }}>
          <Spinner label="Loading members…" />
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
      toast({ body: `${candidate.label} is now ${inviteRole === "admin" ? "an admin" : `a ${ROLE_LABEL[inviteRole].toLowerCase()}`}.`, type: "info" });
      setCandidate(null);
      await reload();
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't add them."), type: "error" });
    } finally {
      setAdding(false);
    }
  }

  async function revokeLink(invite: InviteInfo) {
    if (!workspaceId) return;
    try {
      await Workspaces.revokeInvite(workspaceId, invite.token_hash);
      toast({ body: "Link revoked. Nobody can join with it any more.", type: "info" });
      await reloadInvites();
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't revoke that link."), type: "error" });
    }
  }

  async function changeRole(alias: string, role: WorkspaceRole) {
    if (!workspaceId) return;
    try {
      await Workspaces.setRole(workspaceId, alias, role);
      await reload();
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't change role."), type: "error" });
    }
  }

  async function remove(alias: string) {
    if (!workspaceId) return;
    const self = alias === me;
    setRemoving(null);
    try {
      await Workspaces.remove(workspaceId, alias);
      toast({ body: self ? "You left the workspace." : "Member removed.", type: "info" });
      if (self) {
        window.location.assign("/");
        return;
      }
      await reload();
    } catch (e) {
      // One endpoint backs both leaving and removing.
      const fallback = self ? "Couldn't leave the workspace." : "Couldn't remove that member.";
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
    return m ? m.display_name || m.username || m.email || alias : "a former member";
  }

  return (
    <PageColumn>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center">
          <Heading level={2}>Members</Heading>
          {/* Labelled by what it counts, since guests are in the list too. */}
          <Badge
            variant="neutral"
            label={`${members.length} ${members.length === 1 ? "person" : "people"}`}
            icon={<UsersIcon size={13} />}
          />
        </HStack>

        {canManage && (
          <HStack gap={2} vAlign="end">
            <StackItem size="fill">
              <PersonPicker
                label="Add people"
                search={(q, signal) => Workspaces.memberCandidates(workspace.workspace_id, q, { signal }).then((r) => r.users)}
                value={candidate}
                onChange={setCandidate}
                emptySearchResultsText="No one outside this workspace matches. Send them an invite link instead."
              />
            </StackItem>
            <Selector
              label="Role"
              width={130}
              value={inviteRole}
              onChange={(v) => setInviteRole(v as WorkspaceRole)}
              options={
                isOwner
                  ? [
                      { value: "member", label: "Member" },
                      { value: "guest", label: "Guest" },
                      { value: "admin", label: "Admin" },
                    ]
                  : [
                      { value: "member", label: "Member" },
                      { value: "guest", label: "Guest" },
                    ]
              }
            />
            <Button
              label="Add"
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
                      label="Role"
                      isLabelHidden
                      size="sm"
                      width={130}
                      value={m.role}
                      onChange={(v) => changeRole(m.alias, v as WorkspaceRole)}
                      options={assignableRoles(m).map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                    />
                  ) : (
                    <Badge variant={ROLE_VARIANT[m.role]} label={ROLE_LABEL[m.role]} />
                  )}
                  {canRemoveThis && (
                    <IconButton
                      label={m.alias === me ? "Leave workspace" : `Remove ${m.display_name || m.username || m.email || m.alias}`}
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
              <Heading level={3}>Invite links</Heading>
              <Button
                label="Create link"
                variant="secondary"
                icon={<LinkIcon size={15} />}
                onClick={() => setLinkDialogOpen(true)}
              />
            </HStack>
            <Text color="secondary">Anyone with a link can create an account on this server and join this workspace.</Text>
            {invitesFailed ? (
              <Text size="sm" color="secondary">
                Couldn’t load this workspace’s invite links.
              </Text>
            ) : invites && invites.length === 0 ? (
              <Text size="sm" color="secondary">
                No active links.
              </Text>
            ) : invites ? (
              <List hasDividers density="compact">
                {invites.map((link) => (
                  <ListItem
                    key={link.token_hash}
                    label={`${ROLE_LABEL[link.role]} · ${admitsLabel(link)}${link.token_hint ? ` · ends in …${link.token_hint}` : ""}`}
                    description={describeInvite(link, creatorName(link.created_by))}
                    endContent={
                      <IconButton
                        label="Revoke link"
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
            ? `Leave ${workspace.name}?`
            : `Remove ${removing?.display_name || removing?.username || removing?.email || removing?.alias || "this person"} from ${workspace.name}?`
        }
        description={
          removing?.alias === me
            ? "You lose access to every document shared through this workspace, and any agent keys you created here stop working. An owner or admin has to invite you back."
            : "They lose access to every document shared through this workspace, and any agent keys they created here stop working. You can invite them again later."
        }
        actionLabel={removing?.alias === me ? "Leave workspace" : "Remove"}
        actionVariant="destructive"
        onAction={() => removing && remove(removing.alias)}
      />
    </PageColumn>
  );
}
