/** The document page's dock: the AI co-author, Comments, Versions and Sources. */
import type * as Y from "yjs";
import type { StugaProvider } from "../sync/stuga-provider";
import { Dock, useDockState, type DockController } from "../ui/Dock";
import { CommentsPanel } from "./CommentsPanel";
import { VersionsPanel } from "./versions/VersionsPanel";
import { SourcesPanel, useSourceCount } from "./SourcesPanel";
import { AiNewChatButton, AiPanel } from "../ai/AiPanel";
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
  width,
  onResize,
}: {
  dock: DockController<DocDockTab>;
  docId: string;
  ydoc: Y.Doc | null;
  provider: StugaProvider | null;
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
          label: "AI co-author",
          icon: <Sparkles size={15} />,
          actions: <AiNewChatButton />,
          render: () =>
            provider ? (
              <AiPanel />
            ) : (
              <VStack gap={2} hAlign="center" paddingBlock={8}>
                <Spinner label="Connecting…" />
              </VStack>
            ),
        },
        { id: "comments", label: "Comments", icon: <MessageSquare size={15} />, render: () => <CommentsPanel docId={docId} /> },
        { id: "versions", label: "Versions", icon: <History size={15} />, render: () => <VersionsPanel docId={docId} ydoc={ydoc} /> },
        { id: "sources", label: "Sources", icon: <Quote size={15} />, badge: sourceCount, render: () => <SourcesPanel /> },
      ]}
    />
  );
}
