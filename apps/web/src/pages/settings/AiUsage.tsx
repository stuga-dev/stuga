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
import { fmtInt, monthYear } from "../../lib/format";
import { Usage, type UsageByModel, type UsageByPrincipal, type UsageReport } from "../../api";
import { resolveNames, useNamesVersion } from "../../state/identity";
import { ActorName } from "../../ui/ActorName";
import type { ApiError } from "../../lib/http/client";
import { t, type MessageKey } from "../../i18n/i18n";

/** Keyed by ai_usage.kind. */
const PURPOSE_LABEL: Record<string, MessageKey> = {
  coauthor: "settings.usage.purpose.coauthor",
  table_coauthor: "settings.usage.purpose.tableCoauthor",
  ask: "settings.usage.purpose.ask",
  embedding: "settings.usage.purpose.embedding",
};

function purposeLabel(kind: string): string {
  const key = PURPOSE_LABEL[kind];
  return key ? t(key) : kind;
}

/** The three count columns both tables share. */
function countColumns() {
  return {
    calls: { key: "calls", header: t("settings.usage.calls"), align: "end" as const, width: pixel(90) },
    read: { key: "input_tokens", header: t("settings.usage.tokensRead"), align: "end" as const, width: pixel(120) },
    written: { key: "output_tokens", header: t("settings.usage.tokensWritten"), align: "end" as const, width: pixel(130) },
  };
}

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
          title={t("settings.usage.forbidden")}
          description={t("settings.workspace.askAdmin")}
        />
      </PageColumn>
    );
  }
  if (error) {
    return (
      <PageColumn>
        <LoadFailed
          icon={<Gauge size={28} />}
          title={t("settings.usage.loadFailed")}
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
          <Spinner label={t("settings.usage.loading")} />
        </VStack>
      </PageColumn>
    );
  }

  const { calls: CALLS, read: READ, written: WRITTEN } = countColumns();
  const byModel = [
    {
      key: "kind",
      header: t("settings.usage.whatItWentOn"),
      width: proportional(1),
      renderCell: (r: UsageByModel) => purposeLabel(r.kind),
    },
    { key: "model", header: t("settings.usage.model"), width: proportional(1), renderCell: (r: UsageByModel) => r.model },
    { ...CALLS, renderCell: (r: UsageByModel) => fmtInt(r.calls) },
    { ...READ, renderCell: (r: UsageByModel) => fmtInt(r.input_tokens) },
    { ...WRITTEN, renderCell: (r: UsageByModel) => fmtInt(r.output_tokens) },
  ];
  const byPerson = [
    {
      key: "alias",
      header: t("settings.usage.who"),
      width: proportional(1),
      renderCell: (r: UsageByPrincipal) => <ActorName alias={r.alias} />,
    },
    { key: "model", header: t("settings.usage.model"), width: proportional(1), renderCell: (r: UsageByPrincipal) => r.model },
    { ...CALLS, renderCell: (r: UsageByPrincipal) => fmtInt(r.calls) },
    { ...READ, renderCell: (r: UsageByPrincipal) => fmtInt(r.input_tokens) },
    { ...WRITTEN, renderCell: (r: UsageByPrincipal) => fmtInt(r.output_tokens) },
  ];

  return (
    <PageColumn width={920}>
      <VStack gap={6}>
        <VStack gap={3}>
          <HStack justify="between" vAlign="center">
            <Heading level={2}>{t("settings.usage.heading")}</Heading>
            {/* A calendar month, not a rolling window. */}
            <Text type="supporting">{monthYear(usage.period.since)}</Text>
          </HStack>
          {usage.by_model.length === 0 ? (
            <Text type="supporting" color="secondary">
              {t("settings.usage.none", { month: monthYear(usage.period.since) })}
            </Text>
          ) : (
            <Table data={usage.by_model} columns={byModel} dividers="rows" density="compact" />
          )}
        </VStack>

        {usage.by_principal.length > 0 && (
          <VStack gap={3}>
            <Heading level={2}>{t("settings.usage.byPerson")}</Heading>
            <Table data={usage.by_principal} columns={byPerson} dividers="rows" density="compact" />
          </VStack>
        )}
      </VStack>
    </PageColumn>
  );
}
