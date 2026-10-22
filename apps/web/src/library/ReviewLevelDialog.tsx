/**
 * How AI edits to a document, database or folder are reviewed: three levels, and for a folder the
 * group whose members approve at `colleague`. A folder gives its level to what is in it; an item's
 * owner (or an admin) may choose a stricter one, and only the folder's owner or an admin a looser
 * one, which the server decides. A row page never goes below its database, nor a page shared out of
 * My notes below `review`, so the dialog offers nothing looser there. Agents never change it.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { REVIEW_MODES, looserReviewMode, stricterReviewMode, type ReviewMode } from "@stuga/protocol/domain/events";
import { Docs, Folders, Groups, groupName, type DocSummary, type Folder, type ReviewFloors } from "../api";
import { errorMessage } from "../lib/http/client";
import { useToast } from "../ui/use-toast";
import { t, type MessageKey } from "../i18n/i18n";

export type ReviewLevelTarget =
  | { kind: "document" | "database"; doc: DocSummary; onChanged: (next: DocSummary) => void }
  | { kind: "folder"; folder: Folder; onChanged: (next: Folder) => void };

/** A level as the interface names it. */
export const LEVEL_LABEL: Record<ReviewMode, MessageKey> = {
  auto: "library.review.auto",
  review: "library.review.review",
  colleague: "library.review.colleague",
};

const LEVEL_DESCRIPTION: Record<ReviewMode, MessageKey> = {
  auto: "library.review.autoDescription",
  review: "library.review.reviewDescription",
  colleague: "library.review.colleagueDescription",
};

/** The approver group selector's value for "anyone who can edit". */
const ANYONE = "";

/**
 * What the dialog says of an item's floors, and the level nobody sets it below: a row page's
 * database's, and `review` for an item shared out of My notes. Its folder's level is said too, and
 * only warned about, since the folder's owner or an admin may go below it.
 */
export function floorsOf(floors: ReviewFloors | null | undefined): { lines: string[]; hard: ReviewMode | null } {
  const lines: string[] = [];
  if (floors?.folder) lines.push(t("library.review.floor", { level: floors.folder }));
  if (floors?.database) lines.push(t("library.review.databaseFloor", { level: floors.database }));
  if (floors?.notes) lines.push(t("library.review.notesFloor"));
  const set = [floors?.database ?? null, floors?.notes ?? null].filter((f): f is ReviewMode => f !== null);
  return { lines, hard: set.length > 0 ? set.reduce(stricterReviewMode) : null };
}

export function ReviewLevelDialog({
  isOpen,
  target,
  canEdit,
  canEditGroup,
  onClose,
}: {
  isOpen: boolean;
  target: ReviewLevelTarget;
  /** The caller may choose a level: the item's owner or a workspace admin, or, in a folder, possibly that folder's owner (the server decides). */
  canEdit: boolean;
  /** A folder's approver group: its owner or a workspace admin. */
  canEditGroup: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const item = target.kind === "folder" ? target.folder : target.doc;
  const current = item.agent_mode;
  const floors = floorsOf(item.agent_mode_floors);
  const floor = item.agent_mode_floors?.folder ?? null;
  const currentGroup = target.kind === "folder" ? target.folder.approver_group : null;
  const [level, setLevel] = useState<ReviewMode>(current);
  const [group, setGroup] = useState<string>(currentGroup ?? ANYONE);
  const [groups, setGroups] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  // The dialog stays mounted between openings, so every opening starts from the item as it is.
  useEffect(() => {
    if (!isOpen) return;
    setLevel(current);
    setGroup(currentGroup ?? ANYONE);
    setSaving(false);
    if (target.kind !== "folder") return;
    let live = true;
    Groups.list()
      .then((r) => live && setGroups(r.groups.map((g) => g.group_id)))
      .catch(() => live && setGroups([]));
    return () => {
      live = false;
    };
  }, [isOpen, current, currentGroup, target.kind]);

  const title = (target.kind === "folder" ? target.folder.title : target.doc.title).trim() || t("common.untitled");
  const changed = level !== current || (target.kind === "folder" && (group || null) !== currentGroup);
  const belowFloor = floor !== null && looserReviewMode(level, floor);

  async function save() {
    if (!changed || saving) return;
    setSaving(true);
    try {
      if (target.kind === "folder") {
        const patch = {
          ...(level !== current ? { agent_mode: level } : {}),
          ...((group || null) !== currentGroup ? { approver_group: group || null } : {}),
        };
        target.onChanged(await Folders.setReview(target.folder.folder_id, patch));
      } else {
        target.onChanged(await Docs.setState(target.doc.doc_id, { agent_mode: level }));
      }
      toast({ body: level === "auto" && current !== "auto" ? t("library.state.agentAutoDone") : t("library.review.saved"), type: "info" });
      onClose();
    } catch (e) {
      toast({ body: errorMessage(e, t("library.review.saveFailed")), type: "error" });
    } finally {
      setSaving(false);
    }
  }

  const close = () => !saving && onClose();

  return (
    <Dialog isOpen={isOpen} onOpenChange={(o) => !o && close()} purpose="form" width={520}>
      <Layout
        header={<DialogHeader title={t("library.review.title")} subtitle={title} onOpenChange={(o) => !o && close()} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              <RadioList
                label={t("library.review.levelLabel", { kind: target.kind })}
                description={floors.lines.length > 0 ? floors.lines.join(" ") : undefined}
                value={level}
                onChange={(v) => setLevel(v as ReviewMode)}
                isDisabled={!canEdit || saving}
                disabledMessage={canEdit ? undefined : t("library.review.managersOnly")}
                status={belowFloor && level !== current ? { type: "warning", message: t("library.review.belowFloor") } : undefined}
              >
                {[...REVIEW_MODES].reverse().map((mode) => (
                  <RadioListItem
                    key={mode}
                    value={mode}
                    label={t(LEVEL_LABEL[mode])}
                    description={t(LEVEL_DESCRIPTION[mode], { kind: target.kind })}
                    isDisabled={floors.hard !== null && looserReviewMode(mode, floors.hard)}
                  />
                ))}
              </RadioList>
              {target.kind === "folder" && (
                <Selector
                  label={t("library.review.approvers")}
                  description={t("library.review.approversDescription")}
                  value={group}
                  onChange={setGroup}
                  isDisabled={!canEditGroup || saving || groups === null}
                  options={[
                    { value: ANYONE, label: t("library.review.anyone") },
                    ...(groups ?? (currentGroup ? [currentGroup] : [])).map((g) => ({ value: g, label: groupName(g) })),
                  ]}
                />
              )}
              {!canEdit && (
                <Text type="supporting" color="secondary">
                  {t("library.review.managersOnly")}
                </Text>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              {canEdit ? (
                <>
                  <Button label={t("common.cancel")} variant="ghost" onClick={close} isDisabled={saving} />
                  <Button label={t("common.save")} variant="primary" onClick={() => void save()} isDisabled={!changed} isLoading={saving} />
                </>
              ) : (
                <Button label={t("common.close")} variant="ghost" onClick={onClose} />
              )}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
