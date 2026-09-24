import { useCallback, useEffect, useState } from "react";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Button } from "@astryxdesign/core/Button";
import { StackItem } from "@astryxdesign/core/Stack";
import { Banner } from "@astryxdesign/core/Banner";
import { Divider } from "@astryxdesign/core/Divider";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { NodeSettings as NodeApi, type NodeAdmin, type NodeOperationalSettings } from "../../../api";
import { PersonPicker, type PersonItem } from "../../../ui/PersonPicker";
import { NodeAudit } from "./NodeAudit";
import { IdentityProviderSection } from "./IdentityProviderSection";
import { SectionStatusBanners, useSectionStatus } from "./status";

/**
 * Who may reach and administer this node, most used first: administrators,
 * account recovery, the identity provider, allowed origins and the node ledger.
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
  const [reset, setReset] = useState<{ url: string; name: string } | null>(null);

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
        <Heading level={2}>Administrators</Heading>
        <Text type="supporting" color="secondary">
          Manage node settings and recover accounts. This is separate from workspace roles.
        </Text>
        {adminsFailed && <Text color="secondary">Couldn’t load the administrators.</Text>}
        {admins?.map((a) => (
          <HStack key={a.alias} hAlign="between" vAlign="center">
            <VStack gap={0}>
              <Text>{a.display_name || a.alias}</Text>
              <Text type="supporting" color="secondary">
                @{a.username} · {a.granted_by ? "appointed" : "claimed this node"}
              </Text>
            </VStack>
            <Button
              label="Remove"
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
              label="Add an administrator"
              search={(q, signal) => NodeApi.users(q, { signal }).then((r) => r.users)}
              exclude={admins?.map((a) => a.alias)}
              value={newAdmin}
              onChange={setNewAdmin}
            />
          </StackItem>
          <Button
            label="Appoint"
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
        <Heading level={2}>Account recovery</Heading>
        <Text type="supporting" color="secondary">
          Create a one-time password reset link. Copy it now; using it ends the account’s other sessions.
        </Text>
        <HStack gap={2} vAlign="end">
          <StackItem size="fill">
            <PersonPicker
              label="Account"
              search={(q, signal) => NodeApi.users(q, { signal }).then((r) => r.users)}
              value={resetFor}
              onChange={setResetFor}
            />
          </StackItem>
          <Button
            label="Create link"
            variant="secondary"
            isDisabled={!resetFor?.auxiliaryData?.username}
            onClick={() => {
              const picked = resetFor;
              const username = picked?.auxiliaryData?.username;
              if (!picked || !username) return;
              void NodeApi.mintPasswordReset(username)
                .then((r) => {
                  setReset({ url: r.url, name: picked.label });
                  setResetFor(null);
                })
                .catch(status.fail);
            }}
          />
        </HStack>
        {reset && (
          <Banner
            status="info"
            title={`Password link for ${reset.name}. Copy it now — it is not shown again`}
            description={<Text type="supporting">{reset.url}</Text>}
          />
        )}
      </VStack>

      {ops && (
        <>
          <Divider />
          <IdentityProviderSection ops={ops} onSaved={onSaved} />
          <Divider />
          <VStack gap={3}>
            <Heading level={2}>Network access</Heading>
            {/* An origin here is a caller the node answers, never a second address it serves. */}
            <Text type="supporting" color="secondary">
              Browsers may call this node only from these origins.
            </Text>
            <MetadataList columns="single" label={{ position: "start" }}>
              <MetadataListItem label="Public address">{ops.node.public_origin}</MetadataListItem>
              <MetadataListItem label="Also accepted from">
                {ops.node.extra_origins.length > 0 ? (
                  <VStack gap={0}>
                    {ops.node.extra_origins.map((o) => (
                      <Text key={o}>{o}</Text>
                    ))}
                  </VStack>
                ) : (
                  "None"
                )}
              </MetadataListItem>
            </MetadataList>
            <Text type="supporting" color="secondary">
              Set with PUBLIC_ORIGIN and EXTRA_ORIGINS. {ops.restart_hint}
            </Text>
          </VStack>
        </>
      )}

      <Divider />
      <NodeAudit />
    </>
  );
}
