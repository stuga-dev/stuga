/** This month's AI use in the workspace: raw token counts, no cost, since the node spends its operator's own key. */
import { useEffect, useState } from "react";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Table, proportional, pixel } from "@astryxdesign/core/Table";
import { VStack } from "@astryxdesign/core/VStack";
import { Gauge } from "lucide-react";
import { LoadFailed } from "../../ui/LoadFailed";
import { PageColumn } from "../../ui/PageColumn";
import { fmtInt } from "../../lib/format";
import { Usage, type UsageByModel, type UsageByPrincipal, type UsageReport } from "../../api";
import { resolveNames, useNamesVersion } from "../../state/identity";
import { ActorName } from "../../ui/ActorName";
import type { ApiError } from "../../lib/http/client";

/** Keyed by ai_usage.kind. */
const purposeLabel: Record<string, string> = {
  coauthor: "Writing with AI",
  table_coauthor: "Working in databases",
  ask: "Answering questions",
  embedding: "Keeping search up to date",
};

const CALLS = { key: "calls", header: "Calls", align: "end" as const, width: pixel(90) };
const READ = { key: "input_tokens", header: "Tokens read", align: "end" as const, width: pixel(120) };
const WRITTEN = { key: "output_tokens", header: "Tokens written", align: "end" as const, width: pixel(130) };

export function AiUsage() {
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [error, setError] = useState<null | "forbidden" | "failed">(null);
  const [attempt, setAttempt] = useState(0);
  useNamesVersion();

  useEffect(() => {
    let alive = true;
    Usage.get()
      .then((r) => {
        if (!alive) return;
        setError(null);
        setUsage(r);
        resolveNames(r.by_principal.map((p) => p.alias));
      })
      .catch((e: ApiError) => {
        if (alive) setError(e?.status === 403 ? "forbidden" : "failed");
      });
    return () => {
      alive = false;
    };
  }, [attempt]);


  if (error === "forbidden") {
    return (
      <PageColumn>
        <EmptyState
          icon={<Gauge size={28} />}
          title="You can't see this workspace's AI usage"
          description="Ask an owner or admin of this workspace if you need it."
        />
      </PageColumn>
    );
  }
  if (error) {
    return (
      <PageColumn>
        <LoadFailed
          icon={<Gauge size={28} />}
          title="Couldn’t load AI usage"
          onRetry={() => {
            setError(null);
            setUsage(null);
            setAttempt((n) => n + 1);
          }}
        />
      </PageColumn>
    );
  }
  if (!usage) {
    return (
      <PageColumn>
        <VStack gap={2} hAlign="center" style={{ paddingTop: "20vh" }}>
          <Spinner label="Loading AI usage…" />
        </VStack>
      </PageColumn>
    );
  }

  const byModel = [
    {
      key: "kind",
      header: "What it went on",
      width: proportional(1),
      renderCell: (r: UsageByModel) => purposeLabel[r.kind] ?? r.kind,
    },
    { key: "model", header: "Model", width: proportional(1), renderCell: (r: UsageByModel) => r.model },
    { ...CALLS, renderCell: (r: UsageByModel) => fmtInt(r.calls) },
    { ...READ, renderCell: (r: UsageByModel) => fmtInt(r.input_tokens) },
    { ...WRITTEN, renderCell: (r: UsageByModel) => fmtInt(r.output_tokens) },
  ];
  const byPerson = [
    {
      key: "alias",
      header: "Who",
      width: proportional(1),
      renderCell: (r: UsageByPrincipal) => <ActorName alias={r.alias} />,
    },
    { key: "model", header: "Model", width: proportional(1), renderCell: (r: UsageByPrincipal) => r.model },
    { ...CALLS, renderCell: (r: UsageByPrincipal) => fmtInt(r.calls) },
    { ...READ, renderCell: (r: UsageByPrincipal) => fmtInt(r.input_tokens) },
    { ...WRITTEN, renderCell: (r: UsageByPrincipal) => fmtInt(r.output_tokens) },
  ];

  return (
    <PageColumn width={920}>
      <VStack gap={6}>
        <VStack gap={3}>
          <HStack justify="between" vAlign="center">
            <Heading level={2}>AI usage</Heading>
            {/* A calendar month, not a rolling window. */}
            <Text type="supporting">{usage.period.label}</Text>
          </HStack>
          {usage.by_model.length === 0 ? (
            <Text type="supporting" color="secondary">
              No AI has run in this workspace {usage.period.label.toLowerCase()}.
            </Text>
          ) : (
            <Table data={usage.by_model} columns={byModel} dividers="rows" density="compact" />
          )}
        </VStack>

        {usage.by_principal.length > 0 && (
          <VStack gap={3}>
            <Heading level={2}>By person</Heading>
            <Table data={usage.by_principal} columns={byPerson} dividers="rows" density="compact" />
          </VStack>
        )}
      </VStack>
    </PageColumn>
  );
}
