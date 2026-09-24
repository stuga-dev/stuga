/**
 * The workspace audit log. Each row leads with its accountable principal,
 * `COALESCE(on_behalf_of, actor)`, named with the handle that tells two people
 * of one name apart, and with the instrument (the co-author's
 * `panel:<alias>`, a connector's agent) under the name; Who and Agent filter
 * those separately and AND on the server. Filters live in the URL so a view can
 * be linked. Menus come from facets over the whole window, falling back to the
 * loaded rows. A row's target keeps the label it was recorded with.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import type { ISODateString } from "@astryxdesign/core/Calendar";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { DateRangeInput, type DateRange } from "@astryxdesign/core/DateRangeInput";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { Link } from "@astryxdesign/core/Link";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Table, proportional, pixel, useTableRowExpansion } from "@astryxdesign/core/Table";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { Download, ScrollText } from "lucide-react";
import { LoadFailed } from "../../ui/LoadFailed";
import { ActorName } from "../../ui/ActorName";
import { PageColumn } from "../../ui/PageColumn";
import { ACTION_LABEL, actionLabel, sourceLabel } from "./audit-labels";
import { AI_COAUTHOR_LABEL, fmtInt, relativeTime, absoluteTime, principalHuman } from "../../lib/format";
import { Audit, type AuditCursor, type AuditEvent, type AuditExportFilters, type AuditFacets } from "../../api";
import { actorHandle, actorName, resolveNames, useNamesVersion } from "../../state/identity";
import { errorMessage, type ApiError } from "../../lib/http/client";
import { saveBlob } from "../../lib/download";

/** "all" sends no bound; "custom" takes its bounds from the `from` and `to` days. */
const RANGES = [
  { value: "24h", label: "Last 24 hours", ms: 24 * 3600_000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 86_400_000 },
  { value: "30d", label: "Last 30 days", ms: 30 * 86_400_000 },
  { value: "90d", label: "Last 90 days", ms: 90 * 86_400_000 },
  { value: "all", label: "All time", ms: null as number | null },
  { value: "custom", label: "Custom range…", ms: null as number | null },
];

/** Never written to the URL: a link without a range means this default. */
const DEFAULT_RANGE = "7d";

interface Window {
  /** Inclusive lower bound, ISO. */
  since?: string;
  /** Exclusive upper bound, ISO. */
  until?: string;
}

/** A `YYYY-MM-DD` day as the instant of its local midnight, `plusDays` on: the reader means their own days. */
function localDay(day: string, plusDays = 0): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plusDays);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** A custom range includes its `to` day, so its bound is the midnight after it. */
function windowFor(range: string, from: string, to: string): Window {
  if (range === "custom") return { since: localDay(from), until: localDay(to, 1) };
  const ms = RANGES.find((r) => r.value === range)?.ms;
  return { since: ms ? new Date(Date.now() - ms).toISOString() : undefined };
}

/** Below the server's cap of 500: most readers want the top of the list. */
const PAGE_SIZE = 200;

/** The expression the server groups the `principals` facet by and matches `principal` against. */
function accountable(e: AuditEvent): string {
  return e.on_behalf_of ?? e.actor;
}

/** What a row was made with when someone else answers for it; null for an agent acting on its own authority. */
function instrumentOf(e: AuditEvent): string | null {
  return e.on_behalf_of && e.on_behalf_of !== e.actor ? e.actor : null;
}

const RESULTS = [
  { value: "", label: "All results" },
  { value: "denied", label: "Refused only" },
  { value: "ok", label: "Allowed only" },
];

/** A flex item shrinks below its content only with min-width 0. */
const CLAMP = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

const KEEP = { flex: "0 0 auto" } as const;

export function AuditLog() {
  const nav = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const read = (key: string): string => params.get(key) ?? "";
  /** The person answerable for a row, matched against actor OR on_behalf_of. */
  const principal = read("principal");
  /** The instrument, matched against the actor exactly. */
  const actor = read("actor");
  const action = read("action");
  const status = read("status");
  const targetKind = read("target_kind");
  const targetId = read("target_id");
  const rangeRaw = read("range");
  const range = RANGES.some((r) => r.value === rangeRaw) ? rangeRaw : DEFAULT_RANGE;
  const from = read("from");
  const to = read("to");

  /** Empty values and the default range drop their keys, so a link carries only what was narrowed. */
  const setFilters = (patch: Record<string, string>): void => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value && !(key === "range" && value === DEFAULT_RANGE)) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  };

  const filtersNow = (): AuditExportFilters => ({
    principal: principal || undefined,
    actor: actor || undefined,
    action: action || undefined,
    status: status || undefined,
    targetKind: targetKind || undefined,
    targetId: targetId || undefined,
    ...windowFor(range, from, to),
  });

  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  /** The cursor for the page after the loaded ones; null means none is left. */
  const [cursor, setCursor] = useState<AuditCursor | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** A first page is in flight; rows from the previous filters stay on screen meanwhile. */
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** "failed" is for the first page only; a later failure is a toast over rows that are still true. */
  const [error, setError] = useState<null | "forbidden" | "failed">(null);
  const [attempt, setAttempt] = useState(0);
  const namesVersion = useNamesVersion();
  const [facets, setFacets] = useState<AuditFacets | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  /** The menus' fallback when facets fail, each axis collected the way the server groups it. */
  const [seenPrincipals, setSeenPrincipals] = useState<string[]>([]);
  const [seenAgents, setSeenAgents] = useState<string[]>([]);
  const [seenActions, setSeenActions] = useState<string[]>([]);
  /** Bumped per query; a page answering an older query is dropped, cursor and all. */
  const query = useRef(0);
  const loaded = useRef(false);

  function absorb(rows: AuditEvent[]): void {
    setSeenPrincipals((prev) => [...new Set([...prev, ...rows.map(accountable)])].sort());
    setSeenAgents((prev) =>
      [...new Set([...prev, ...rows.filter((e) => e.actor_kind === "agent").map((e) => e.actor)])].sort(),
    );
    setSeenActions((prev) => [...new Set([...prev, ...rows.map((e) => e.action)])].sort());
    resolveNames(rows.flatMap((e) => [e.actor_kind === "human" ? e.actor : null, e.on_behalf_of]));
  }

  useEffect(() => {
    // A cursor belongs to its query, so a filter change restarts paging.
    const gen = ++query.current;
    setCursor(null);
    setExpandedKeys(new Set());
    setRefreshing(true);
    Audit.list({ ...filtersNow(), limit: PAGE_SIZE })
      .then(({ events: page, next_before }) => {
        if (query.current !== gen) return;
        setRefreshing(false);
        setError(null);
        setEvents(page);
        setCursor(next_before);
        loaded.current = true;
        absorb(page);
      })
      .catch((e: ApiError) => {
        if (query.current !== gen) return;
        setRefreshing(false);
        // A refusal closes the page even over loaded rows: the role that loaded them is gone.
        if (e?.status === 403) setError("forbidden");
        else if (!loaded.current) setError("failed");
        else toast({ body: "Couldn’t load events for these filters. The table still shows the previous ones.", type: "error" });
      });
    return () => {
      query.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [principal, actor, action, status, targetKind, targetId, range, from, to, attempt]);

  // Facets describe the window, so they reload with the range only. A failure leaves the fallback menus.
  useEffect(() => {
    let alive = true;
    setFacets(null);
    Audit.facets(windowFor(range, from, to))
      .then((f) => {
        if (!alive) return;
        setFacets(f);
        // Facets name people no loaded row carries.
        resolveNames([...f.principals.map((a) => a.value), ...f.agents.map((a) => a.value)]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, from, to, attempt]);

  async function loadOlder(): Promise<void> {
    if (!cursor || loadingOlder) return;
    const gen = query.current;
    setLoadingOlder(true);
    try {
      const { events: page, next_before } = await Audit.list({
        ...filtersNow(),
        limit: PAGE_SIZE,
        before_at: cursor.at,
        before_id: cursor.id,
      });
      if (query.current !== gen) return;
      setEvents((prev) => [...(prev ?? []), ...page]);
      setCursor(next_before);
      absorb(page);
    } catch {
      if (query.current === gen) toast({ body: "Couldn’t load older events.", type: "error" });
    } finally {
      setLoadingOlder(false);
    }
  }

  const displayName = actorName;

  /** Two people can share a name, so a plain-text label carries the handle after it. */
  const nameAndHandle = (alias: string): string => {
    const handle = actorHandle(alias);
    return handle ? `${displayName(alias)} ${handle}` : displayName(alias);
  };

  /** Keep a selected value in its menu, or a deep-linked filter could not be undone from its control. */
  const withSelected = (
    options: { value: string; label: string }[],
    value: string,
    label: (v: string) => string,
  ) => (value && !options.some((o) => o.value === value) ? [...options, { value, label: label(value) }] : options);

  /** Co-authors are minted per person, so the Agent menu names each by its person. */
  const instrumentName = (alias: string): string => {
    const human = principalHuman(alias);
    return human ? `${AI_COAUTHOR_LABEL} · ${nameAndHandle(human)}` : displayName(alias);
  };

  const principalOptions = useMemo(() => {
    const from = facets?.principals.map((f) => ({
      value: f.value,
      label: `${nameAndHandle(f.value)} (${fmtInt(f.count)})`,
    }));
    const fallback = seenPrincipals.map((a) => ({ value: a, label: nameAndHandle(a) }));
    return withSelected([{ value: "", label: "Everyone" }, ...(from ?? fallback)], principal, nameAndHandle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facets, seenPrincipals, namesVersion, principal]);

  const agentOptions = useMemo(() => {
    const from = facets?.agents.map((f) => ({
      value: f.value,
      label: `${instrumentName(f.value)} (${fmtInt(f.count)})`,
    }));
    const fallback = seenAgents.map((a) => ({ value: a, label: instrumentName(a) }));
    // Not "All agents": most rows involve no agent at all.
    return withSelected([{ value: "", label: "Any or none" }, ...(from ?? fallback)], actor, instrumentName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facets, seenAgents, namesVersion, actor]);

  const actionOptions = useMemo(() => {
    const named = (a: string) => ACTION_LABEL[a] ?? a;
    const from = facets?.actions.map((f) => ({ value: f.value, label: `${named(f.value)} (${fmtInt(f.count)})` }));
    const fallback = seenActions.map((a) => ({ value: a, label: named(a) }));
    return withSelected([{ value: "", label: "All actions" }, ...(from ?? fallback)], action, named);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facets, seenActions, action]);

  const resultOptions = useMemo(() => {
    const count = (value: string) => facets?.statuses.find((f) => f.value === value)?.count;
    return RESULTS.map((r) => {
      const n = r.value ? count(r.value) : undefined;
      return { value: r.value, label: n === undefined ? r.label : `${r.label} (${fmtInt(n)})` };
    });
  }, [facets]);

  const narrowToTarget = (kind: string, id: string): void => setFilters({ target_kind: kind, target_id: id });

  /** A deep link carries only the id; a loaded row supplies the recorded name. */
  const targetName = targetId ? (events?.find((e) => e.target_id === targetId)?.target_label ?? targetId) : "";

  const expansion = useTableRowExpansion<AuditEvent>({
    expandedKeys,
    onToggle: (key) =>
      setExpandedKeys((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    getRowKey: (e) => String(e.id),
    renderExpanded: (e) => <EventDetail event={e} name={nameAndHandle} onNarrow={narrowToTarget} />,
  });

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
      renderCell: (e: AuditEvent) => {
        const person = accountable(e);
        const instrument = instrumentOf(e);
        return (
          <VStack gap={0} style={{ minWidth: 0 }}>
            <HStack gap={2} vAlign="center" style={{ minWidth: 0 }}>
              {/* Only an agent nobody answers for gets the chip; beside a person's name it would call them an agent. */}
              {e.actor_kind === "agent" && !instrument && (
                <HStack style={KEEP}>
                  <Badge variant="purple" label="agent" />
                </HStack>
              )}
              {e.actor_kind === "internal" && (
                <HStack style={KEEP}>
                  <Badge variant="neutral" label="system" />
                </HStack>
              )}
              <ActorName alias={person} />
            </HStack>
            {/* On its own line, which a narrow column does not clip. */}
            {instrument && (
              <span title={instrument} style={CLAMP}>
                <Text type="supporting" color="secondary" as="span">
                  via {displayName(instrument)}
                </Text>
              </span>
            )}
          </VStack>
        );
      },
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
        <TargetCell event={e} onOpenItem={(id) => nav(`/doc/${id}`)} onNarrow={narrowToTarget} />
      ),
    },
    { key: "source", header: "Via", width: pixel(120), renderCell: (e: AuditEvent) => sourceLabel(e.source) },
  ];

  const window = windowFor(range, from, to);

  async function exportAll(): Promise<void> {
    setExporting(true);
    try {
      const { blob, filename } = await Audit.export(filtersNow(), "csv");
      saveBlob(blob, filename);
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn’t export the audit log."), type: "error" });
    } finally {
      setExporting(false);
    }
  }

  if (error === "forbidden") {
    return (
      <PageColumn width={920}>
        <EmptyState
          icon={<ScrollText size={28} />}
          title="You can't see this workspace's audit log"
          description="Ask an owner or admin of this workspace if you need it."
        />
      </PageColumn>
    );
  }
  if (error) {
    return (
      <PageColumn width={920}>
        <LoadFailed
          icon={<ScrollText size={28} />}
          title="Couldn’t load the audit log"
          onRetry={() => {
            setError(null);
            setEvents(null);
            loaded.current = false;
            setAttempt((n) => n + 1);
          }}
        />
      </PageColumn>
    );
  }
  if (!events) {
    return (
      <PageColumn width={920}>
        <VStack gap={2} hAlign="center" style={{ paddingTop: "20vh" }}>
          <Spinner label="Loading the audit log…" />
        </VStack>
      </PageColumn>
    );
  }

  const updating = refreshing;
  const customRange: DateRange | null =
    range === "custom" && from && to ? { start: from as ISODateString, end: to as ISODateString } : null;

  return (
    <PageColumn width={920}>
      <VStack gap={3}>
        <Heading level={2}>Audit log</Heading>
        <HStack gap={2} vAlign="end" justify="between" wrap="wrap">
          {/* The five widths plus gaps fit the 920px column; wider and the row breaks 4 + 1. */}
          <HStack gap={2} vAlign="end" wrap="wrap">
            <Selector
              label="Who"
              size="sm"
              width={170}
              value={principal}
              onChange={(v: string) => setFilters({ principal: v })}
              options={principalOptions}
            />
            <Selector
              label="Agent"
              size="sm"
              width={170}
              value={actor}
              onChange={(v: string) => setFilters({ actor: v })}
              options={agentOptions}
            />
            <Selector
              label="Action"
              size="sm"
              width={180}
              value={action}
              onChange={(v: string) => setFilters({ action: v })}
              options={actionOptions}
            />
            <Selector
              label="Result"
              size="sm"
              width={150}
              value={status}
              onChange={(v: string) => setFilters({ status: v })}
              options={resultOptions}
            />
            <Selector
              label="When"
              size="sm"
              width={150}
              value={range}
              onChange={(v: string) => setFilters(v === "custom" ? { range: v } : { range: v, from: "", to: "" })}
              options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
            />
            {range === "custom" && (
              <DateRangeInput
                label="Between"
                size="sm"
                width={260}
                value={customRange}
                onChange={(v: DateRange | null) => setFilters({ from: v?.start ?? "", to: v?.end ?? "" })}
              />
            )}
          </HStack>
          {/* Streams every matching row; with no filters set, that's everything. */}
          <Button
            label="Export matches (CSV)"
            variant="secondary"
            size="sm"
            icon={<Download size={15} />}
            isDisabled={events.length === 0}
            isLoading={exporting}
            onClick={() => void exportAll()}
          />
        </HStack>
        {/* The one filter with no menu: set from a row or a link, undone here. */}
        {targetId && (
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text type="supporting" color="secondary">
              Only this target:
            </Text>
            <Token
              label={targetName}
              size="sm"
              description={`${targetKind || "target"} ${targetId}`}
              onRemove={() => setFilters({ target_kind: "", target_id: "" })}
            />
          </HStack>
        )}
        {facets?.truncated && (
          <Text type="supporting" color="secondary">
            Menus show only the most frequent values in this range.
          </Text>
        )}
        {events.length === 0 ? (
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text type="supporting" color="secondary">
              Nothing recorded {window.since || window.until ? "in this window" : "yet"} that matches the filters.
            </Text>
            {updating && <Spinner size="sm" label="Updating…" />}
          </HStack>
        ) : (
          <>
            <Table
              data={events}
              columns={columns}
              idKey="id"
              plugins={{ expansion }}
              dividers="rows"
              density="compact"
            />
            {/* "May": a cursor only means this page came back full. */}
            <HStack gap={2} vAlign="center" wrap="wrap">
              {updating ? (
                <Spinner size="sm" label="Updating…" />
              ) : (
                <Text type="supporting" color="secondary">
                  {cursor
                    ? `${fmtInt(events.length)} events loaded. There may be older ones.`
                    : `${fmtInt(events.length)} events loaded. Nothing older in this window matches.`}
                </Text>
              )}
              {cursor && !updating && (
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
        <Text type="supporting" color="secondary">
          Retention is set in Node settings → Storage.
        </Text>
      </VStack>
    </PageColumn>
  );
}

/** The recorded name, opening documents and databases, with the id under it narrowing the table to that target. */
function TargetCell({
  event,
  onOpenItem,
  onNarrow,
}: {
  event: AuditEvent;
  onOpenItem: (docId: string) => void;
  onNarrow: (kind: string, id: string) => void;
}) {
  const { target_kind, target_id, target_label } = event;
  if (!target_kind && !target_id) return <>—</>;
  const id = target_id ?? "";
  const opensAsItem = (target_kind === "doc" || target_kind === "database") && !!id;
  const head = target_label ?? (id || target_kind || "—");
  return (
    <VStack gap={0} style={{ minWidth: 0 }}>
      <span title={`${target_kind ?? "?"} · ${id}`} style={CLAMP}>
        {opensAsItem ? <Link onClick={() => onOpenItem(id)}>{head}</Link> : head}
      </span>
      {target_label && id && (
        <span title="Only this target" style={CLAMP}>
          <Link onClick={() => onNarrow(target_kind ?? "", id)}>
            <Text type="supporting" color="secondary" as="span">
              {id}
            </Text>
          </Link>
        </span>
      )}
    </VStack>
  );
}

/** One row expanded: every stored field, with the UTC time the export carries. */
function EventDetail({
  event,
  name,
  onNarrow,
}: {
  event: AuditEvent;
  name: (alias: string) => string;
  onNarrow: (kind: string, id: string) => void;
}) {
  const at = new Date(event.at);
  const utc = Number.isFinite(at.getTime()) ? at.toISOString() : event.at;
  return (
    <VStack gap={3}>
      <MetadataList columns="multi">
        <MetadataListItem label="When (this computer)">{absoluteTime(event.at)}</MetadataListItem>
        <MetadataListItem label="When (UTC, as exported)">{utc}</MetadataListItem>
        <MetadataListItem label="Result">{event.status === "ok" ? "Allowed" : "Refused"}</MetadataListItem>
        <MetadataListItem label="Accountable">{name(accountable(event))}</MetadataListItem>
        <MetadataListItem label="Actor">{name(event.actor)}</MetadataListItem>
        <MetadataListItem label="Actor alias">{event.actor}</MetadataListItem>
        <MetadataListItem label="On behalf of">
          {event.on_behalf_of ? `${name(event.on_behalf_of)} (${event.on_behalf_of})` : "—"}
        </MetadataListItem>
        <MetadataListItem label="Action">{event.action}</MetadataListItem>
        <MetadataListItem label="Via">{sourceLabel(event.source)}</MetadataListItem>
        <MetadataListItem label="Target kind">{event.target_kind ?? "—"}</MetadataListItem>
        <MetadataListItem label="Target id">{event.target_id ?? "—"}</MetadataListItem>
        <MetadataListItem label="Target name when recorded">{event.target_label ?? "—"}</MetadataListItem>
        <MetadataListItem label="Request id">{event.request_id ?? "—"}</MetadataListItem>
        <MetadataListItem label="Row id">{String(event.id)}</MetadataListItem>
      </MetadataList>
      {event.target_id && (
        <HStack>
          <Button
            label="Show only this target"
            variant="secondary"
            size="sm"
            onClick={() => onNarrow(event.target_kind ?? "", event.target_id!)}
          />
        </HStack>
      )}
      <CodeBlock
        code={JSON.stringify(event.detail ?? {}, null, 2)}
        language="json"
        title="Detail"
        width="100%"
        isWrapped
      />
    </VStack>
  );
}
