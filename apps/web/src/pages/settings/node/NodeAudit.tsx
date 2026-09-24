/** The node's own audit rows, which belong to no workspace: node settings, admins, recovery links, pre-membership refusals. */
import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Table, pixel, proportional } from "@astryxdesign/core/Table";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { absoluteTime, fmtInt, relativeTime } from "../../../lib/format";
import { NodeSettings as NodeApi, type AuditCursor, type AuditEvent } from "../../../api";
import { resolveNames, useNamesVersion } from "../../../state/identity";
import { ActorName } from "../../../ui/ActorName";
import { actionLabel } from "../audit-labels";

const PAGE_SIZE = 50;

const CLAMP = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;
const KEEP = { flex: "0 0 auto" } as const;

export function NodeAudit() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  /** The cursor for the page after the loaded ones; null means none is left. */
  const [cursor, setCursor] = useState<AuditCursor | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useNamesVersion();

  useEffect(() => {
    let alive = true;
    NodeApi.audit({ limit: PAGE_SIZE })
      .then((r) => {
        if (!alive) return;
        setEvents(r.events);
        setCursor(r.next_before);
        resolveNames(r.events.map((e) => e.on_behalf_of ?? e.actor));
      })
      .catch(() => {
        if (alive) setFailed("Couldn’t load the node’s audit log.");
      });
    return () => {
      alive = false;
    };
  }, []);

  async function loadOlder(): Promise<void> {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const r = await NodeApi.audit({ limit: PAGE_SIZE, before_at: cursor.at, before_id: cursor.id });
      setEvents((prev) => [...(prev ?? []), ...r.events]);
      setCursor(r.next_before);
      resolveNames(r.events.map((e) => e.on_behalf_of ?? e.actor));
    } catch {
      setFailed("Couldn’t load older events.");
    } finally {
      setLoadingOlder(false);
    }
  }

  const columns = [
    {
      key: "at",
      header: "When",
      width: pixel(110),
      renderCell: (e: AuditEvent) => <span title={absoluteTime(e.at)}>{relativeTime(e.at)}</span>,
    },
    {
      key: "who",
      header: "Who",
      width: proportional(1),
      renderCell: (e: AuditEvent) => (
        <ActorName
          alias={e.on_behalf_of ?? e.actor}
          title={e.on_behalf_of ? `${e.actor} for ${e.on_behalf_of}` : e.actor}
        />
      ),
    },
    {
      key: "action",
      header: "What",
      width: proportional(1),
      renderCell: (e: AuditEvent) => (
        <HStack gap={2} vAlign="center" style={{ minWidth: 0 }}>
          {e.status !== "ok" && (
            <HStack style={KEEP}>
              <Token label="Refused" color="red" size="sm" />
            </HStack>
          )}
          <span title={e.action} style={CLAMP}>
            {actionLabel(e)}
          </span>
        </HStack>
      ),
    },
    {
      key: "target",
      header: "Target",
      width: proportional(1),
      renderCell: (e: AuditEvent) => (
        <span title={`${e.target_kind ?? "?"} · ${e.target_id ?? ""}`} style={CLAMP}>
          {e.target_label ?? e.target_id ?? "—"}
        </span>
      ),
    },
  ];

  return (
    <VStack gap={3}>
      <Heading level={2}>Node audit</Heading>
      <Text type="supporting" color="secondary">
        Node settings, administrators, recovery links and rejected requests. Workspace events stay in each workspace’s log.
      </Text>
      {failed && (
        <Text type="supporting" color="secondary">
          {failed}
        </Text>
      )}
      {!events && !failed && <Spinner label="Loading the node’s audit log…" />}
      {events && events.length === 0 && (
        <Text type="supporting" color="secondary">
          Nothing recorded yet.
        </Text>
      )}
      {events && events.length > 0 && (
        <>
          <Table data={events} columns={columns} idKey="id" dividers="rows" density="compact" />
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text type="supporting" color="secondary">
              {cursor
                ? `${fmtInt(events.length)} events loaded. There may be older ones.`
                : `${fmtInt(events.length)} events loaded. Nothing older is recorded.`}
            </Text>
            {cursor && (
              <Button
                label="Load older"
                variant="secondary"
                size="sm"
                isLoading={loadingOlder}
                onClick={() => void loadOlder()}
              />
            )}
          </HStack>
        </>
      )}
    </VStack>
  );
}
