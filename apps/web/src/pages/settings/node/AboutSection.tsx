import { useEffect, useRef, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Link } from "@astryxdesign/core/Link";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Switch } from "@astryxdesign/core/Switch";
import { ExternalLink } from "lucide-react";
import { NodeSettings as NodeApi, type NodeOperationalSettings, type NodeVersion } from "../../../api";
import { calendarDay, relativeTime, versionLabel } from "../../../lib/format";
import { SectionStatusBanners, useSectionStatus } from "./status";

/** Display names for SEARCH_LANGUAGES codes. */
const SEARCH_LANGUAGE_LABELS: Record<string, string> = {
  ko: "Korean",
  ar: "Arabic",
};

/** What the node's environment and first boot fixed, read-only, and what it knows about newer versions. */
export function AboutSection({ ops, onSaved }: { ops: NodeOperationalSettings; onSaved: (s: NodeOperationalSettings) => void }) {
  const [version, setVersion] = useState<NodeVersion | null>(null);

  useEffect(() => {
    void NodeApi.version().then(setVersion).catch(() => {});
  }, []);

  return (
    <VStack gap={5}>
      <VStack gap={3}>
        <Heading level={2}>This node</Heading>
        <Text type="supporting" color="secondary">
          Set in the node&apos;s environment. {ops.restart_hint}
        </Text>
        <MetadataList columns="single" label={{ position: "start" }}>
          <MetadataListItem label="Public address">{ops.node.public_origin}</MetadataListItem>
          <MetadataListItem label="Listening on">
            {ops.node.bind}:{ops.node.port}
          </MetadataListItem>
          <MetadataListItem label="Data directory">{ops.node.data_dir}</MetadataListItem>
          <MetadataListItem label="Database">{ops.node.database}</MetadataListItem>
          <MetadataListItem label="Search languages">
            {ops.node.search_languages.length > 0
              ? ops.node.search_languages.map((l) => SEARCH_LANGUAGE_LABELS[l] ?? l).join(", ")
              : "None — every document gets the generic multi-language tokenizer only"}
          </MetadataListItem>
          {/* What agents and the switcher call the node: its name under Branding, else its host. */}
          <MetadataListItem label="Known to agents as">{ops.node_label}</MetadataListItem>
          {/* Chosen at the first start and kept through a rename. */}
          <MetadataListItem label="Node ID">{ops.node.node_id}</MetadataListItem>
          {version && (
            <>
              <MetadataListItem label="Version">
                {version.version}
                {/* The one fact about a build's age that a node with no way out still has. */}
                {version.released_at ? ` · released ${calendarDay(version.released_at)}` : ""}
                {version.build === "source" ? " · built from source" : ""}
                {version.previous_version && version.previous_version !== version.version
                  ? ` (upgraded from ${version.previous_version})`
                  : ""}
              </MetadataListItem>
              {version.first_boot_at && (
                <MetadataListItem label="Database created">{versionLabel(version.first_boot_at)}</MetadataListItem>
              )}
            </>
          )}
          <MetadataListItem label="License">
            AGPL-3.0-only ·{" "}
            {version && (
              <>
                <Link href={version.source_url} isExternalLink>
                  Source code
                </Link>{" "}
                ·{" "}
              </>
            )}
            <Link href="/third-party-licenses.txt" isExternalLink>
              Third-party licenses
            </Link>
          </MetadataListItem>
        </MetadataList>
      </VStack>
      {version && <Updates ops={ops} onSaved={onSaved} version={version} onChecked={setVersion} />}
    </VStack>
  );
}

/** How often the page asks how an install is going; the node restarts partway, so a failed ask is "not yet". */
const INSTALL_POLL_MS = 3000;

const INSTALL_SAYS: Record<string, string> = {
  downloading: "Downloading",
  verifying: "Checking",
  installing: "Installing",
};

/** A newer version, the switch that looks for one, and a look on request. */
function Updates({
  ops,
  onSaved,
  version,
  onChecked,
}: {
  ops: NodeOperationalSettings;
  onSaved: (s: NodeOperationalSettings) => void;
  version: NodeVersion;
  onChecked: (v: NodeVersion) => void;
}) {
  const status = useSectionStatus();
  const [busy, setBusy] = useState<"" | "switch" | "check" | "install">("");
  /** The version this page asked the machine to install, until the node runs it or says it failed. */
  const [installing, setInstalling] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { update } = version;
  const on = ops.updates.check;

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function watchInstall(target: string) {
    timer.current = setTimeout(() => {
      NodeApi.version()
        .then((next) => {
          onChecked(next);
          const state = next.update.install.status?.state;
          if (next.version === target) {
            setInstalling(null);
            status.setNotice({ status: "success", message: `Updated to Stuga ${target}.` });
          } else if (state === "failed" || state === "refused") {
            setInstalling(null);
            status.setError(next.update.install.status!.message);
          } else {
            watchInstall(target);
          }
        })
        .catch(() => watchInstall(target));
    }, INSTALL_POLL_MS);
  }

  async function act(key: "switch" | "check" | "install", fn: () => Promise<void>) {
    setBusy(key);
    status.clear();
    try {
      await fn();
    } catch (e) {
      status.fail(e);
    } finally {
      setBusy("");
    }
  }

  const look = async () => onChecked(await NodeApi.checkVersion());

  const setOn = (next: boolean) =>
    act("switch", async () => {
      onSaved(await NodeApi.saveSettings({ updates: { check: next } }));
      // Turned on to see the answer, not tomorrow's.
      if (next) await look();
    });

  // Only a plain 1.2.3 has releases to compare with; anything else never looks.
  if (!update.comparable) {
    return (
      <VStack gap={3}>
        <Heading level={2}>Updates</Heading>
        <Text type="supporting" color="secondary">
          {version.build === "source"
            ? "Built from source: update the checkout and rebuild."
            : `${version.version} is not a release, so there is nothing to compare it with.`}
        </Text>
      </VStack>
    );
  }

  const target = update.available?.version ?? null;
  const updateNow = () =>
    act("install", async () => {
      if (!target) return;
      onChecked(await NodeApi.installVersion(target));
      setInstalling(target);
      watchInstall(target);
    });
  const progress = installing ? version.update.install.status : null;

  const notes = update.available && (
    <HStack gap={2}>
      {update.install.available && (
        <Button
          label={installing ? "Updating…" : "Update now"}
          variant="primary"
          size="sm"
          isLoading={busy === "install" || installing !== null}
          isDisabled={busy !== "" || installing !== null}
          onClick={() => setConfirming(true)}
        />
      )}
      <Button
        label="Release notes"
        variant="secondary"
        size="sm"
        endContent={<ExternalLink size={14} />}
        href={update.available.notes_url}
        target="_blank"
        rel="noopener noreferrer"
      />
    </HStack>
  );

  return (
    <VStack gap={3}>
      <Heading level={2}>Updates</Heading>
      <SectionStatusBanners status={status} />
      {update.available ? (
        <Banner
          status={update.available.security ? "warning" : "info"}
          title={
            update.available.security
              ? `Security update: Stuga ${update.available.version}`
              : `Stuga ${update.available.version} is available`
          }
          description={
            installing
              ? `${INSTALL_SAYS[progress?.state ?? ""] ?? "Starting"} Stuga ${installing}… The node backs up first, then restarts.`
              : update.install.available
                ? "The node backs up, installs it and restarts."
                : update.upgrade_hint
          }
          endContent={notes}
        />
      ) : (
        <Text type="supporting" color="secondary">
          {update.error
            ? `Couldn’t check: ${update.error}.`
            : update.checked_at
              ? `Up to date. Checked ${relativeTime(update.checked_at)}.`
              : on
                ? "Not checked yet."
                : "Not checking."}
        </Text>
      )}
      <Switch
        label="Check for new versions"
        description="Checks GitHub daily. Sends no node data."
        value={on}
        isDisabled={busy !== ""}
        isLoading={busy === "switch"}
        onChange={(v: boolean) => void setOn(v)}
      />
      <AlertDialog
        isOpen={confirming}
        onOpenChange={(o) => !o && setConfirming(false)}
        title={`Update to Stuga ${target ?? ""}?`}
        description="The node backs up, installs the update and restarts. Everyone is disconnected for a few minutes."
        actionLabel="Update"
        onAction={() => {
          setConfirming(false);
          void updateNow();
        }}
      />
      <HStack gap={2}>
        {on && (
          <Button
            label="Check now"
            variant="secondary"
            size="sm"
            isLoading={busy === "check"}
            isDisabled={busy !== ""}
            onClick={() => void act("check", look)}
          />
        )}
        {/* For a node that cannot look: a plain link, opened by the administrator's own browser. */}
        <Button
          label="All releases"
          variant="ghost"
          size="sm"
          endContent={<ExternalLink size={14} />}
          href={update.releases_url}
          target="_blank"
          rel="noopener noreferrer"
        />
      </HStack>
    </VStack>
  );
}
