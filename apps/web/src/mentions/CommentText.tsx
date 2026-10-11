/** A comment body with the @usernames it resolved to shown as mentions, by each person's name as it is now. */
import { commentSegments, type CommentMention } from "@stuga/protocol/domain/mentions";
import { personName, principalName, useUserNames } from "../state/identity";

export function CommentText({ body, mentions }: { body: string; mentions: readonly CommentMention[] | undefined }) {
  useUserNames((mentions ?? []).map((m) => `user:${m.alias}`));
  return (
    <p className="comment-text">
      {commentSegments(body, mentions ?? []).map((seg, i) => {
        if (!("mention" in seg)) return seg.text;
        // The @username as written until the name arrives, and for someone the directory no longer knows.
        const name = personName(seg.mention.alias);
        return (
          <span key={i} className="mention" title={name ? seg.text : principalName(`user:${seg.mention.alias}`)}>
            {name ? `@${name}` : seg.text}
          </span>
        );
      })}
    </p>
  );
}
