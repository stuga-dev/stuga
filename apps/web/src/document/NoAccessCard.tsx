/**
 * The refusal for an item route. A 403 and a 404 get the same card, so an
 * item's existence is never revealed; the access request answers the same way,
 * and for the same reason the card never names an owner. It checks again now
 * and then, and on returning to the tab, so access granted meanwhile opens the item.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Docs } from "../api";
import { t } from "../i18n/i18n";

/** How often the card asks whether access has been granted. */
const RECHECK_MS = 15_000;

export function NoAccessCard({ docId, onAccess }: { docId: string; /** Access arrived: load the item. */ onAccess: () => void }) {
  const nav = useNavigate();
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  useEffect(() => {
    let alive = true;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      Docs.get(docId)
        .then(() => alive && onAccess())
        .catch(() => {});
    };
    const timer = window.setInterval(check, RECHECK_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [docId, onAccess]);

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
        <h1>{t("document.noAccess.title")}</h1>
        <p>{t("document.noAccess.body")}</p>
        {state === "failed" && <p>{t("document.noAccess.failed")}</p>}
        <HStack gap={2} justify="center">
          <Button label={t("common.allDocuments")} variant="secondary" onClick={() => nav("/")} />
          <Button
            label={
              state === "sent"
                ? t("document.noAccess.sent")
                : state === "failed"
                  ? t("document.noAccess.tryAgain")
                  : t("document.noAccess.request")
            }
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
