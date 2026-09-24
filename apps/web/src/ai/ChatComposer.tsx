import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Square } from "lucide-react";
import { imageFilesFrom } from "../editor/use-image-upload";
import { useAiChat } from "../state/model-options";
import { AiSetupNotice } from "./AiSetupNotice";

/**
 * The prompt box under a chat transcript: Enter sends, and Stop takes Send's
 * place while a turn runs. While the node's AI chat is off it is the notice
 * that says how to turn it on, since every turn would be refused.
 */
export function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  placeholder,
  sendLabel = "Send",
  canSend,
  header,
  tools,
  onImages,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  placeholder: string;
  sendLabel?: string;
  canSend: boolean;
  /** Rendered above the prompt (selection quote, pickers, attachments). */
  header?: ReactNode;
  /** Rendered at the start of the button row. */
  tools?: ReactNode;
  /** Receives images pasted or dropped onto the prompt; omit to ignore them. */
  onImages?: (files: File[]) => void;
}) {
  const chat = useAiChat();
  // Nothing until the node answers: a prompt box that turns into a notice is worse than one that appears.
  if (chat === "loading") return null;
  if (chat === "off") {
    return (
      <div className="ai-input">
        <AiSetupNotice />
      </div>
    );
  }
  const takeImages = (dt: DataTransfer | null, e: { preventDefault: () => void }) => {
    if (!onImages) return;
    const files = imageFilesFrom(dt);
    if (files.length === 0) return;
    e.preventDefault();
    onImages(files);
  };
  return (
    <div className="ai-input">
      {header}
      <div
        className="ai-composer"
        onPaste={(e) => takeImages(e.clipboardData, e)}
        onDragOver={onImages ? (e) => e.preventDefault() : undefined}
        onDrop={(e) => takeImages(e.dataTransfer, e)}
      >
        <TextArea
          label="Message"
          isLabelHidden
          value={value}
          onChange={onChange}
          rows={2}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend && !streaming) onSend();
            }
          }}
        />
      </div>
      <HStack gap={2} align="center">
        {tools}
        <div style={{ flex: 1 }} />
        {streaming ? (
          <Button label="Stop" variant="secondary" icon={<Square size={14} />} onClick={onStop} />
        ) : (
          <Button label={sendLabel} variant="primary" onClick={onSend} isDisabled={!canSend} />
        )}
      </HStack>
    </div>
  );
}
