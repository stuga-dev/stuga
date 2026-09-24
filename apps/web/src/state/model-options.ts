/**
 * The node's chat models: the model picker's options, with "Auto" (the node's
 * default model) always first, and whether the node offers AI chat at all.
 */
import { useEffect, useMemo, useState } from "react";
import type { SelectorOptionType } from "@astryxdesign/core/Selector";
import { Me, type AiModel } from "../api";
import { cachedResource } from "../lib/store";

type ModelOption = SelectorOptionType;

const AUTO: ModelOption = { value: "auto", label: "Auto" };

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI-compatible",
  ollama: "Ollama",
};

/** One vendor stays a flat list; several are grouped so an id says which vendor it belongs to. */
function groupByProvider(models: AiModel[]): ModelOption[] {
  const order: string[] = [];
  const byProvider = new Map<string, AiModel[]>();
  for (const m of models) {
    if (m.id === "auto") continue;
    if (!byProvider.has(m.provider)) {
      byProvider.set(m.provider, []);
      order.push(m.provider);
    }
    byProvider.get(m.provider)!.push(m);
  }
  if (order.length <= 1) {
    return (byProvider.get(order[0] ?? "") ?? []).map((m) => ({ value: m.id, label: m.name }));
  }
  return order.map((p) => ({
    type: "section" as const,
    title: PROVIDER_LABEL[p] ?? p,
    options: byProvider.get(p)!.map((m) => ({ value: m.id, label: m.name })),
  }));
}

/** Empty while the node's AI chat is off. */
const models = cachedResource(() => Me.models());

/** Drop the cached list after a node administrator changes the models. Other tabs keep theirs until reload. */
export function invalidateModelOptions(): void {
  models.invalidate();
}

/** The list, `undefined` until it arrives, `null` when it could not be read. */
function useModels(): AiModel[] | null | undefined {
  const [list, setList] = useState<AiModel[] | null | undefined>(() => models.peek());

  useEffect(() => {
    if (models.peek()) return;
    let alive = true;
    models.get().then(
      (m) => alive && setList(m),
      () => alive && setList(null),
    );
    return () => {
      alive = false;
    };
  }, []);

  return list;
}

export function useModelOptions(): ModelOption[] {
  const list = useModels();
  // Offline: "Auto" alone still lets a turn report its own failure.
  return useMemo(() => [AUTO, ...groupByProvider(list ?? [])], [list]);
}

/**
 * Whether the node offers AI chat. "off" only when the node says so with an
 * empty list; a list that could not be read counts as on, so a turn reports
 * its own failure.
 */
export function useAiChat(): "loading" | "on" | "off" {
  const list = useModels();
  if (list === undefined) return "loading";
  return list !== null && list.length === 0 ? "off" : "on";
}
