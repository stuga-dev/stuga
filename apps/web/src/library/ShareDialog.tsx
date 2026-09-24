/**
 * Sharing for a document, database or folder: per-person grants (Can edit, Can
 * comment, Can view), General access for the workspace, and a share link.
 * The parent folder is one more source of access, a General access row like the
 * workspace and the link; turning it off revokes access, so it asks first.
 * "Can comment" is offered only on documents, the one surface that renders
 * comments. Recipients come from the directory, so a grant always names a
 * `user:<alias>` principal.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Docs, Folders, Users, Workspaces, type AclModel, type UserInfo } from "../api";
import { actorHandle, Avatar, principalLabel, rememberUsers, useUserNames } from "../state/identity";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Typeahead, TypeaheadItem, type SearchSource, type SearchableItem } from "@astryxdesign/core/Typeahead";
import { Selector } from "@astryxdesign/core/Selector";
import { Button } from "@astryxdesign/core/Button";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { List, ListItem } from "@astryxdesign/core/List";
import { Divider } from "@astryxdesign/core/Divider";
import { VStack } from "@astryxdesign/core/VStack";
import { Banner } from "@astryxdesign/core/Banner";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Building2, Folder, Link as LinkIcon, Search, Users as UsersIcon } from "lucide-react";
import { errorMessage } from "../lib/http/client";
import { copyText } from "../lib/clipboard";

type Role = "editor" | "commenter" | "viewer";

/** What is being shared; it decides whether the comment tier exists. */
export type ShareKind = "doc" | "folder" | "database";


export function shareKindOfDoc(doc: { doc_type?: "prose" | "database" } | undefined): ShareKind {
  return doc?.doc_type === "database" ? "database" : "doc";
}

const ROLE_LABELS: Record<Role, string> = {
  editor: "Can edit",
  commenter: "Can comment",
  viewer: "Can view",
};

/** The workspace's `org:<id>` grant: the General access floor. */
type GeneralAccess = "invited" | "workspace_view" | "workspace_edit";

/** A picker row; `id` is the principal it grants, and a person rides along for the row's avatar and handle. */
type RecipientItem = SearchableItem<UserInfo | null>;

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
  const isFolder = kind === "folder";
  const hasComments = kind === "doc";
  // Direct grants other than the workspace's: people and groups.
  const [grants, setGrants] = useState<string[]>([]);
  const [roles, setRoles] = useState<Map<string, Role>>(new Map());
  // Access that comes from a parent folder, shown read-only.
  const [inherited, setInherited] = useState<Set<string>>(new Set());
  const [general, setGeneral] = useState<GeneralAccess>("invited");
  const [orgPrincipal, setOrgPrincipal] = useState<string | null>(null);
  const [inherits, setInherits] = useState(false);
  // The list shows today's grants, so switching inheritance on says what saving will add.
  const [loadedInherits, setLoadedInherits] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkRole, setLinkRole] = useState<Role>("viewer");
  const [copied, setCopied] = useState(false);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [parent, setParent] = useState<AclModel["parent"]>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);

  useEffect(() => {
    let active = true;
    const getAcl = isFolder ? Folders.getAcl(docId) : Docs.getAcl(docId);
    Promise.all([getAcl, Workspaces.list().catch(() => null)])
      .then(([a, wl]) => {
        if (!active) return;
        const org = wl ? `org:${wl.active}` : null;
        setOrgPrincipal(org);
        setWorkspaceName(wl?.workspaces.find((w) => w.workspace_id === wl.active)?.name ?? null);
        setParent(a.parent);
        setOwner(a.owner);
        const writers = new Set(a.acl_writers);
        // Direct grants are the editable rows; effective principals beyond them are inherited.
        const own = a.own_grants;
        const directReaders = new Set(own.p);
        const directWriters = new Set(own.w);
        const directCommenters = new Set(own.c);
        const directAll = new Set<string>([...directReaders, ...directWriters, ...directCommenters]);
        const people = [...directAll].filter((p) => p !== org);
        setGrants(people);
        const r = new Map<string, Role>();
        for (const p of people) {
          // Without comments a commenter can do no more than view.
          const commenter = hasComments && directCommenters.has(p);
          r.set(p, directWriters.has(p) ? "editor" : commenter ? "commenter" : "viewer");
        }
        setRoles(r);
        const inh = new Set<string>();
        for (const p of a.acl_principals) if (p !== org && p !== a.owner && !directAll.has(p)) inh.add(p);
        setInherited(inh);
        if (org && a.acl_principals.includes(org)) {
          setGeneral(writers.has(org) ? "workspace_edit" : "workspace_view");
        } else {
          setGeneral("invited");
        }
        setInherits(a.inherits);
        setLoadedInherits(a.inherits);
      })
      .catch(() => active && setGrants([]));
    return () => {
      active = false;
    };
  }, [docId, isFolder, hasComments]);

  // The picker skips whoever is already listed; a ref, so the source needn't be rebuilt per grant.
  const listed = useRef<string[]>([]);
  listed.current = [...(owner ? [owner] : []), ...grants, ...inherited];

  // Newest query wins: a slower answer to an older one is aborted, not shown.
  const recipientSource = useMemo<SearchSource<RecipientItem>>(() => {
    let controller: AbortController | null = null;
    return {
      cancel() {
        controller?.abort();
      },
      async search(query) {
        const q = query.trim();
        // A group is granted as typed.
        if (q.startsWith("group:")) {
          return q.length > "group:".length ? [{ id: q, label: q, auxiliaryData: null }] : [];
        }
        controller?.abort();
        controller = new AbortController();
        try {
          const { users } = await Users.search(q, { signal: controller.signal });
          rememberUsers(users);
          const items: RecipientItem[] = users
            .filter((u) => !listed.current.includes(`user:${u.alias}`))
            .map((u) => ({ id: `user:${u.alias}`, label: u.display_name || u.username || u.email || u.alias, auxiliaryData: u }));
          // An address nobody in the directory has yet is still granted, as before.
          if (items.length === 0 && users.length === 0 && q.includes("@")) {
            items.push({ id: `user:${q}`, label: q, auxiliaryData: null });
          }
          return items;
        } catch {
          return [];
        }
      },
      bootstrap: () => [],
    };
  }, []);

  function addPrincipal(principal: string) {
    if (!grants.includes(principal)) {
      setGrants((gs) => [...gs, principal]);
      setRoles((m) => new Map(m).set(principal, "editor"));
    }
    setError(null);
  }

  function setRole(principal: string, role: Role) {
    setRoles((m) => new Map(m).set(principal, role));
  }

  function removePrincipal(principal: string) {
    setGrants((gs) => gs.filter((x) => x !== principal));
    setRoles((m) => {
      const next = new Map(m);
      next.delete(principal);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // `grants` is everyone with access; writers and commenters are subsets. The workspace joins the tier General access picks.
      const allGrants = [...grants];
      const writerGrants = grants.filter((g) => roles.get(g) === "editor");
      const commenterGrants = grants.filter((g) => roles.get(g) === "commenter");
      if (orgPrincipal && general !== "invited") {
        allGrants.push(orgPrincipal);
        if (general === "workspace_edit") writerGrants.push(orgPrincipal);
      }
      if (isFolder) {
        await Folders.setAcl(docId, allGrants, writerGrants, inherits);
      } else {
        await Docs.setAcl(docId, allGrants, writerGrants, inherits, commenterGrants);
      }
      onClose();
    } catch (e) {
      setError(errorMessage(e, "Couldn’t save these access changes."));
    } finally {
      setSaving(false);
    }
  }

  /**
   * The link is minted once and never returned again, so it is always shown:
   * the clipboard does not exist on an insecure origin such as a plain-HTTP LAN
   * address, and "Copied" appears only when the copy succeeded.
   */
  async function copyShareLink() {
    setError(null);
    try {
      const { link_url } = await Docs.createShareLink(docId, { role: linkRole });
      setShareLink(link_url);
      if (await copyText(link_url)) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
    } catch (e) {
      setError(errorMessage(e, "Couldn’t create a share link."));
    }
  }

  const tiers: Role[] = hasComments ? ["editor", "commenter", "viewer"] : ["editor", "viewer"];
  // A person's menu ends in removal, so every row has one control in one column.
  const personOptions = [
    ...tiers.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
    { type: "divider" as const },
    { value: "remove", label: "Remove access" },
  ];

  const linkTiers: Role[] = hasComments ? ["viewer", "commenter", "editor"] : ["viewer", "editor"];
  const linkOptions = linkTiers.map((r) => ({ value: r, label: ROLE_LABELS[r] }));

  const generalOptions = [
    { value: "invited", label: "No access" },
    { value: "workspace_view", label: "Can view" },
    { value: "workspace_edit", label: "Can edit" },
  ];

  const parentName = parent?.title ?? "the parent folder";
  const thing = isFolder ? "folder" : kind === "database" ? "database" : "document";
  const everyone = workspaceName ? `Everyone in ${workspaceName}` : "Everyone in this workspace";

  useUserNames([...(owner ? [owner] : []), ...grants, ...inherited]);

  return (
    <Dialog isOpen onOpenChange={(o) => !o && onClose()} purpose="form" width={480}>
      <Layout
        header={<DialogHeader title="Share" onOpenChange={(o) => !o && onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              {/* Picking a row adds it at once; the field clears for the next person. */}
              <Typeahead<RecipientItem>
                label="Add people"
                isLabelHidden
                placeholder="Add by username, name, or group:…"
                width="100%"
                startIcon={<Search size={15} />}
                searchSource={recipientSource}
                value={null}
                onChange={(item) => item && addPrincipal(item.id)}
                minQueryLength={2}
                emptySearchResultsText="No one matches. They must have an account here before you can share with them."
                renderItem={(item) => {
                  const u = item.auxiliaryData;
                  const handle = u ? (u.username ? `@${u.username}` : u.email) : null;
                  return (
                    <TypeaheadItem
                      item={item}
                      icon={u ? <Avatar principal={item.id} size={24} /> : <UsersIcon size={18} />}
                      description={handle && handle !== item.label ? handle : undefined}
                    />
                  );
                }}
              />
              {error && <Banner status="error" title="Couldn’t share" description={error} />}

              <VStack gap={1}>
                <Text size="sm" weight="semibold">People with access</Text>
                <List className="grant-list">
                  {owner && (
                    <ListItem
                      label={principalLabel(owner)}
                      description={actorHandle(owner) ?? undefined}
                      startContent={<Avatar principal={owner} size={28} />}
                      endContent={
                        <Text size="sm" color="secondary" className="share-row-note">
                          Owner
                        </Text>
                      }
                    />
                  )}
                  {grants.filter((g) => g !== owner).map((g) => (
                    <ListItem
                      key={g}
                      label={principalLabel(g)}
                      description={actorHandle(g) ?? undefined}
                      startContent={<Avatar principal={g} size={28} />}
                      endContent={
                        <Selector
                          label={`Access for ${principalLabel(g)}`}
                          isLabelHidden
                          variant="ghost"
                          size="sm"
                          width={ROLE_WIDTH}
                          value={roles.get(g) ?? "viewer"}
                          onChange={(v) => (v === "remove" ? removePrincipal(g) : setRole(g, v as Role))}
                          options={personOptions}
                        />
                      }
                    />
                  ))}
                  {/* Access that saving will revoke says so in the error colour, not dimmed, so it stays readable. */}
                  {[...inherited].map((g) => (
                    <ListItem
                      key={`inh-${g}`}
                      label={principalLabel(g)}
                      description={actorHandle(g) ?? undefined}
                      startContent={<Avatar principal={g} size={28} />}
                      endContent={
                        <Text
                          size="sm"
                          color="secondary"
                          className={inherits ? "share-row-note" : "share-row-note share-row-note--revoked"}
                        >
                          {inherits ? (parent?.title ? `From ${parent.title}` : "Inherited") : "Removed on save"}
                        </Text>
                      }
                    />
                  ))}
                </List>
              </VStack>

              <Divider />

              <VStack gap={1}>
                <Text size="sm" weight="semibold">General access</Text>
                <List>
                  {parent && (
                    <ListItem
                      label={`Everyone with access to ${parentName}`}
                      description={
                        !inherits
                          ? "Only the people above can open it"
                          : loadedInherits
                            ? "Keeps the access the folder gives them"
                            : "Saving gives them access here too"
                      }
                      startContent={<RowIcon icon={<Folder size={16} />} />}
                      endContent={
                        <Selector
                          label="Parent folder access"
                          isLabelHidden
                          variant="ghost"
                          size="sm"
                          width={ROLE_WIDTH}
                          value={inherits ? "inherit" : "none"}
                          // Granting needs no warning; revoking waits for the confirmation below.
                          onChange={(v) => (v === "none" ? setConfirmingStop(true) : setInherits(true))}
                          options={[
                            { value: "inherit", label: "Inherited" },
                            { value: "none", label: "No access" },
                          ]}
                        />
                      }
                    />
                  )}
                  <ListItem
                    label={everyone}
                    description={
                      general === "invited"
                        ? "Only the people above can open it"
                        : `Every member can ${general === "workspace_edit" ? "edit" : "view"} it`
                    }
                    startContent={<RowIcon icon={<Building2 size={16} />} />}
                    endContent={
                      <Selector
                        label="General access"
                        isLabelHidden
                        variant="ghost"
                        size="sm"
                        width={ROLE_WIDTH}
                        value={general}
                        onChange={(v) => setGeneral(v as GeneralAccess)}
                        options={generalOptions}
                      />
                    }
                  />
                  {!isFolder && (
                    <ListItem
                      label="Anyone with the link"
                      description="They sign in and join as a guest"
                      startContent={<RowIcon icon={<LinkIcon size={16} />} />}
                      endContent={
                        <Selector
                          label="Link role"
                          isLabelHidden
                          variant="ghost"
                          size="sm"
                          width={ROLE_WIDTH}
                          value={linkRole}
                          onChange={(v) => {
                            setLinkRole(v as Role);
                            setShareLink(null);
                          }}
                          options={linkOptions}
                        />
                      }
                    />
                  )}
                </List>
                {!isFolder && shareLink && (
                  <TextInput label="Share link" isLabelHidden value={shareLink} onChange={() => {}} isDisabled />
                )}
              </VStack>
            </VStack>
            <AlertDialog
              isOpen={confirmingStop}
              onOpenChange={(o) => !o && setConfirmingStop(false)}
              title={`Stop inheriting from ${parentName}?`}
              description={`${
                inherited.size === 0
                  ? ""
                  : `${inherited.size === 1 ? "1 person loses" : `${inherited.size} people lose`} access when you save. `
              }Later changes to ${parentName}’s sharing no longer reach this ${thing}; only the people listed here keep access.`}
              actionLabel="Stop inheriting"
              actionVariant="destructive"
              onAction={() => {
                setInherits(false);
                setConfirmingStop(false);
              }}
            />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="between" vAlign="center">
              {/* The link is minted on copy, so the button sits where the eye finishes. */}
              {isFolder ? (
                <span />
              ) : (
                <Button
                  label={copied ? "Copied" : "Copy link"}
                  variant="secondary"
                  icon={<LinkIcon size={15} />}
                  onClick={copyShareLink}
                />
              )}
              <HStack gap={2}>
                <Button label="Cancel" variant="ghost" onClick={onClose} />
                <Button label="Save" variant="primary" onClick={save} isLoading={saving} />
              </HStack>
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

/** One column for every row's access control, so they line up down the dialog. */
const ROLE_WIDTH = 132;

/** A round icon in an avatar's place, for rows that are not a person. */
function RowIcon({ icon }: { icon: ReactNode }) {
  return <span className="share-row-icon">{icon}</span>;
}
