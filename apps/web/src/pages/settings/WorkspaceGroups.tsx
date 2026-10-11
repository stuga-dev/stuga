/**
 * A workspace's groups: named sets of members to share with in one step. Owners and admins create
 * them and change who is in them; each change is saved at once. A group shared with reaches whoever
 * is in it at the time, so removing someone here ends the access the group gave them.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useToast } from "../../ui/use-toast";
import { Plus, UserMinus, Users as UsersIcon } from "lucide-react";
import { Groups, groupName, Users, type GroupInfo } from "../../api";
import { errorMessage } from "../../lib/http/client";
import { LoadFailed } from "../../ui/LoadFailed";
import { PageColumn } from "../../ui/PageColumn";
import { PersonPicker, type PersonItem } from "../../ui/PersonPicker";
import { actorHandle, principalLabel, useUserNames } from "../../state/identity";
import { t } from "../../i18n/i18n";
import { useSettingsScope } from "./SettingsLayout";

/** Group names are their principals' ids: kept short and on one line. */
const NAME_MAX = 80;

export function WorkspaceGroups() {
  const toast = useToast();
  const { isReady, workspace, canManage } = useSettingsScope();
  const [groups, setGroups] = useState<GroupInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const { groups } = await Groups.list();
      setFailed(false);
      setGroups(groups);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (workspace) void reload();
  }, [workspace, reload]);

  useUserNames((groups ?? []).flatMap((g) => g.members));

  /** Writes a group's whole membership, as the endpoint takes it, then shows what the server holds. */
  async function save(groupId: string, members: string[], failure: string) {
    setBusy(groupId);
    try {
      await Groups.setMembers(groupId, members);
      await reload();
      return true;
    } catch (e) {
      toast({ body: errorMessage(e, failure), type: "error" });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    const name = newName.trim().slice(0, NAME_MAX);
    if (!name) return;
    const groupId = `group:${name}`;
    if (groups?.some((g) => g.group_id.toLowerCase() === groupId.toLowerCase())) {
      toast({ body: t("settings.groups.exists", { name }), type: "error" });
      return;
    }
    if (await save(groupId, [], t("settings.groups.createFailed"))) setNewName("");
  }

  if (!isReady || !workspace || (!groups && !failed)) {
    return (
      <PageColumn>
        <VStack gap={2} hAlign="center" style={{ paddingTop: "20vh" }}>
          <Spinner label={t("common.loading")} />
        </VStack>
      </PageColumn>
    );
  }
  if (failed || !groups) {
    return (
      <PageColumn>
        <LoadFailed icon={<UsersIcon size={28} />} title={t("settings.groups.loadFailed")} onRetry={() => void reload()} />
      </PageColumn>
    );
  }

  return (
    <PageColumn>
      <VStack gap={4}>
        <VStack gap={1}>
          <Heading level={2}>{t("settings.groups.heading")}</Heading>
          <Text color="secondary">{t("settings.groups.note")}</Text>
        </VStack>

        {canManage && (
          <HStack gap={2} vAlign="end">
            <StackItem size="fill">
              <TextInput
                label={t("settings.groups.newName")}
                value={newName}
                onChange={(v) => setNewName(v.slice(0, NAME_MAX))}
                onEnter={() => void create()}
              />
            </StackItem>
            <Button
              label={t("settings.groups.create")}
              variant="secondary"
              icon={<Plus size={15} />}
              isDisabled={!newName.trim()}
              isLoading={busy !== null && busy === `group:${newName.trim()}`}
              onClick={() => void create()}
            />
          </HStack>
        )}

        {groups.length === 0 ? (
          <Text color="secondary">{t("settings.groups.none")}</Text>
        ) : (
          groups.map((group) => (
            <GroupSection
              key={group.group_id}
              group={group}
              canManage={canManage}
              busy={busy === group.group_id}
              onChange={(members, failure) => save(group.group_id, members, failure)}
            />
          ))
        )}
      </VStack>
    </PageColumn>
  );
}

function GroupSection({
  group,
  canManage,
  busy,
  onChange,
}: {
  group: GroupInfo;
  canManage: boolean;
  busy: boolean;
  onChange: (members: string[], failure: string) => Promise<boolean>;
}) {
  const [candidate, setCandidate] = useState<PersonItem | null>(null);
  const name = groupName(group.group_id);

  async function add(item: PersonItem | null) {
    setCandidate(item);
    if (!item) return;
    if (await onChange([...group.members, `user:${item.id}`], t("settings.groups.addFailed"))) setCandidate(null);
  }

  return (
    <section className="group-section">
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" justify="between">
          <Heading level={3}>{name}</Heading>
          <Badge variant="neutral" label={t("settings.groups.count", { count: group.members.length })} icon={<UsersIcon size={13} />} />
        </HStack>
        {group.members.length === 0 ? (
          <Text size="sm" color="secondary">
            {t("settings.groups.empty")}
          </Text>
        ) : (
          <ul className="member-list">
            {group.members.map((member) => (
              <li key={member} className="member-row">
                <VStack gap={0}>
                  <Text>{principalLabel(member)}</Text>
                  {actorHandle(member) && (
                    <Text size="sm" color="secondary">
                      {actorHandle(member)}
                    </Text>
                  )}
                </VStack>
                {canManage && (
                  <IconButton
                    label={t("settings.groups.removeMember", { name: principalLabel(member), group: name })}
                    variant="ghost"
                    size="sm"
                    icon={<UserMinus size={16} />}
                    isDisabled={busy}
                    onClick={() => void onChange(group.members.filter((m) => m !== member), t("settings.groups.removeFailed"))}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <PersonPicker
            label={t("settings.groups.addTo", { group: name })}
            search={(q, signal) =>
              Users.search(q, { signal }).then((r) =>
                r.users.map((u) => ({ alias: u.alias, username: u.username, display_name: u.display_name || u.username || u.alias })),
              )
            }
            exclude={group.members.map((m) => m.slice("user:".length))}
            value={candidate}
            onChange={(item) => void add(item)}
          />
        )}
      </VStack>
    </section>
  );
}
