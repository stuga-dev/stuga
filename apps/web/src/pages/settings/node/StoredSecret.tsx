import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";

/** The line under a write-only credential: what is on file, and a Remove that takes effect on save. */
export function StoredSecret({
  onFile,
  removed,
  onRemove,
  removeLabel,
  removedNote,
}: {
  /** The badge for a stored credential; null when none is on file. */
  onFile: string | null;
  removed: boolean;
  onRemove: () => void;
  removeLabel: string;
  removedNote: string;
}) {
  return (
    <HStack gap={2} vAlign="center">
      {removed ? (
        <Text type="supporting" color="secondary">
          {removedNote}
        </Text>
      ) : onFile !== null ? (
        <>
          <Badge label={onFile} />
          <Button label={removeLabel} variant="ghost" size="sm" onClick={onRemove} />
        </>
      ) : null}
    </HStack>
  );
}
