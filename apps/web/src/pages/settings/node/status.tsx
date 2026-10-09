import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { t } from "../../../i18n/i18n";
import { errorMessage } from "../../../lib/http/client";
import { presentServerMessage } from "../../../lib/http/server-messages";

type SectionNotice = { status: "success" | "warning"; message: string };

/** The outcome line a section shows above its fields after an action. */
export function useSectionStatus() {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<SectionNotice | null>(null);
  return {
    error,
    notice,
    setNotice,
    fail: (e: unknown) => setError(errorMessage(e, String(e))),
    setError,
    clear: () => {
      setError(null);
      setNotice(null);
    },
  };
}

type SectionStatus = ReturnType<typeof useSectionStatus>;

export function SectionStatusBanners({ status }: { status: SectionStatus }) {
  return (
    <>
      {status.error && <Banner status="error" title={t("node.status.failed")} description={status.error} />}
      {status.notice && <Banner status={status.notice.status} title={presentServerMessage(status.notice.message)} />}
    </>
  );
}
