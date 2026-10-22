/** Index and Log, the wiki's two generated pages, one tab each. */
import { useNavigate } from "react-router-dom";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { t } from "../i18n/i18n";

export type WikiTab = "index" | "log";

const PATHS: Record<WikiTab, string> = { index: "/wiki", log: "/wiki/log" };

export function WikiTabs({ current }: { current: WikiTab }) {
  const nav = useNavigate();
  return (
    <nav aria-label={t("pages.wiki.nav")}>
      <TabList value={current} onChange={(next) => nav(PATHS[next as WikiTab])} hasDivider>
        <Tab value="index" label={t("library.nav.index")} />
        <Tab value="log" label={t("library.nav.log")} />
      </TabList>
    </nav>
  );
}
