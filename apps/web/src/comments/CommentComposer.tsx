/**
 * The little popup that appears under a text selection after the user clicks
 * "Comment" in the selection bubble. Type the comment, press Enter (or click
 * Comment) to save it against the anchored range; Escape cancels.
 *
 * The draft is only cleared once the save actually succeeds, so a failed POST
 * (offline, auth expiry, server error) leaves the typed text in place to retry.
 */
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { MentionTextArea } from "../mentions/MentionTextArea";
import { useComments } from "./comments-context";

export function CommentComposer() {
  const { pending, submit, cancel } = useComments();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  if (!pending) return null;

  const onSubmit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    const ok = await submit(body);
    setBusy(false);
    if (ok) setBody(""); // only clear on success — preserve the draft on failure
  };

  // Clamp so the composer stays on screen even when the anchor is near an edge.
  const top = Math.min(pending.rect.top + 6, window.innerHeight - 150);
  const left = Math.min(pending.rect.left, window.innerWidth - 290);

  return (
    <div
      className="comment-composer"
      style={{ top, left }}
      role="dialog"
      aria-label="Add a comment"
      onKeyDown={(e) => {
        // Container-level Escape so it works from the buttons too, not just the textarea.
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
    >
      <div className="comment-composer__quote" dir="auto" title={pending.anchor.quote}>
        “{pending.anchor.quote}”
      </div>
      <MentionTextArea
        label="Comment text"
        isLabelHidden
        hasAutoFocus
        value={body}
        placeholder="Add a comment… Type @ to mention someone"
        rows={2}
        onChange={setBody}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void onSubmit();
          }
        }}
      />
      <HStack gap={2} justify="end">
        <Button label="Cancel" variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={cancel} />
        <Button label="Comment" variant="primary" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={() => void onSubmit()} isDisabled={!body.trim() || busy} />
      </HStack>
    </div>
  );
}
