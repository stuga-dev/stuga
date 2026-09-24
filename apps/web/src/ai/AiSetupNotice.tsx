/**
 * Stands where an AI prompt box would while the node's AI chat is off. A node
 * administrator is offered the settings; anyone else learns who can turn it on,
 * and that their own AI subscription works without it.
 */
import { useNavigate } from "react-router-dom";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { useIsNodeAdmin } from "../state/node-admin";

/** Where chat is set up and switched on. */
const AI_SETTINGS_PATH = "/settings/node/ai";
/** Where anyone connects an agent on their own subscription. */
const YOUR_OWN_AI_PATH = "/settings/agents";

export function AiSetupNotice() {
  const nav = useNavigate();
  const isAdmin = useIsNodeAdmin();
  // Waits for the answer, so a button does not appear under the reader's eyes.
  if (isAdmin === null) return null;
  return (
    <Banner
      status="info"
      // Workspace UI: "node" belongs to Settings and the switcher, and AI is set per node, so no noun at all.
      title="AI chat is off"
      description={isAdmin ? undefined : "Ask your administrator to turn it on, or use your own AI."}
      endContent={
        isAdmin ? (
          <Button label="AI settings" variant="primary" size="sm" onClick={() => nav(AI_SETTINGS_PATH)} />
        ) : (
          <Button label="Connect your own AI" variant="primary" size="sm" onClick={() => nav(YOUR_OWN_AI_PATH)} />
        )
      }
    />
  );
}
