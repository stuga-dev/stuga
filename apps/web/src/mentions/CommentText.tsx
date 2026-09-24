/** A comment body with the @usernames it resolved to shown as mentions. */
import { commentSegments, type CommentMention } from "@stuga/protocol/domain/mentions";
import { principalName, useUserNames } from "../state/identity";

export function CommentText({ body, mentions }: { body: string; mentions: readonly CommentMention[] | undefined }) {
  useUserNames((mentions ?? []).map((m) => `user:${m.alias}`));
  return (
    <p className="comment-text">
      {commentSegments(body, mentions ?? []).map((seg, i) =>
        "mention" in seg ? (
          <span key={i} className="mention" title={principalName(`user:${seg.mention.alias}`)}>
            {seg.text}
          </span>
        ) : (
          seg.text
        ),
      )}
    </p>
  );
}
