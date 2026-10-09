/** The detail rail for the selected document: title and dates, the main actions, and a database's tables. */
import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Text, Heading } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Badge } from "@astryxdesign/core/Badge";
import { Divider } from "@astryxdesign/core/Divider";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Avatar } from "@astryxdesign/core/Avatar";
import { ExternalLink, Star, Share2, FileText, Database, X } from "lucide-react";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { DOC_STATE_FLAGS, docStateOf, useDocStateMenu } from "./doc-state";
import { useInstructionsDialog } from "./use-instructions-dialog";
import { Databases, type DocSummary } from "../api";
import type { DatabaseSchema } from "@stuga/protocol/databases/types";
import { relativeTime, absoluteTime } from "../lib/format";
import { principalName, useUserNames } from "../state/identity";
import { t } from "../i18n/i18n";
import { tRich } from "../i18n/rich";

interface DocDetailProps {
  doc: DocSummary;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onOpen: () => void;
  onShare: () => void;
  onClose: () => void;
  /** The containing folder's name, when the caller knows it. */
  folderTitle: string | null;
  /** A state change from the rail's menu, so the list behind it updates too. */
  onStateChange: (next: DocSummary) => void;
}

export function DocDetail({ doc, isFavorite, onToggleFavorite, onOpen, onShare, onClose, folderTitle, onStateChange }: DocDetailProps) {
  const title = doc.title || t("common.untitled");
  const isDatabase = doc.doc_type === "database";
  const stateMenu = useDocStateMenu();
  const instructions = useInstructionsDialog();

  // A database previews as its tables and row counts; without the schema the rail still works.
  const [dbSchema, setDbSchema] = useState<DatabaseSchema | null>(null);
  useEffect(() => {
    if (!isDatabase) {
      setDbSchema(null);
      return;
    }
    let live = true;
    setDbSchema(null);
    Databases.schema(doc.doc_id)
      .then((s) => live && setDbSchema(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [doc.doc_id, isDatabase]);
  useUserNames([doc.owner]);
  const owner = principalName(doc.owner);

  return (
    <div className="doc-detail">
      <VStack gap={5}>
        <VStack gap={2}>
          <HStack gap={2} vAlign="center">
            <span className="doc-detail__type">
              {isDatabase ? <Database size={14} /> : <FileText size={14} />}
            </span>
            <Text type="supporting" color="secondary">
              {isDatabase ? t("common.database") : t("common.document")}
            </Text>
            {DOC_STATE_FLAGS.filter((f) => f.isOn(docStateOf(doc))).map(({ label, icon: Icon, badge }) => (
              <Badge key={label} variant={badge} label={label} icon={<Icon size={12} />} />
            ))}
            <span className="doc-detail__close">
              <IconButton label={t("library.detail.close")} variant="ghost" size="sm" icon={<X size={16} />} onClick={onClose} />
            </span>
          </HStack>
          <Heading level={2} maxLines={2}>
            {title}
          </Heading>
          <Text type="supporting" color="secondary">
            {tRich("library.detail.edited", {
              when: relativeTime(doc.updated_at),
              time: (chunks) => <span title={absoluteTime(doc.updated_at)}>{chunks}</span>,
            })}
          </Text>
        </VStack>

        <HStack gap={2} vAlign="center" wrap="wrap">
          <Button label={t("common.open")} variant="primary" icon={<ExternalLink size={16} />} onClick={onOpen} />
          <Button label={t("common.share")} variant="secondary" icon={<Share2 size={16} />} onClick={onShare} />
          <IconButton
            label={isFavorite ? t("library.favorites.remove") : t("library.favorites.add")}
            variant="ghost"
            onClick={onToggleFavorite}
            icon={
              <Star
                size={17}
                fill={isFavorite ? "currentColor" : "none"} // i18n-exempt: an SVG paint value
                className={isFavorite ? "doc-detail__star--on" : undefined}
              />
            }
          />
          <MoreMenu
            label={t("library.detail.settingsFor", { title })}
            variant="ghost"
            size="sm"
            alignment="end"
            items={[
              ...stateMenu(doc, onStateChange),
              instructions.item({ kind: isDatabase ? "database" : "document", id: doc.doc_id, title: doc.title }),
            ]}
          />
        </HStack>

        {isDatabase && dbSchema && dbSchema.tables.length > 0 && (
          <>
            <Divider />
            <VStack gap={2}>
              <Text type="label">{t("library.detail.tables")}</Text>
              <ul className="db-detail-tables">
                {dbSchema.tables
                  .slice()
                  .sort((a, b) => a.position - b.position)
                  .map((table) => (
                    <li key={table.table_id} className="db-detail-tables__row">
                      <span className="db-detail-tables__name">{table.display || t("library.detail.untitledTable")}</span>
                      <Text type="supporting" color="secondary">
                        {t("library.detail.rows", { count: table.row_count })}
                      </Text>
                    </li>
                  ))}
              </ul>
            </VStack>
          </>
        )}

        <Divider />

        <MetadataList title={t("library.detail.details")}>
          <MetadataListItem label={t("library.table.owner")}>
            <HStack gap={2} vAlign="center">
              <Avatar name={owner} size="xsm" />
              <span title={doc.owner}>{owner}</span>
            </HStack>
          </MetadataListItem>
          <MetadataListItem label={t("library.detail.created")}>
            <span title={absoluteTime(doc.created_at)}>{relativeTime(doc.created_at)}</span>
          </MetadataListItem>
          <MetadataListItem label={t("library.table.location")}>
            {doc.parent_id ? (folderTitle ?? t("library.detail.inFolder")) : t("library.table.topLevel")}
          </MetadataListItem>
        </MetadataList>
      </VStack>
      {instructions.dialog}
    </div>
  );
}
