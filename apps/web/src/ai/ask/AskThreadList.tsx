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
import { t } from "../../i18n/i18n";

/** An unnamed thread shows its most recent question. */
const title = (thread: { title: string; last_question?: string | null }) =>
  thread.title || thread.last_question || t("common.untitled");

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
          label={t("ai.threads.newQuestion")}
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
            {t("ai.threads.empty")}
          </Text>
        </div>
      ) : (
        threads.map((thread) => (
          /* The hover fade hangs off this wrapper (SideNavItem exposes no class hook),
             and its title shows the full question the rail truncates. */
          <div key={thread.thread_id} className="ask-rail__row" title={title(thread)}>
            <SideNavItem
              label={title(thread)}
              isSelected={thread.thread_id === threadId}
              onClick={() => openThread(thread.thread_id)}
              actions={
                /* Empty title suppresses the row's inherited tooltip. */
                <span className="ask-rail__actions" title="">
                  <IconButton
                    label={t("common.rename")}
                    tooltip={t("common.rename")}
                    variant="ghost"
                    size="sm"
                    icon={<Pencil size={14} />}
                    onClick={() => setRenaming({ id: thread.thread_id, title: thread.title })}
                  />
                  <IconButton
                    label={t("common.delete")}
                    tooltip={t("common.delete")}
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={14} />}
                    onClick={() => setDeleting({ id: thread.thread_id, title: title(thread) })}
                  />
                </span>
              }
            />
          </div>
        ))
      )}
      <PromptDialog
        isOpen={renaming !== null}
        title={t("ai.threads.renameTitle")}
        label={t("common.name")}
        initialValue={renaming?.title ?? ""}
        submitLabel={t("common.rename")}
        onClose={() => setRenaming(null)}
        onSubmit={(v) => renaming && void renameThread(renaming.id, v)}
      />
      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? t("common.deleteNamed", { name: deleting.title }) : t("ai.threads.deleteConversation")}
        description={t("ai.threads.deleteDescription")}
        actionLabel={t("common.delete")}
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
