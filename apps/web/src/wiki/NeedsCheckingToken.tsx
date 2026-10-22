/** The mark of a page that needs checking: a page it cites changed after it was approved. */
import { Token } from "@astryxdesign/core/Token";
import { RefreshCw } from "lucide-react";
import { t } from "../i18n/i18n";

export function NeedsCheckingToken() {
  return <Token size="sm" color="yellow" icon={<RefreshCw size={12} />} label={t("pages.wiki.needsChecking")} />;
}
