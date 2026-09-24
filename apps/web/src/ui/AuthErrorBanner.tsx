/** A refused sign-in or sign-up step, with a one-click "Use <suggestion>" when the node offered a free username. */
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";

export function AuthErrorBanner({
  message,
  suggestion,
  onUseSuggestion,
}: {
  message: string;
  suggestion: string | null;
  onUseSuggestion: (username: string) => void;
}) {
  return (
    <Banner
      status="error"
      title={message}
      {...(suggestion
        ? {
            endContent: (
              <Button label={`Use ${suggestion}`} size="sm" variant="secondary" onClick={() => onUseSuggestion(suggestion)} />
            ),
          }
        : {})}
    />
  );
}
