/** The saved-conversation rail on the Ask page, one row per thread. */
import { useState } from "react";
import { useAsk } from "../ask-context";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { SideNav, SideNavItem } from "@astryxdesign/core/SideNav";
import { Text } from "@astryxdesign/core/Text";
import { PromptDialog } from "../../ui/PromptDialog";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Pencil, Plus, Trash2 } from "lucide-react";

/** An unnamed thread shows its most recent question. */
const title = (t: { title: string; last_question?: string | null }) =>
  t.title || t.last_question || "Untitled";

export function AskThreadList() {
  const { threads, threadId, openThread, renameThread, deleteThread } = useAsk();
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  // Confirmed: threads have no trash, and Delete sits one gap from Rename.
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);

  return (
    <SideNav
      // Not collapsible: a collapsed rail shows icons, and every thread's would be the same.
      resizable={{ defaultWidth: 248, minWidth: 200, maxWidth: 380, autoSaveId: "stuga-ask-rail" }}
      topContent={
        <Button
          label="New question"
          variant="primary"
          size="sm"
          icon={<Plus size={15} />}
          width="100%"
          onClick={() => openThread(null)}
        />
      }
    >
      {threads.length === 0 ? (
        <div className="ask-rail__empty">
          <Text type="supporting" color="secondary">
            Your questions will be saved here.
          </Text>
        </div>
      ) : (
        threads.map((t) => (
          /* The hover fade hangs off this wrapper (SideNavItem exposes no class hook),
             and its title shows the full question the rail truncates. */
          <div key={t.thread_id} className="ask-rail__row" title={title(t)}>
            <SideNavItem
              label={title(t)}
              isSelected={t.thread_id === threadId}
              onClick={() => openThread(t.thread_id)}
              actions={
                /* Empty title suppresses the row's inherited tooltip. */
                <span className="ask-rail__actions" title="">
                  <IconButton
                    label="Rename"
                    tooltip="Rename"
                    variant="ghost"
                    size="sm"
                    icon={<Pencil size={14} />}
                    onClick={() => setRenaming({ id: t.thread_id, title: t.title })}
                  />
                  <IconButton
                    label="Delete"
                    tooltip="Delete"
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={14} />}
                    onClick={() => setDeleting({ id: t.thread_id, title: title(t) })}
                  />
                </span>
              }
            />
          </div>
        ))
      )}
      <PromptDialog
        isOpen={renaming !== null}
        title="Rename conversation"
        label="Name"
        initialValue={renaming?.title ?? ""}
        submitLabel="Rename"
        onClose={() => setRenaming(null)}
        onSubmit={(v) => renaming && void renameThread(renaming.id, v)}
      />
      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.title ?? "conversation"}”?`}
        description="The answers and their sources are deleted with it. The documents themselves are not affected."
        actionLabel="Delete"
        actionVariant="destructive"
        onAction={() => {
          const id = deleting?.id;
          setDeleting(null);
          if (id) void deleteThread(id);
        }}
      />
    </SideNav>
  );
}
