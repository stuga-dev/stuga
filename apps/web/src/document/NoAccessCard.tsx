/**
 * The refusal for an item route. A 403 and a 404 get the same card, so an
 * item's existence is never revealed; the access request answers the same way.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Docs } from "../api";

export function NoAccessCard({ docId }: { docId: string }) {
  const nav = useNavigate();
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  async function requestAccess() {
    setState("sending");
    try {
      await Docs.requestAccess(docId);
      setState("sent");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="doc-noaccess">
      <div className="doc-noaccess__card">
        <h1>You don’t have access</h1>
        <p>Ask the document’s owner to share it with you.</p>
        {state === "failed" && <p>Your request didn’t get through. Check your connection and try again.</p>}
        <HStack gap={2} justify="center">
          <Button label="All documents" variant="secondary" onClick={() => nav("/")} />
          <Button
            label={state === "sent" ? "Request sent" : state === "failed" ? "Try again" : "Request access"}
            variant="primary"
            isDisabled={state === "sent"}
            isLoading={state === "sending"}
            onClick={() => void requestAccess()}
          />
        </HStack>
      </div>
    </div>
  );
}
