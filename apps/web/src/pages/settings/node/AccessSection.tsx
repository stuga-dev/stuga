import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Button } from "@astryxdesign/core/Button";
import { StackItem } from "@astryxdesign/core/Stack";
import { Banner } from "@astryxdesign/core/Banner";
import { Divider } from "@astryxdesign/core/Divider";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { NodeSettings as NodeApi, type NodeAdmin, type NodeOperationalSettings, type RevokeEverythingCounts } from "../../../api";
import { providerLabel } from "../../../lib/session/auth-config";
import { getAlias } from "../../../lib/http/client";
import { PersonPicker, type PersonItem } from "../../../ui/PersonPicker";
import { NodeAudit } from "./NodeAudit";
import { IdentityProviderSection } from "./IdentityProviderSection";
import { SectionStatusBanners, useSectionStatus } from "./status";
import { LinkAddressSwitch, localOnlyNote, useLinkAddresses, type LinkAddress } from "../../../ui/LinkAddress";
import { formatLocale, t, uiLanguage } from "../../../i18n/i18n";
import { presentServerMessage } from "../../../lib/http/server-messages";

/**
 * Who may reach and administer this node, most used first: administrators,
 * account recovery, the identity provider, allowed origins and the node ledger.
 * An alert about someone's sign-in opens account recovery with them picked (?revoke=<username>).
 */
export function AccessSection({
  ops,
  onSaved,
}: {
  ops: NodeOperationalSettings | null;
  onSaved: (ops: NodeOperationalSettings) => void;
}) {
  const status = useSectionStatus();
  const [admins, setAdmins] = useState<NodeAdmin[] | null>(null);
  const [adminsFailed, setAdminsFailed] = useState(false);
  const [newAdmin, setNewAdmin] = useState<PersonItem | null>(null);
  const [resetFor, setResetFor] = useState<PersonItem | null>(null);
  /** The link just minted, shown once: only its hash is kept. */
  const [reset, setReset] = useState<{ url: string; name: string; address: LinkAddress } | null>(null);
  const addresses = useLinkAddresses(true);
  /** Where a password link opens, while there is a choice: the administrator's own address until they pick. */
  const [chosenAddress, setChosenAddress] = useState<LinkAddress | null>(null);
  const linkAddress: LinkAddress = chosenAddress ?? addresses?.default ?? "local";
  /** Sent only when there is a choice; otherwise the node points it where the administrator is. */
  const requested = addresses?.remote ? linkAddress : undefined;
  /** Revoke everything for `resetFor`, once its counts are in. */
  const [revoking, setRevoking] = useState<{ person: PersonItem; counts: RevokeEverythingCounts | null } | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const nav = useNavigate();
  const { pathname, search } = useLocation();

  // An alert's link names the person: pick them, once.
  useEffect(() => {
    const username = new URLSearchParams(search).get("revoke");
    if (!username) return;
    nav(pathname, { replace: true });
    void NodeApi.users(username)
      .then(({ users }) => {
        const found = users.find((u) => u.username === username);
        if (found) setResetFor({ id: found.alias, label: found.display_name || found.username || found.alias, auxiliaryData: found });
      })
      .catch(() => {});
  }, [search, pathname, nav]);

  function askRevoke(person: PersonItem) {
    setRevoking({ person, counts: null });
    NodeApi.revokeEverythingCounts(person.id)
      .then((counts) => setRevoking((cur) => (cur?.person.id === person.id ? { person, counts } : cur)))
      .catch(() => {});
  }

  async function revoke() {
    if (!revoking || revokeBusy) return;
    setRevokeBusy(true);
    try {
      const { password_link } = await NodeApi.revokeEverythingFor(revoking.person.id, requested);
      setReset({ url: password_link.url, name: revoking.person.label, address: linkAddress });
      setResetFor(null);
      setRevoking(null);
    } catch (e) {
      status.fail(e);
      setRevoking(null);
    } finally {
      setRevokeBusy(false);
    }
  }

  const loadAdmins = useCallback(
    () =>
      NodeApi.admins().then((r) => {
        setAdmins(r.admins);
        setAdminsFailed(false);
      }),
    [],
  );

  useEffect(() => {
    loadAdmins().catch(() => setAdminsFailed(true));
  }, [loadAdmins]);

  return (
    <>
      <SectionStatusBanners status={status} />
      <VStack gap={3}>
        <Heading level={2}>{t("nodeAccess.admins.heading")}</Heading>
        <Text type="supporting" color="secondary">
          {t("nodeAccess.admins.intro")}
        </Text>
        {adminsFailed && <Text color="secondary">{t("nodeAccess.admins.loadFailed")}</Text>}
        {admins?.map((a) => (
          <HStack key={a.alias} hAlign="between" vAlign="center">
            <VStack gap={0}>
              <Text>{a.display_name || a.alias}</Text>
              <Text type="supporting" color="secondary">
                {a.granted_by ? t("nodeAccess.admins.appointed", { username: a.username }) : t("nodeAccess.admins.claimed", { username: a.username })}
              </Text>
            </VStack>
            <Button
              label={t("common.remove")}
              variant="ghost"
              size="sm"
              onClick={() => {
                void NodeApi.removeAdmin(a.alias).then(loadAdmins).catch(status.fail);
              }}
            />
          </HStack>
        ))}
        <HStack gap={2} vAlign="end">
          <StackItem size="fill">
            <PersonPicker
              label={t("nodeAccess.admins.add")}
              search={(q, signal) => NodeApi.users(q, { signal }).then((r) => r.users)}
              exclude={admins?.map((a) => a.alias)}
              value={newAdmin}
              onChange={setNewAdmin}
            />
          </StackItem>
          <Button
            label={t("nodeAccess.admins.appoint")}
            variant="secondary"
            isDisabled={!newAdmin?.auxiliaryData?.username}
            onClick={() => {
              const username = newAdmin?.auxiliaryData?.username;
              if (!username) return;
              void NodeApi.addAdmin(username)
                .then(() => {
                  setNewAdmin(null);
                  return loadAdmins();
                })
                .catch(status.fail);
            }}
          />
        </HStack>
      </VStack>

      <Divider />

      <VStack gap={3}>
        <Heading level={2}>{t("nodeAccess.recovery.heading")}</Heading>
        <Text type="supporting" color="secondary">
          {t("nodeAccess.recovery.intro")}
        </Text>
        <LinkAddressSwitch addresses={addresses} value={linkAddress} onChange={setChosenAddress} />
        <HStack gap={2} vAlign="end">
          <StackItem size="fill">
            <PersonPicker
              label={t("nodeAccess.recovery.account")}
              search={(q, signal) => NodeApi.users(q, { signal }).then((r) => r.users)}
              value={resetFor}
              onChange={setResetFor}
            />
          </StackItem>
          <Button
            label={t("nodeAccess.recovery.revokeEverything")}
            variant="secondary"
            isDisabled={!resetFor || resetFor.id === getAlias()}
            // Your own takes a new password, which Profile asks for.
            tooltip={resetFor && resetFor.id === getAlias() ? t("nodeAccess.recovery.revokeSelf") : undefined}
            onClick={() => resetFor && askRevoke(resetFor)}
          />
          <Button
            label={t("nodeAccess.recovery.createLink")}
            variant="secondary"
            isDisabled={!resetFor?.auxiliaryData?.username}
            onClick={() => {
              const picked = resetFor;
              const username = picked?.auxiliaryData?.username;
              if (!picked || !username) return;
              void NodeApi.mintPasswordReset(username, requested)
                .then((r) => {
                  setReset({ url: r.url, name: picked.label, address: linkAddress });
                  setResetFor(null);
                })
                .catch(status.fail);
            }}
          />
        </HStack>
        {reset && (
          <Banner
            status="info"
            title={t("nodeAccess.recovery.linkFor", { name: reset.name })}
            description={
              <VStack gap={1}>
                <Text type="supporting">{reset.url}</Text>
                {localOnlyNote(addresses, reset.address) && <Text type="supporting">{localOnlyNote(addresses, reset.address)}</Text>}
              </VStack>
            }
          />
        )}
        <Dialog isOpen={revoking !== null} onOpenChange={(o) => !o && !revokeBusy && setRevoking(null)} purpose="form" width={440}>
          <Layout
            header={
              <DialogHeader
                title={t("nodeAccess.recovery.revokeTitle", { name: revoking?.person.label ?? "" })}
                onOpenChange={(o) => !o && !revokeBusy && setRevoking(null)}
              />
            }
            content={
              <LayoutContent>
                <Text type="supporting" color="secondary">
                  {memberRevokeSummary(revoking?.counts ?? null, providerLabel())}
                </Text>
              </LayoutContent>
            }
            footer={
              <LayoutFooter>
                <HStack gap={2} justify="end">
                  <Button label={t("common.cancel")} variant="ghost" onClick={() => setRevoking(null)} isDisabled={revokeBusy} />
                  <Button label={t("nodeAccess.recovery.revokeEverything")} variant="primary" onClick={() => void revoke()} isLoading={revokeBusy} />
                </HStack>
              </LayoutFooter>
            }
          />
        </Dialog>
      </VStack>

      {ops && (
        <>
          <Divider />
          <IdentityProviderSection ops={ops} onSaved={onSaved} />
          <Divider />
          <VStack gap={3}>
            <Heading level={2}>{t("nodeAccess.network.heading")}</Heading>
            {/* An origin here is a caller the node answers; only the remote address is also one it serves. */}
            <Text type="supporting" color="secondary">
              {t("nodeAccess.network.intro")}
            </Text>
            <MetadataList columns="single" label={{ position: "start" }}>
              <MetadataListItem label={t("nodeAccess.network.publicAddress")}>{ops.node.public_origin}</MetadataListItem>
              <MetadataListItem label={t("nodeAccess.network.alsoAccepted")}>
                {ops.node.extra_origins.length > 0 ? (
                  <VStack gap={0}>
                    {ops.node.extra_origins.map((o) => (
                      <Text key={o}>{o}</Text>
                    ))}
                  </VStack>
                ) : (
                  t("nodeAccess.network.none")
                )}
              </MetadataListItem>
              {/* Answered only for pages served there, and never for the addresses above. */}
              {ops.node.remote_origin && <MetadataListItem label={t("nodeAccess.network.remoteAddress")}>{ops.node.remote_origin}</MetadataListItem>}
            </MetadataList>
            <Text type="supporting" color="secondary">
              {ops.node.remote_origin ? t("nodeAccess.network.setWithRemote") : t("nodeAccess.network.setWith")}{" "}
              {presentServerMessage(ops.restart_hint)}
            </Text>
          </VStack>
        </>
      )}

      <Divider />
      <NodeAudit />
    </>
  );
}

/** What the confirmation says Revoke everything takes from someone, from the node's count. */
export function memberRevokeSummary(counts: RevokeEverythingCounts | null, provider: string | null): string {
  const parts = [t("nodeAccess.recovery.theirPassword")];
  if (counts && counts.passkeys > 0) parts.push(t("nodeAccess.recovery.passkeys", { count: counts.passkeys }));
  if (counts?.provider) {
    parts.push(provider ? t("nodeAccess.recovery.providerSignIn", { provider }) : t("nodeAccess.recovery.identityProviderSignIn"));
  }
  if (counts && counts.apps > 0) parts.push(t("nodeAccess.recovery.apps", { count: counts.apps }));
  if (counts && counts.api_keys > 0) parts.push(t("nodeAccess.recovery.apiKeys", { count: counts.api_keys }));
  const links = counts ? counts.invites + counts.share_links : 0;
  if (links > 0) parts.push(t("nodeAccess.recovery.links", { count: links }));
  return t("nodeAccess.recovery.summary", { list: conjunction(parts) });
}

/** "a, b and c" in the reader's language; English keeps the house style, with no serial comma. */
function conjunction(items: string[]): string {
  const locale = uiLanguage() === "en" ? "en-GB" : formatLocale();
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(items);
}
