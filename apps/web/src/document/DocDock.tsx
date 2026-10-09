/** The document page's dock: the AI co-author, Comments, Versions and Sources. */
import type * as Y from "yjs";
import type { StugaProvider } from "../sync/stuga-provider";
import { Dock, useDockState, type DockController } from "../ui/Dock";
import { CommentsPanel } from "./CommentsPanel";
import { VersionsPanel } from "./versions/VersionsPanel";
import { SourcesPanel, useSourceCount } from "./SourcesPanel";
import { AiNewChatButton, AiPanel } from "../ai/AiPanel";
import { t } from "../i18n/i18n";
import { aiCoauthorLabel } from "../lib/format";
import { VStack } from "@astryxdesign/core/VStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { History, MessageSquare, Quote, Sparkles } from "lucide-react";

type DocDockTab = "ai" | "comments" | "versions" | "sources";

/** A reader gets no AI tab: the actor refuses AI requests on a view-only or locked document. */
export function useDocDock(readOnly: boolean): DockController<DocDockTab> {
  return useDockState<DocDockTab>(
    "stuga_dock",
    [{ id: "ai", when: !readOnly }, { id: "comments" }, { id: "versions" }, { id: "sources" }],
    "ai",
  );
}

/** Rendered below the page's editor provider, which the Sources count reads. */
export function DocDock({
  dock,
  docId,
  ydoc,
  provider,
  agentAuto,
  width,
  onResize,
}: {
  dock: DockController<DocDockTab>;
  docId: string;
  ydoc: Y.Doc | null;
  provider: StugaProvider | null;
  /** The document applies agent changes at once, the co-author's included. */
  agentAuto: boolean;
  width: number;
  onResize: (next: number) => void;
}) {
  const sourceCount = useSourceCount();
  return (
    <Dock
      dock={dock}
      width={width}
      onResize={onResize}
      tabs={[
        {
          id: "ai",
          label: aiCoauthorLabel(),
          icon: <Sparkles size={15} />,
          actions: <AiNewChatButton />,
          render: () =>
            provider ? (
              <AiPanel agentAuto={agentAuto} />
            ) : (
              <VStack gap={2} hAlign="center" paddingBlock={8}>
                <Spinner label={t("document.dock.connecting")} />
              </VStack>
            ),
        },
        { id: "comments", label: t("document.dock.comments"), icon: <MessageSquare size={15} />, render: () => <CommentsPanel docId={docId} /> },
        { id: "versions", label: t("document.dock.versions"), icon: <History size={15} />, render: () => <VersionsPanel docId={docId} ydoc={ydoc} /> },
        { id: "sources", label: t("document.dock.sources"), icon: <Quote size={15} />, badge: sourceCount, render: () => <SourcesPanel /> },
      ]}
    />
  );
}
