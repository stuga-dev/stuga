/**
 * Sharing for a document, database or folder: per-person and per-group grants
 * (Can edit, Can comment, Can view), General access for the workspace, and a
 * share link. The parent folder is one more source of access, a General access
 * row like the workspace and the link; turning it off revokes access, so it asks
 * first. Inheritance only adds, so each person's row says when the folder gives
 * them more than their own grant. "Can comment" is offered only on documents,
 * the one surface that renders comments. Recipients come from the directory and
 * the workspace's groups, so a grant always names a principal that can match.
 * Someone who cannot change the sharing sees it read-only. A guest of the
 * workspace is marked as one, since a guest sees only what is shared with them.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Docs,
  Folders,
  Groups,
  groupName,
  Users,
  Workspaces,
  type AccessRequest,
  type AclModel,
  type GroupInfo,
  type UserInfo,
} from "../api";
import { actorHandle, Avatar, nameLoading, principalLabel, rememberUsers, useUserNames } from "../state/identity";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Typeahead, TypeaheadItem, type SearchSource, type SearchableItem } from "@astryxdesign/core/Typeahead";
import { Selector } from "@astryxdesign/core/Selector";
import { Button } from "@astryxdesign/core/Button";
import { List, ListItem } from "@astryxdesign/core/List";
import { Divider } from "@astryxdesign/core/Divider";
import { VStack } from "@astryxdesign/core/VStack";
import { Banner } from "@astryxdesign/core/Banner";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "../ui/use-toast";
import { Building2, Folder, Search, Users as UsersIcon } from "lucide-react";
import { errorMessage } from "../lib/http/client";
import { relativeTime } from "../lib/format";
import { t, type MessageKey } from "../i18n/i18n";
import { ShareLinkSection } from "./ShareLinkSection";
import { describe, ROLE_WIDTH, RowIcon, wrapLabel } from "./share-rows";
import { useFocusReturn } from "../ui/use-focus-return";

type Role = "editor" | "commenter" | "viewer";

/** A direct grant's menu value: a role, or marked for removal on save. */
type RowValue = Role | "remove";

/** What is being shared; it decides whether the comment tier exists. */
export type ShareKind = "doc" | "folder" | "database";

export function shareKindOfDoc(doc: { doc_type?: "prose" | "database" } | undefined): ShareKind {
  return doc?.doc_type === "database" ? "database" : "doc";
}

const ROLE_LABELS: Record<Role, MessageKey> = {
  editor: "library.share.canEdit",
  commenter: "library.share.canComment",
  viewer: "library.share.canView",
};

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2 };

/** The workspace's `org:<id>` grant: the General access floor. */
type GeneralAccess = "invited" | "workspace_view" | "workspace_edit";

/** A picker row; `id` is the principal it grants, and a person rides along for the row's avatar and handle. */
type RecipientItem = SearchableItem<UserInfo | null>;

/** A principal's level in an ACL: writers edit, commenters comment, every other reader views. */
function levelIn(acl: Pick<AclModel, "acl_writers" | "acl_commenters">, principal: string, hasComments: boolean): Role {
  if (acl.acl_writers.includes(principal)) return "editor";
  return hasComments && acl.acl_commenters.includes(principal) ? "commenter" : "viewer";
}

export function ShareDialog({
  docId,
  kind = "doc",
  onClose,
}: {
  docId: string;
  /** A folder has no share link. */
  kind?: ShareKind;
  onClose: () => void;
}) {
  useFocusReturn();
  const isFolder = kind === "folder";
  const hasComments = kind === "doc";
  const toast = useToast();
  // Direct grants other than the workspace's: people and groups.
  const [grants, setGrants] = useState<string[]>([]);
  const [roles, setRoles] = useState<Map<string, RowValue>>(new Map());
  // Access that comes from a parent folder, shown read-only with its level.
  const [inherited, setInherited] = useState<Map<string, Role>>(new Map());
  // What the parent folder gives each principal, for the note on a direct row it outranks.
  const [fromFolder, setFromFolder] = useState<Map<string, Role>>(new Map());
  const [general, setGeneral] = useState<GeneralAccess>("invited");
  const [orgPrincipal, setOrgPrincipal] = useState<string | null>(null);
  const [inherits, setInherits] = useState(false);
  // The list shows today's grants, so switching inheritance on says what saving will add.
  const [loadedInherits, setLoadedInherits] = useState(false);
  // Whether the caller may change the sharing, for the item it was read for; null until then.
  const [manageable, setManageable] = useState<{ docId: string; canManage: boolean } | null>(null);
  const canManage = manageable?.docId === docId ? manageable.canManage : null;
  /** A guest of the workspace, who may not search its people. */
  const isGuest = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parent, setParent] = useState<AclModel["parent"]>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  // The workspace's groups; empty for anyone who may not list them.
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  // The workspace's guests, as `user:` principals, to mark on their rows.
  const [guests, setGuests] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  // Bumped to read the sharing again, as after a refused save.
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    let active = true;
    const getAcl = isFolder ? Folders.getAcl(docId) : Docs.getAcl(docId);
    Promise.all([getAcl, Workspaces.list().catch(() => null)])
      .then(async ([a, wl]) => {
        // The folder's own levels, when the caller may read it; else what the effective arrays add.
        const parentAcl = a.parent ? await Folders.getAcl(a.parent.folder_id).catch(() => null) : null;
        if (!active) return;
        const org = wl ? `org:${wl.active}` : null;
        setOrgPrincipal(org);
        const here = wl?.workspaces.find((w) => w.workspace_id === wl.active);
        setWorkspaceName(here?.name ?? null);
        // The node refuses a guest the directory and the groups; asking anyway only fills the audit log.
        isGuest.current = here?.role === "guest";
        if (wl?.active) {
          Workspaces.members(wl.active)
            .then(({ members }) => {
              if (active) setGuests(new Set(members.filter((m) => m.role === "guest").map((m) => `user:${m.alias}`)));
            })
            .catch(() => {});
        }
        setParent(a.parent);
        setOwner(a.owner);
        setManageable({ docId, canManage: a.can_manage });
        // Direct grants are the editable rows; effective principals beyond them are inherited.
        const own = a.own_grants;
        const directWriters = new Set(own.w);
        const directCommenters = new Set(own.c);
        const directAll = new Set<string>([...own.p, ...own.w, ...own.c]);
        const people = [...directAll].filter((p) => p !== org);
        setGrants(people);
        const r = new Map<string, RowValue>();
        for (const p of people) {
          // Without comments a commenter can do no more than view.
          const commenter = hasComments && directCommenters.has(p);
          r.set(p, directWriters.has(p) ? "editor" : commenter ? "commenter" : "viewer");
        }
        setRoles(r);
        const folderLevels = new Map<string, Role>();
        if (a.inherits) {
          for (const p of a.acl_principals) {
            if (p === org || p === a.owner) continue;
            if (parentAcl) {
              if (parentAcl.acl_principals.includes(p)) folderLevels.set(p, levelIn(parentAcl, p, false));
            } else if (!directAll.has(p) || RANK[levelIn(a, p, hasComments)] > RANK[r.get(p) as Role]) {
              folderLevels.set(p, levelIn(a, p, hasComments));
            }
          }
        }
        setFromFolder(folderLevels);
        const inh = new Map<string, Role>();
        for (const p of a.acl_principals) {
          if (p !== org && p !== a.owner && !directAll.has(p)) inh.set(p, folderLevels.get(p) ?? levelIn(a, p, hasComments));
        }
        setInherited(inh);
        if (org && a.acl_principals.includes(org)) {
          setGeneral(a.acl_writers.includes(org) ? "workspace_edit" : "workspace_view");
        } else {
          setGeneral("invited");
        }
        setInherits(a.inherits);
        setLoadedInherits(a.inherits);
        setConfirmingStop(false);
        if (a.can_manage && !isGuest.current) {
          Groups.list()
            .then((g) => active && setGroups(g.groups))
            .catch(() => {});
          if (!isFolder) {
            Docs.accessRequests(docId)
              .then((q) => active && setRequests(q.requests))
              .catch(() => {});
          }
        }
      })
      .catch(() => {
        if (!active) return;
        setGrants([]);
        setManageable({ docId, canManage: false });
      });
    return () => {
      active = false;
    };
  }, [docId, isFolder, hasComments, loads]);

  // The picker skips whoever is already listed; refs, so the source needn't be rebuilt per grant.
  const listed = useRef<string[]>([]);
  listed.current = [...(owner ? [owner] : []), ...grants, ...inherited.keys()];
  const groupsRef = useRef<GroupInfo[]>([]);
  groupsRef.current = groups;

  // Newest query wins: a slower answer to an older one is aborted, not shown.
  const recipientSource = useMemo<SearchSource<RecipientItem>>(() => {
    let controller: AbortController | null = null;
    return {
      cancel() {
        controller?.abort();
      },
      async search(query) {
        const q = query.trim();
        // A group is picked from the workspace's groups, by name, with or without the old prefix.
        const name = (q.startsWith("group:") ? q.slice("group:".length) : q).toLowerCase();
        const groupItems: RecipientItem[] = groupsRef.current
          .filter((g) => !listed.current.includes(g.group_id) && name !== "" && groupName(g.group_id).toLowerCase().includes(name))
          .map((g) => ({ id: g.group_id, label: principalLabel(g.group_id), auxiliaryData: null }));
        if (q.startsWith("group:") || isGuest.current) return groupItems;
        controller?.abort();
        controller = new AbortController();
        try {
          const { users } = await Users.search(q, { signal: controller.signal });
          rememberUsers(users);
          const items: RecipientItem[] = users
            .filter((u) => !listed.current.includes(`user:${u.alias}`))
            .map((u) => ({ id: `user:${u.alias}`, label: u.display_name || u.username || u.email || u.alias, auxiliaryData: u }));
          // An address nobody in the directory has yet is still granted, as before.
          if (items.length === 0 && users.length === 0 && groupItems.length === 0 && q.includes("@")) {
            items.push({ id: `user:${q}`, label: q, auxiliaryData: null });
          }
          return [...items, ...groupItems];
        } catch {
          return groupItems;
        }
      },
      bootstrap: () => [],
    };
  }, []);

  function addPrincipal(principal: string, role: Role = "viewer") {
    if (grants.includes(principal)) {
      setRoles((m) => new Map(m).set(principal, role));
    } else {
      setGrants((gs) => [...gs, principal]);
      // The narrowest level first, for a guest, a group and a folder's whole contents alike.
      setRoles((m) => new Map(m).set(principal, role));
    }
    setError(null);
  }

  function setRole(principal: string, value: RowValue) {
    setRoles((m) => new Map(m).set(principal, value));
  }

  /** Answer a request: a level adds the person like any other grant; Dismiss forgets the request now. */
  async function answerRequest(principal: string, value: string) {
    setRequests((rs) => rs.filter((r) => r.principal !== principal));
    if (value !== "dismiss") {
      addPrincipal(principal, value as Role);
      return;
    }
    try {
      await Docs.dismissAccessRequest(docId, principal);
    } catch (e) {
      setError(errorMessage(e, t("library.share.dismissFailed")));
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // `kept` is everyone with access; writers and commenters are subsets. The workspace joins the tier General access picks.
      const kept = grants.filter((g) => roles.get(g) !== "remove");
      const allGrants = [...kept];
      const writerGrants = kept.filter((g) => roles.get(g) === "editor");
      const commenterGrants = kept.filter((g) => roles.get(g) === "commenter");
      if (orgPrincipal && general !== "invited") {
        allGrants.push(orgPrincipal);
        if (general === "workspace_edit") writerGrants.push(orgPrincipal);
      }
      if (isFolder) {
        await Folders.setAcl(docId, allGrants, writerGrants, inherits);
      } else {
        await Docs.setAcl(docId, allGrants, writerGrants, inherits, commenterGrants);
      }
      toast({ body: t("library.share.updated"), type: "info" });
      onClose();
    } catch (e) {
      setError(errorMessage(e, t("library.share.saveFailed")));
      // A refusal changed nothing, so the dialog goes back to what is in force.
      if ((e as { status?: number }).status === 403) setLoads((n) => n + 1);
    } finally {
      setSaving(false);
    }
  }

  const readOnly = canManage !== true;
  const tiers: Role[] = hasComments ? ["editor", "commenter", "viewer"] : ["editor", "viewer"];
  // A person's menu ends in removal, so every row has one control in one column.
  const personOptions = [
    ...tiers.map((r) => ({ value: r, label: t(ROLE_LABELS[r]) })),
    { type: "divider" as const },
    { value: "remove", label: t("library.share.removeAccess") },
  ];
  const requestOptions = [
    ...tiers.map((r) => ({ value: r, label: t(ROLE_LABELS[r]) })),
    { type: "divider" as const },
    { value: "dismiss", label: t("library.share.dismiss") },
  ];

  const generalOptions = [
    { value: "invited", label: t("library.share.noAccess") },
    { value: "workspace_view", label: t("library.share.canView") },
    { value: "workspace_edit", label: t("library.share.canEdit") },
  ];

  const parentName = parent?.title ?? null;
  const thing = isFolder ? "folder" : kind === "database" ? "database" : "document";
  const everyone = workspaceName ? t("library.share.everyoneIn", { workspace: workspaceName }) : t("library.share.everyoneInThis");
  const generalLabel: Record<GeneralAccess, string> = {
    invited: t("library.share.noAccess"),
    workspace_view: t("library.share.canView"),
    workspace_edit: t("library.share.canEdit"),
  };

  /** "Can edit via Planning": what the parent folder gives someone. */
  function viaFolder(role: Role): string {
    return parentName ? t("library.share.via", { role, folder: parentName }) : t("library.share.viaParent", { role });
  }

  /** A group's size, so an empty one says it reaches nobody. */
  function groupNote(principal: string): string | null {
    if (!principal.startsWith("group:") || readOnly) return null;
    const group = groups.find((g) => g.group_id === principal);
    return t("library.share.groupMembers", { count: group?.members.length ?? 0 });
  }

  /** A person's handle, marked when they are a guest of the workspace; a group's size. */
  function whoLine(principal: string): string | null {
    if (principal.startsWith("group:")) return groupNote(principal);
    const parts = [actorHandle(principal), guests.has(principal) ? t("settings.roles.guest") : null].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  /** A direct row's lines: who it is, and the folder's level when it outranks the row's own. */
  function directDescription(principal: string): ReactNode {
    const lines = [whoLine(principal)];
    const folderRole = fromFolder.get(principal);
    const own = roles.get(principal);
    if (inherits && loadedInherits && folderRole && own && own !== "remove" && RANK[folderRole] > RANK[own]) {
      lines.push(viaFolder(folderRole));
    }
    return describe(lines);
  }

  const queryHint =
    query.trim().length === 1
      ? t("library.share.typeMore")
      : null;
  const typed = query.trim();
  const emptyText = typed.startsWith("group:")
    ? t("library.share.noGroup", { name: typed.slice("group:".length) })
    : t("library.share.noMatches");

  useUserNames([...(owner ? [owner] : []), ...grants, ...inherited.keys(), ...requests.map((r) => r.principal)]);

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="form" width={480}>
      <Layout
        header={<DialogHeader title={t("common.share")} onOpenChange={(o) => !o && onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              {canManage === false && <Banner status="info" title={t("library.share.readOnly")} />}
              {!readOnly && (
                <VStack gap={1}>
                  {/* Picking a row adds it at once; the field clears for the next person. */}
                  <Typeahead<RecipientItem>
                    label={t("library.share.addPeople")}
                    isLabelHidden
                    placeholder={groups.length > 0 ? t("library.share.addPlaceholderGroups") : t("library.share.addPlaceholder")}
                    width="100%"
                    startIcon={<Search size={15} />}
                    searchSource={recipientSource}
                    value={null}
                    onChange={(item) => item && addPrincipal(item.id)}
                    onChangeQuery={setQuery}
                    minQueryLength={2}
                    emptySearchText={emptyText}
                    renderItem={(item) => {
                      const u = item.auxiliaryData;
                      const handle = u ? (u.username ? `@${u.username}` : u.email) : null;
                      const isGroup = item.id.startsWith("group:");
                      return (
                        <TypeaheadItem
                          item={item}
                          icon={u ? <Avatar principal={item.id} size={24} /> : <UsersIcon size={18} />}
                          description={isGroup ? (groupNote(item.id) ?? undefined) : handle && handle !== item.label ? handle : undefined}
                        />
                      );
                    }}
                  />
                  {queryHint && (
                    <Text size="sm" color="secondary">
                      {queryHint}
                    </Text>
                  )}
                </VStack>
              )}
              {error && <Banner status="error" title={t("library.share.failed")} description={error} />}

              {requests.length > 0 && !readOnly && (
                <VStack gap={1}>
                  <Text size="sm" weight="semibold">{t("library.share.requests")}</Text>
                  <List className="request-list">
                    {requests.map((r) => (
                      <ListItem
                        key={r.principal}
                        label={rowLabel(r.principal)}
                        description={describe([whoLine(r.principal), t("library.share.requestedAt", { time: relativeTime(r.requested_at) })])}
                        startContent={<Avatar principal={r.principal} size={28} />}
                        endContent={
                          <Selector
                            label={nameLoading(r.principal) ? t("library.share.answer") : t("library.share.answerFor", { name: principalLabel(r.principal) })}
                            isLabelHidden
                            variant="ghost"
                            size="sm"
                            width={ROLE_WIDTH}
                            className="share-role"
                            placeholder={t("library.share.approve")}
                            onChange={(v) => void answerRequest(r.principal, v)}
                            options={requestOptions}
                          />
                        }
                      />
                    ))}
                  </List>
                </VStack>
              )}

              <VStack gap={1}>
                <Text size="sm" weight="semibold">{t("library.share.peopleWithAccess")}</Text>
                <List className="grant-list">
                  {owner && (
                    <ListItem
                      label={rowLabel(owner)}
                      description={describe([actorHandle(owner)])}
                      startContent={<Avatar principal={owner} size={28} />}
                      endContent={
                        <Text size="sm" color="secondary" className="share-row-note">
                          {t("library.table.owner")}
                        </Text>
                      }
                    />
                  )}
                  {grants.filter((g) => g !== owner).map((g) => {
                    const value = roles.get(g) ?? "viewer";
                    return (
                      <ListItem
                        key={g}
                        label={rowLabel(g)}
                        description={directDescription(g)}
                        startContent={principalIcon(g)}
                        endContent={
                          readOnly ? (
                            <Text size="sm" color="secondary" className="share-row-note">
                              {t(ROLE_LABELS[value === "remove" ? "viewer" : value])}
                            </Text>
                          ) : (
                            // A removal stays listed until saved, so the rows below do not move and it can be taken back.
                            <Selector
                              label={nameLoading(g) ? t("common.access") : t("library.share.accessFor", { name: principalLabel(g) })}
                              isLabelHidden
                              variant="ghost"
                              size="sm"
                              width={ROLE_WIDTH}
                              className={value === "remove" ? "share-role share-role--removed" : "share-role"}
                              value={value}
                              onChange={(v) => setRole(g, v as RowValue)}
                              options={personOptions}
                            />
                          )
                        }
                      />
                    );
                  })}
                  {/* Access that saving will revoke says so in the error colour, not dimmed, so it stays readable. */}
                  {[...inherited].map(([g, role]) => (
                    <ListItem
                      key={`inh-${g}`}
                      label={rowLabel(g)}
                      description={describe([whoLine(g)])}
                      startContent={principalIcon(g)}
                      endContent={
                        <Text
                          size="sm"
                          color="secondary"
                          className={inherits ? "share-row-note" : "share-row-note share-row-note--revoked"}
                        >
                          {inherits ? viaFolder(role) : t("library.share.removedOnSave")}
                        </Text>
                      }
                    />
                  ))}
                </List>
              </VStack>

              <Divider />

              <VStack gap={1}>
                <Text size="sm" weight="semibold">{t("library.share.general")}</Text>
                <List>
                  {parent && (
                    <ListItem
                      label={wrapLabel(parentName ? t("library.share.parentEveryone", { name: parentName }) : t("library.share.parentEveryoneUnnamed"))}
                      description={describe([
                        !inherits
                          ? t("library.share.onlyPeopleAbove")
                          : loadedInherits
                            ? t("library.share.keepsFolderAccess")
                            : t("library.share.savingGrants"),
                      ])}
                      startContent={<RowIcon icon={<Folder size={16} />} />}
                      endContent={
                        readOnly ? (
                          <Text size="sm" color="secondary" className="share-row-note">
                            {inherits ? t("library.share.inherited") : t("library.share.noAccess")}
                          </Text>
                        ) : (
                          <Selector
                            label={t("library.share.parentAccess")}
                            isLabelHidden
                            variant="ghost"
                            size="sm"
                            width={ROLE_WIDTH}
                            className="share-role"
                            value={inherits || confirmingStop ? "inherit" : "none"}
                            // Granting needs no warning; revoking waits for the confirmation below.
                            onChange={(v) => {
                              if (v === "none") {
                                setConfirmingStop(true);
                              } else {
                                setConfirmingStop(false);
                                setInherits(true);
                              }
                            }}
                            options={[
                              { value: "inherit", label: t("library.share.inherited") },
                              { value: "none", label: t("library.share.noAccess") },
                            ]}
                          />
                        )
                      }
                    />
                  )}
                  {/* In place of a second dialog over this one: the change still waits for Save. */}
                  {confirmingStop && (
                    <li className="share-confirm">
                      <Banner
                        status="warning"
                        title={parentName ? t("library.share.stopTitle", { name: parentName }) : t("library.share.stopTitleUnnamed")}
                        description={
                          parentName
                            ? t("library.share.stopBody", { lost: inherited.size, name: parentName, thing })
                            : t("library.share.stopBodyUnnamed", { lost: inherited.size, thing })
                        }
                        collapsible={false}
                      >
                        <HStack gap={2} justify="end">
                          <Button label={t("common.cancel")} variant="ghost" size="sm" onClick={() => setConfirmingStop(false)} />
                          <Button
                            label={t("library.share.stopAction")}
                            variant="destructive"
                            size="sm"
                            onClick={() => {
                              setInherits(false);
                              setConfirmingStop(false);
                            }}
                          />
                        </HStack>
                      </Banner>
                    </li>
                  )}
                  <ListItem
                    label={wrapLabel(everyone)}
                    description={describe([
                      general === "invited"
                        ? t("library.share.onlyPeopleAbove")
                        : general === "workspace_edit"
                          ? t("library.share.membersEdit")
                          : t("library.share.membersView"),
                    ])}
                    startContent={<RowIcon icon={<Building2 size={16} />} />}
                    endContent={
                      readOnly ? (
                        <Text size="sm" color="secondary" className="share-row-note">
                          {generalLabel[general]}
                        </Text>
                      ) : (
                        <Selector
                          label={t("library.share.general")}
                          isLabelHidden
                          variant="ghost"
                          size="sm"
                          width={ROLE_WIDTH}
                          className="share-role"
                          value={general}
                          onChange={(v) => setGeneral(v as GeneralAccess)}
                          options={generalOptions}
                        />
                      )
                    }
                  />
                  {!isFolder && canManage && <ShareLinkSection docId={docId} hasComments={hasComments} onError={setError} />}
                </List>
              </VStack>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              {readOnly ? (
                <Button label={t("common.close")} variant="secondary" onClick={onClose} />
              ) : (
                <>
                  <Button label={t("common.cancel")} variant="ghost" onClick={onClose} />
                  <Button label={t("common.save")} variant="primary" onClick={save} isLoading={saving} />
                </>
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/** A row's name; a blank while a person's name loads, rather than the raw alias. */
function rowLabel(principal: string): string {
  return nameLoading(principal) ? "\u00a0" : principalLabel(principal);
}

/** A person's avatar, or a group's round icon. */
function principalIcon(principal: string): ReactNode {
  return principal.startsWith("group:") ? <RowIcon icon={<UsersIcon size={16} />} /> : <Avatar principal={principal} size={28} />;
}
