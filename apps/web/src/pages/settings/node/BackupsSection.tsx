import { useCallback, useEffect, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { Check, Copy } from "lucide-react";
import { NodeSettings as NodeApi, type NodeBackup, type NodeBackups, type NodeOperationalSettings } from "../../../api";
import { formatLocale, t } from "../../../i18n/i18n";
import { tRich } from "../../../i18n/rich";
import { copyText } from "../../../lib/clipboard";
import { presentServerMessage } from "../../../lib/http/server-messages";
import { byteSize, relativeTime, versionLabel } from "../../../lib/format";
import { SectionStatusBanners, useSectionStatus } from "./status";

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }));

const REPEAT = [
  { value: "day", label: t("node.backups.everyDay") },
  { value: "week", label: t("node.backups.everyWeek") },
];

/** 0 is Sunday, as the node counts them; named in the reader's language from a week that starts on a Sunday (4 January 1970). */
const weekdayName = new Intl.DateTimeFormat(formatLocale(), { weekday: "long", timeZone: "UTC" });
const WEEKDAYS = Array.from({ length: 7 }, (_, day) => ({
  value: String(day),
  label: weekdayName.format(Date.UTC(1970, 0, 4 + day)),
}));

/** The one reason the node gives for holding a backup (boot.ts), worded here as a whole sentence. */
const ARCHIVE_WORK = "a workspace is being imported or exported";

/** Restoring is done on the node's machine; the operations guide walks through it. */
const RESTORE_DOCS_URL = "https://github.com/stuga-dev/stuga/blob/main/docs/operations.md#restore";

/** One width for every field on the page, so they line up whichever are shown. */
const FIELD_WIDTH = 160;

/** The weekday a backup that becomes weekly starts on. */
const FIRST_WEEKDAY = 0;

/** The counts offered, with whatever the node keeps now. */
function keepOptions(keep: number) {
  const counts = [...new Set([1, 2, 3, 5, 7, 10, 14, 30, keep])].sort((a, b) => a - b);
  return counts.map((n) => ({ value: String(n), label: t("node.backups.keepNewest", { count: n }) }));
}

/** How often the page asks whether a backup has finished. */
const POLL_MS = 2000;

/** The time zone this browser is in, which setup gave the node. */
function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

type Busy = "" | "switch" | "repeat" | "weekday" | "hour" | "zone" | "keep" | "now";

/** The scheduled backup, a backup now, and the backups the node keeps. */
export function BackupsSection({ ops, onSaved }: { ops: NodeOperationalSettings; onSaved: (s: NodeOperationalSettings) => void }) {
  const status = useSectionStatus();
  const [state, setState] = useState<NodeBackups | null>(null);
  const [busy, setBusy] = useState<Busy>("");
  /** Waiting for a backup this page started: the node pauses for it, so a failed read means "not yet". */
  const [waiting, setWaiting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The backup whose restore command is shown; kept while the dialog closes. */
  const [restoring, setRestoring] = useState<NodeBackup | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);

  const load = useCallback(async () => {
    const next = await NodeApi.backups();
    setState(next);
    return next;
  }, []);

  useEffect(() => {
    void load().catch((e: unknown) => status.fail(e));
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function poll() {
    timer.current = setTimeout(() => {
      load()
        .then((next) => {
          if (next.running) return poll();
          setWaiting(false);
          if (next.error) status.setError(t("node.backups.failedWith", { error: presentServerMessage(next.error) }));
          else status.setNotice({ status: "success", message: t("node.backups.backedUp") });
        })
        .catch(() => poll());
    }, POLL_MS);
  }

  async function act(key: Busy, fn: () => Promise<void>) {
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

  const save = (key: Busy, input: Parameters<typeof NodeApi.saveSettings>[0]) =>
    act(key, async () => {
      onSaved(await NodeApi.saveSettings(input));
      await load();
    });

  const backUpNow = () =>
    act("now", async () => {
      await NodeApi.backUpNow();
      setWaiting(true);
      poll();
    });

  const here = browserTimeZone();
  const zone = ops.time_zone;
  const { auto, hour, weekday, keep } = ops.backups;
  const newest = state?.backups[0] ?? null;
  /** Kept beyond `keep`, as the node's retention keeps it: what going back restores. */
  const lastUpgrade = state?.backups.find((b) => b.before_upgrade) ?? null;
  const total = state?.backups.reduce((sum, b) => sum + b.bytes, 0) ?? 0;

  return (
    <VStack gap={5}>
      {/* What a backup is, where it goes and how to get it back, before any control. */}
      <VStack gap={1}>
        <Text color="secondary">{t("node.backups.intro")}</Text>
        <Text color="secondary">
          {state ? t("node.backups.where", { dir: state.dir }) : " "}
        </Text>
        <Text color="secondary">
          {tRich("node.backups.restoreHelp", {
            link: (chunks) => (
              <Link href={RESTORE_DOCS_URL} isExternalLink>
                {chunks}
              </Link>
            ),
          })}
        </Text>
      </VStack>
      <SectionStatusBanners status={status} />
      {state?.error && !waiting && !status.error && (
        <Banner status="warning" title={t("node.backups.lastFailed")} description={presentServerMessage(state.error)} />
      )}

      <VStack gap={3}>
        <HStack hAlign="between" vAlign="center" gap={3}>
          <VStack gap={0}>
            <Heading level={2}>{t("node.backups.scheduled")}</Heading>
            <Text type="supporting" color="secondary">
              {t("node.backups.scheduledNote")}
            </Text>
          </VStack>
          <Switch
            label={t("node.backups.scheduled")}
            isLabelHidden
            value={auto}
            isDisabled={busy !== ""}
            isLoading={busy === "switch"}
            onChange={(v: boolean) => void save("switch", { backups: { auto: v } })}
          />
        </HStack>
        {auto && (
          <HStack gap={3} vAlign="end" wrap="wrap">
            <Selector
              label={t("node.backups.repeat")}
              width={FIELD_WIDTH}
              value={weekday === null ? "day" : "week"}
              options={REPEAT}
              isDisabled={busy !== ""}
              onChange={(v) => void save("repeat", { backups: { weekday: v === "day" ? null : FIRST_WEEKDAY } })}
            />
            {weekday !== null && (
              <Selector
                label={t("node.backups.on")}
                width={FIELD_WIDTH}
                value={String(weekday)}
                options={WEEKDAYS}
                isDisabled={busy !== ""}
                onChange={(v) => void save("weekday", { backups: { weekday: Number(v) } })}
              />
            )}
            <Selector
              label={t("node.backups.at")}
              width={FIELD_WIDTH}
              value={String(hour)}
              options={HOURS}
              isDisabled={busy !== ""}
              onChange={(v) => void save("hour", { backups: { hour: Number(v) } })}
            />
          </HStack>
        )}
        {auto && (
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text type="supporting" color="secondary">
              {state?.next_at ? t("node.backups.next", { when: versionLabel(state.next_at), zone }) : zone}
            </Text>
            {here && here !== zone && (
              <Button
                label={t("node.backups.useZone", { zone: here })}
                variant="ghost"
                size="sm"
                isLoading={busy === "zone"}
                isDisabled={busy !== ""}
                onClick={() => void save("zone", { time_zone: here })}
              />
            )}
          </HStack>
        )}
      </VStack>

      <VStack gap={3}>
        <HStack hAlign="between" vAlign="center" gap={3}>
          <VStack gap={0}>
            <Heading level={2}>{t("node.backups.recent")}</Heading>
            {state && state.backups.length > 0 && (
              <Text type="supporting" color="secondary">
                {t("node.backups.totalSize", { size: byteSize(total) })}
              </Text>
            )}
          </VStack>
          <Button
            label={waiting ? t("node.backups.backingUp") : t("node.backups.backUpNow")}
            variant="secondary"
            size="sm"
            isLoading={busy === "now" || waiting}
            isDisabled={busy !== "" || waiting || state?.running === true}
            onClick={() => void backUpNow()}
          />
        </HStack>
        <Selector
          label={t("node.backups.keep")}
          width={FIELD_WIDTH}
          value={String(keep)}
          options={keepOptions(keep)}
          isDisabled={busy !== ""}
          onChange={(v) => void save("keep", { backups: { keep: Number(v) } })}
        />
        {state?.waiting && (
          <Text type="supporting" color="secondary">
            {state.waiting === ARCHIVE_WORK ? t("node.backups.waitingArchive") : t("node.backups.waiting", { reason: state.waiting })}
          </Text>
        )}
        {state && state.backups.length === 0 && (
          <Text type="supporting" color="secondary">
            {t("node.backups.none")}
          </Text>
        )}
        {state && state.backups.length > 0 && (
          <List hasDividers density="compact">
            {state.backups.map((b) => {
              const note = [
                b === newest ? relativeTime(b.created_at) : null,
                b.before_upgrade
                  ? b.stuga_version
                    ? t("node.backups.beforeUpgradeFrom", { version: b.stuga_version })
                    : t("node.backups.beforeUpgrade")
                  : null,
                b === lastUpgrade && state.backups.indexOf(b) >= keep ? t("node.backups.keptUntilUpgrade") : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <ListItem
                  key={b.name}
                  label={versionLabel(b.created_at)}
                  description={note || undefined}
                  endContent={
                    <HStack gap={2} vAlign="center">
                      <Text type="supporting" color="secondary">
                        {byteSize(b.bytes)}
                      </Text>
                      {b.restore_command && (
                        <Button
                          label={t("node.backups.restore")}
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setRestoring(b);
                            setRestoreOpen(true);
                          }}
                        />
                      )}
                    </HStack>
                  }
                />
              );
            })}
          </List>
        )}
      </VStack>
      <RestoreDialog backup={restoring} isOpen={restoreOpen} onClose={() => setRestoreOpen(false)} />
    </VStack>
  );
}

/**
 * The command that restores a backup on the node's machine. The page only shows it: going back is done there,
 * and whether that packaging can go back to the backup's version is the command's to say, before it changes anything.
 */
function RestoreDialog({ backup, isOpen, onClose }: { backup: NodeBackup | null; isOpen: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen) setCopied(false);
  }, [isOpen, backup]);

  const command = backup?.restore_command ?? "";
  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && onClose()} width={520}>
      <Layout
        header={<DialogHeader title={t("node.backups.restoreTitle")} onOpenChange={(o) => !o && onClose()} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              <Text type="supporting" color="secondary">
                {t("node.backups.restoreBody")}
              </Text>
              <CodeBlock code={command} language="bash" width="100%" isWrapped size="sm" hasCopyButton={false} />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button
                label={copied ? t("common.copied") : t("common.copy")}
                variant="secondary"
                icon={copied ? <Check size={15} /> : <Copy size={15} />}
                onClick={() => void copyText(command).then(setCopied)}
              />
              <Button label={t("common.done")} variant="primary" onClick={onClose} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
