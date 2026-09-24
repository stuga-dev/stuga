/**
 * A ledger alias as a table cell: the name, then the handle that tells two
 * people of one name apart. Both clip in a narrow column; `title` defaults to
 * the raw alias, so the exact principal stays one hover away.
 */
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { actorHandle, actorName } from "../state/identity";

/** A flex item shrinks below its content only with min-width 0. */
const CLAMP = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

export function ActorName({ alias, title }: { alias: string; title?: string }) {
  const handle = actorHandle(alias);
  return (
    <HStack gap={2} vAlign="center" style={{ minWidth: 0 }}>
      <span title={title ?? alias} style={CLAMP}>
        {actorName(alias)}
      </span>
      {handle && (
        <span title={handle} style={CLAMP}>
          <Text color="secondary">{handle}</Text>
        </span>
      )}
    </HStack>
  );
}
