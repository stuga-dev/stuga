/**
 * How a workspace import ended: what came in, the files it left out and why, and what the
 * conversion of a Notion export or folder of Markdown spelled differently, each with the documents
 * or columns it happened in.
 */
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { CreatedWorkspace, ImportChange, ImportChangeKind } from "../api";
import { t, type MessageKey } from "../i18n/i18n";
import { listOf } from "../lib/format";
import { LeftOutList } from "./StartWith";

const CHANGE_LABEL: Record<ImportChangeKind, MessageKey> = {
  front_matter: "shell.importSummary.change.frontMatter",
  title_differs: "shell.importSummary.change.titleDiffers",
  unresolved_link: "shell.importSummary.change.unresolvedLink",
  missing_image: "shell.importSummary.change.missingImage",
  embedded_note: "shell.importSummary.change.embeddedNote",
  heading_link: "shell.importSummary.change.headingLink",
  highlight: "shell.importSummary.change.highlight",
  math: "shell.importSummary.change.math",
  text_column: "shell.importSummary.change.textColumn",
};

/** How many names a change lists before it counts the rest. */
const NAMES_SHOWN = 5;

/** Where a change happened: its first few documents or columns, then how many more. */
function whereOf({ where, count }: ImportChange): string {
  const names = listOf(where.slice(0, NAMES_SHOWN));
  const more = count - Math.min(where.length, NAMES_SHOWN);
  return more > 0 ? t("shell.importSummary.whereMore", { names, count: more }) : names;
}

export function ImportSummary({ workspace }: { workspace: CreatedWorkspace }) {
  const counts = workspace.imported;
  return (
    <VStack gap={4}>
      {counts && (
        <Text>
          {t("shell.importSummary.counts", { docs: counts.docs, databases: counts.databases, files: counts.images + counts.files })}
        </Text>
      )}
      {workspace.left_out && <LeftOutList leftOut={workspace.left_out} title={t("shell.importSummary.leftOutTitle", { count: workspace.left_out.count })} />}
      {workspace.changed && workspace.changed.length > 0 && (
        <VStack gap={2}>
          <Text weight="semibold">{t("shell.importSummary.changedTitle")}</Text>
          <List density="compact">
            {workspace.changed.map((change) => (
              <ListItem key={change.kind} label={t(CHANGE_LABEL[change.kind])} description={whereOf(change)} />
            ))}
          </List>
        </VStack>
      )}
    </VStack>
  );
}
