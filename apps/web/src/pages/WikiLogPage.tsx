/**
 * The wiki's Log: the AI changes people approved and declined, newest first, by day. Each is one
 * change across pages, or one page's run in none: which pages it touched, who asked and through which
 * AI, who decided, and when. Generated from the run records of pages the reader can open; a change's
 * title shows to whoever asked for it or decided it, as its card gives it.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { History } from "lucide-react";
import { changeCardPath } from "@stuga/protocol/domain/changes";
import { reviewCardPath } from "@stuga/protocol/domain/runs";
import { Wiki, type LogOutcome, type WikiLogEntry } from "../api";
import { AppTopNav } from "../shell/AppTopNav";
import { LoadFailed } from "../ui/LoadFailed";
import { PageColumn } from "../ui/PageColumn";
import { absoluteTime, dayLabel, relativeTime } from "../lib/format";
import { errorMessage } from "../lib/http/client";
import { useToast } from "../ui/use-toast";
import { runAgentLabel } from "../state/identity";
import { t, type MessageKey } from "../i18n/i18n";
import { authorRefLabel, authorRefList } from "../wiki/names";
import { WikiTabs } from "../wiki/WikiTabs";

const OUTCOME: Record<LogOutcome, MessageKey> = {
  approved: "pages.wiki.log.outcome.approved",
  declined: "pages.wiki.log.outcome.declined",
  partly: "pages.wiki.log.outcome.partly",
  applied: "pages.wiki.log.outcome.applied",
  reverted: "pages.wiki.log.outcome.reverted",
};

/** The same outcome with the people who decided it; applied and reverted have no decider to name. */
const OUTCOME_BY: Partial<Record<LogOutcome, MessageKey>> = {
  approved: "pages.wiki.log.by.approved",
  declined: "pages.wiki.log.by.declined",
  partly: "pages.wiki.log.by.partly",
};

const TOKEN_COLOR: Record<LogOutcome, "green" | "red" | "yellow" | "blue" | "gray"> = {
  approved: "green",
  declined: "red",
  partly: "yellow",
  applied: "blue",
  reverted: "gray",
};

/** "Approved by Sam", or the outcome alone when nobody decided it. */
export function outcomeLine(e: Pick<WikiLogEntry, "outcome" | "decided_by">): string {
  const by = OUTCOME_BY[e.outcome];
  return by && e.decided_by.length > 0 ? t(by, { names: authorRefList(e.decided_by) }) : t(OUTCOME[e.outcome]);
}

/** "Asked by Liv through Claude". */
export function askedLine(e: Pick<WikiLogEntry, "asked_by" | "agent">): string {
  const agent = runAgentLabel({ source: e.agent.source, agent: e.agent.name, agent_alias: e.agent.alias });
  return e.asked_by ? t("pages.wiki.log.askedBy", { name: authorRefLabel(e.asked_by), agent }) : t("pages.wiki.log.through", { agent });
}

/** How many changes it decided, landed or not, over the pages the reader opens. */
function changeCount(e: WikiLogEntry): number {
  return e.pages.reduce((n, p) => n + p.approved + p.declined + p.applied, 0);
}

/** Entries grouped by the day they were decided, in order. */
function byDay(entries: readonly WikiLogEntry[]): Array<{ day: string; entries: WikiLogEntry[] }> {
  const out: Array<{ day: string; entries: WikiLogEntry[] }> = [];
  for (const e of entries) {
    const day = dayLabel(e.at);
    const last = out[out.length - 1];
    if (last && last.day === day) last.entries.push(e);
    else out.push({ day, entries: [e] });
  }
  return out;
}

export default function WikiLogPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [entries, setEntries] = useState<WikiLogEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    setEntries(null);
    Wiki.log().then(
      (log) => {
        setEntries(log.entries);
        setNext(log.next);
      },
      () => setFailed(true),
    );
  }, []);
  useEffect(load, [load]);

  async function older() {
    if (!next) return;
    setMore(true);
    try {
      const log = await Wiki.log(next);
      setEntries((prev) => [...(prev ?? []), ...log.entries]);
      setNext(log.next);
    } catch (e) {
      toast({ body: errorMessage(e, t("pages.wiki.log.loadFailed")), type: "error" });
    } finally {
      setMore(false);
    }
  }

  function open(e: WikiLogEntry) {
    const page = e.pages[0];
    if (e.kind === "change") nav(changeCardPath(e.id));
    else if (page) nav(reviewCardPath(page.doc_id, page.run_id));
  }

  return (
    <AppShell topNav={<AppTopNav title={t("pages.wiki.log.title")} hasWorkspaceSwitcher />} contentPadding={0}>
      <PageColumn width={760}>
        <VStack gap={5}>
          <WikiTabs current="log" />
          <Text color="secondary">{t("pages.wiki.log.intro")}</Text>
          {failed ? (
            <LoadFailed icon={<History size={24} />} title={t("pages.wiki.log.loadFailed")} onRetry={load} />
          ) : entries === null ? (
            <VStack gap={2} hAlign="center" padding={6}>
              <Spinner label={t("pages.wiki.log.loading")} />
            </VStack>
          ) : entries.length === 0 ? (
            <EmptyState icon={<History size={28} />} title={t("pages.wiki.log.emptyTitle")} description={t("pages.wiki.log.emptyNote")} />
          ) : (
            <VStack gap={6}>
              {byDay(entries).map((group) => (
                <List key={group.day} hasDividers density="balanced" header={<Heading level={2}>{group.day}</Heading>}>
                  {group.entries.map((e) => {
                    const titles = e.pages.map((p) => p.title || t("common.untitled"));
                    return (
                      <ListItem
                        key={e.id}
                        label={e.title || titles.join(" · ")}
                        onClick={() => open(e)}
                        description={
                          <VStack gap={1}>
                            <HStack>
                              <Token size="sm" color={TOKEN_COLOR[e.outcome]} label={outcomeLine(e)} />
                            </HStack>
                            {e.title && (
                              <Text color="secondary" maxLines={1}>
                                {titles.join(" · ")}
                              </Text>
                            )}
                            <Text type="supporting" color="secondary">
                              {askedLine(e)} · {t("pages.wiki.log.changes", { count: changeCount(e) })} ·{" "}
                              <time dateTime={e.at} title={absoluteTime(e.at)}>
                                {relativeTime(e.at)}
                              </time>
                            </Text>
                          </VStack>
                        }
                      />
                    );
                  })}
                </List>
              ))}
              {next && <Button label={t("pages.wiki.log.older")} variant="secondary" isDisabled={more} onClick={() => void older()} />}
            </VStack>
          )}
        </VStack>
      </PageColumn>
    </AppShell>
  );
}
