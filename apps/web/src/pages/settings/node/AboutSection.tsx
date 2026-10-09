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
import { t } from "../../../i18n/i18n";
import { calendarDay, relativeTime, versionLabel } from "../../../lib/format";
import { presentServerMessage } from "../../../lib/http/server-messages";
import { SectionStatusBanners, useSectionStatus } from "./status";

/** The license the node is published under, by its SPDX identifier. */
const LICENSE = "AGPL-3.0-only"; // i18n-exempt: an SPDX identifier

/** The version, when it was released and how it was built, then what it was upgraded from. */
function versionLine(version: NodeVersion): string {
  const line = [
    version.version,
    // The one fact about a build's age that a node with no way out still has.
    version.released_at ? t("node.about.released", { date: calendarDay(version.released_at) }) : null,
    version.build === "source" ? t("node.about.fromSource") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return version.previous_version && version.previous_version !== version.version
    ? t("node.about.upgradedFrom", { version: line, previous: version.previous_version })
    : line;
}

/** What the node's environment and first boot fixed, read-only, and what it knows about newer versions. */
export function AboutSection({ ops, onSaved }: { ops: NodeOperationalSettings; onSaved: (s: NodeOperationalSettings) => void }) {
  const [version, setVersion] = useState<NodeVersion | null>(null);

  useEffect(() => {
    void NodeApi.version().then(setVersion).catch(() => {});
  }, []);

  return (
    <VStack gap={5}>
      <VStack gap={3}>
        <Heading level={2}>{t("node.about.thisNode")}</Heading>
        <Text type="supporting" color="secondary">
          {t("node.about.setInEnvironment", { hint: presentServerMessage(ops.restart_hint) })}
        </Text>
        <MetadataList columns="single" label={{ position: "start" }}>
          <MetadataListItem label={t("node.about.publicAddress")}>{ops.node.public_origin}</MetadataListItem>
          <MetadataListItem label={t("node.about.listeningOn")}>
            {ops.node.bind}:{ops.node.port}
          </MetadataListItem>
          <MetadataListItem label={t("node.about.dataDirectory")}>{ops.node.data_dir}</MetadataListItem>
          <MetadataListItem label={t("common.database")}>{ops.node.database}</MetadataListItem>
          {/* What agents and the switcher call the node: its name under Branding, else its host. */}
          <MetadataListItem label={t("node.about.knownToAgentsAs")}>{ops.node_label}</MetadataListItem>
          {/* Chosen at the first start and kept through a rename. */}
          <MetadataListItem label={t("node.about.nodeId")}>{ops.node.node_id}</MetadataListItem>
          {version && (
            <>
              <MetadataListItem label={t("node.about.version")}>{versionLine(version)}</MetadataListItem>
              {version.first_boot_at && (
                <MetadataListItem label={t("node.about.databaseCreated")}>{versionLabel(version.first_boot_at)}</MetadataListItem>
              )}
            </>
          )}
          <MetadataListItem label={t("node.about.license")}>
            {LICENSE} ·{" "}
            {version && (
              <>
                <Link href={version.source_url} isExternalLink>
                  {t("node.about.sourceCode")}
                </Link>{" "}
                ·{" "}
              </>
            )}
            <Link href="/third-party-licenses.txt" isExternalLink>
              {t("node.about.thirdPartyLicenses")}
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

/** The install states the progress line names; any other reads as starting. */
const INSTALL_STATES = new Set(["downloading", "verifying", "installing"]);

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
            status.setNotice({ status: "success", message: t("node.about.updatedTo", { version: target }) });
          } else if (state === "failed" || state === "refused") {
            setInstalling(null);
            status.setError(presentServerMessage(next.update.install.status!.message));
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
        <Heading level={2}>{t("node.about.updates")}</Heading>
        <Text type="supporting" color="secondary">
          {version.build === "source" ? t("node.about.sourceBuildUpdates") : t("node.about.notARelease", { version: version.version })}
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
          label={installing ? t("node.about.updating") : t("node.about.updateNow")}
          variant="primary"
          size="sm"
          isLoading={busy === "install" || installing !== null}
          isDisabled={busy !== "" || installing !== null}
          onClick={() => setConfirming(true)}
        />
      )}
      <Button
        label={t("node.about.releaseNotes")}
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
      <Heading level={2}>{t("node.about.updates")}</Heading>
      <SectionStatusBanners status={status} />
      {update.available ? (
        <Banner
          status={update.available.security ? "warning" : "info"}
          title={
            update.available.security
              ? t("node.about.securityUpdate", { version: update.available.version })
              : t("node.about.available", { version: update.available.version })
          }
          description={
            installing
              ? t("node.about.installing", {
                  state: progress?.state && INSTALL_STATES.has(progress.state) ? progress.state : "other",
                  version: installing,
                })
              : update.install.available
                ? t("node.about.installHint")
                : update.upgrade_hint && presentServerMessage(update.upgrade_hint)
          }
          endContent={notes}
        />
      ) : (
        <Text type="supporting" color="secondary">
          {update.error
            ? t("node.about.checkFailed", { error: presentServerMessage(update.error) })
            : update.checked_at
              ? t("node.about.upToDate", { when: relativeTime(update.checked_at) })
              : on
                ? t("node.about.notCheckedYet")
                : t("node.about.notChecking")}
        </Text>
      )}
      <Switch
        label={t("node.about.checkSwitch")}
        description={t("node.about.checkSwitchNote")}
        value={on}
        isDisabled={busy !== ""}
        isLoading={busy === "switch"}
        onChange={(v: boolean) => void setOn(v)}
      />
      <AlertDialog
        isOpen={confirming}
        onOpenChange={(o) => !o && setConfirming(false)}
        title={t("node.about.confirmTitle", { version: target ?? "" })}
        description={t("node.about.confirmBody")}
        actionLabel={t("node.about.update")}
        onAction={() => {
          setConfirming(false);
          void updateNow();
        }}
      />
      <HStack gap={2}>
        {on && (
          <Button
            label={t("node.about.checkNow")}
            variant="secondary"
            size="sm"
            isLoading={busy === "check"}
            isDisabled={busy !== ""}
            onClick={() => void act("check", look)}
          />
        )}
        {/* For a node that cannot look: a plain link, opened by the administrator's own browser. */}
        <Button
          label={t("node.about.allReleases")}
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
