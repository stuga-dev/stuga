import { useCallback, useEffect, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { NodeSettings as NodeApi, type NodeBackups, type NodeOperationalSettings } from "../../../api";
import { relativeTime, versionLabel } from "../../../lib/format";
import { SectionStatusBanners, useSectionStatus } from "./status";

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }));

/** How often the page asks whether a backup has finished. */
const POLL_MS = 2000;

/** "12 MB". */
function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The time zone this browser is in, which setup gave the node. */
function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The daily backup, a backup now, and the backups the node keeps. */
export function BackupsSection({ ops, onSaved }: { ops: NodeOperationalSettings; onSaved: (s: NodeOperationalSettings) => void }) {
  const status = useSectionStatus();
  const [state, setState] = useState<NodeBackups | null>(null);
  const [busy, setBusy] = useState<"" | "switch" | "hour" | "zone" | "now">("");
  /** Waiting for a backup this page started: the node pauses for it, so a failed read means "not yet". */
  const [waiting, setWaiting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          if (next.error) status.setError(`The backup failed: ${next.error}`);
          else status.setNotice({ status: "success", message: "Backed up." });
        })
        .catch(() => poll());
    }, POLL_MS);
  }

  async function act(key: "switch" | "hour" | "zone" | "now", fn: () => Promise<void>) {
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

  const save = (key: "switch" | "hour" | "zone", input: Parameters<typeof NodeApi.saveSettings>[0]) =>
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
  const newest = state?.backups[0] ?? null;

  return (
    <VStack gap={5}>
      <SectionStatusBanners status={status} />
      {state?.error && !waiting && !status.error && (
        <Banner status="warning" title="The last backup failed" description={state.error} />
      )}

      <VStack gap={3}>
        <Heading level={2}>Daily backup</Heading>
        <Text type="supporting" color="secondary">
          The node pauses for a moment while it backs up.
        </Text>
        <Switch
          label="Back up every day"
          value={ops.backups.auto}
          isDisabled={busy !== ""}
          isLoading={busy === "switch"}
          onChange={(v: boolean) => void save("switch", { backups: { auto: v } })}
        />
        {ops.backups.auto && (
          <HStack gap={3} vAlign="end" wrap="wrap">
            <Selector
              label="At"
              description={zone}
              value={String(ops.backups.hour)}
              options={HOURS}
              isDisabled={busy !== ""}
              onChange={(v) => void save("hour", { backups: { hour: Number(v) } })}
            />
            {here && here !== zone && (
              <Button
                label={`Use ${here}`}
                variant="ghost"
                size="sm"
                isLoading={busy === "zone"}
                isDisabled={busy !== ""}
                onClick={() => void save("zone", { time_zone: here })}
              />
            )}
          </HStack>
        )}
        {state?.next_at && (
          <Text type="supporting" color="secondary">
            Next: {versionLabel(state.next_at)}
          </Text>
        )}
      </VStack>

      <VStack gap={3}>
        <Heading level={2}>Backups</Heading>
        <Text type="supporting" color="secondary">
          {state ? `The newest ${state.keep}, in ${state.dir}.` : " "}
        </Text>
        <HStack gap={2}>
          <Button
            label={waiting ? "Backing up…" : "Back up now"}
            variant="secondary"
            size="sm"
            isLoading={busy === "now" || waiting}
            isDisabled={busy !== "" || waiting || state?.running === true}
            onClick={() => void backUpNow()}
          />
        </HStack>
        {state?.waiting && (
          <Text type="supporting" color="secondary">
            Waiting to back up: {state.waiting}.
          </Text>
        )}
        {state && state.backups.length === 0 && (
          <Text type="supporting" color="secondary">
            No backups yet.
          </Text>
        )}
        {state && state.backups.length > 0 && (
          <List hasDividers density="compact">
            {state.backups.map((b) => (
              <ListItem
                key={b.name}
                label={versionLabel(b.created_at)}
                description={[
                  size(b.bytes),
                  b.before_upgrade ? `before upgrading from ${b.stuga_version ?? "an earlier version"}` : null,
                  b === newest ? relativeTime(b.created_at) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            ))}
          </List>
        )}
      </VStack>
    </VStack>
  );
}
