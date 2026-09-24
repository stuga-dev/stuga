import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { errorMessage } from "../../../lib/http/client";

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
      {status.error && <Banner status="error" title="That didn’t work" description={status.error} />}
      {status.notice && <Banner status={status.notice.status} title={status.notice.message} />}
    </>
  );
}
