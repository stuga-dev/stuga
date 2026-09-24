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
  const title = doc.title || "Untitled";
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
              {isDatabase ? "Database" : "Document"}
            </Text>
            {DOC_STATE_FLAGS.filter((f) => f.isOn(docStateOf(doc))).map(({ label, icon: Icon, badge }) => (
              <Badge key={label} variant={badge} label={label} icon={<Icon size={12} />} />
            ))}
            <span className="doc-detail__close">
              <IconButton label="Close details" variant="ghost" size="sm" icon={<X size={16} />} onClick={onClose} />
            </span>
          </HStack>
          <Heading level={2} maxLines={2}>
            {title}
          </Heading>
          <Text type="supporting" color="secondary">
            Edited <span title={absoluteTime(doc.updated_at)}>{relativeTime(doc.updated_at)}</span>
          </Text>
        </VStack>

        <HStack gap={2} vAlign="center" wrap="wrap">
          <Button label="Open" variant="primary" icon={<ExternalLink size={16} />} onClick={onOpen} />
          <Button label="Share" variant="secondary" icon={<Share2 size={16} />} onClick={onShare} />
          <IconButton
            label={isFavorite ? "Remove from favorites" : "Add to favorites"}
            variant="ghost"
            onClick={onToggleFavorite}
            icon={
              <Star
                size={17}
                fill={isFavorite ? "currentColor" : "none"}
                className={isFavorite ? "doc-detail__star--on" : undefined}
              />
            }
          />
          <MoreMenu
            label={`Settings for ${title}`}
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
              <Text type="label">Tables</Text>
              <ul className="db-detail-tables">
                {dbSchema.tables
                  .slice()
                  .sort((a, b) => a.position - b.position)
                  .map((t) => (
                    <li key={t.table_id} className="db-detail-tables__row">
                      <span className="db-detail-tables__name">{t.display || "Untitled table"}</span>
                      <Text type="supporting" color="secondary">
                        {t.row_count} row{t.row_count === 1 ? "" : "s"}
                      </Text>
                    </li>
                  ))}
              </ul>
            </VStack>
          </>
        )}

        <Divider />

        <MetadataList title="Details">
          <MetadataListItem label="Owner">
            <HStack gap={2} vAlign="center">
              <Avatar name={owner} size="xsm" />
              <span title={doc.owner}>{owner}</span>
            </HStack>
          </MetadataListItem>
          <MetadataListItem label="Created">
            <span title={absoluteTime(doc.created_at)}>{relativeTime(doc.created_at)}</span>
          </MetadataListItem>
          <MetadataListItem label="Location">
            {doc.parent_id ? (folderTitle ?? "In a folder") : "Top level"}
          </MetadataListItem>
        </MetadataList>
      </VStack>
      {instructions.dialog}
    </div>
  );
}
