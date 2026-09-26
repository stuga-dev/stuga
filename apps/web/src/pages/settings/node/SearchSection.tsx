import { useEffect, useId, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { NodeSettings as NodeApi, type NodeOperationalSettings } from "../../../api";
import { SEARCH_LANGUAGES_NOTE, SearchLanguageList } from "../../../ui/SearchLanguageList";
import { SectionStatusBanners, useSectionStatus } from "./status";

/** How often the page asks whether the search index has been rebuilt. */
const POLL_MS = 2000;

/** The languages search gets a tokenizer for; a change rebuilds the index while search keeps answering. */
export function SearchSection({ ops, onSaved }: { ops: NodeOperationalSettings; onSaved: (s: NodeOperationalSettings) => void }) {
  const status = useSectionStatus();
  const [languages, setLanguages] = useState(ops.search.languages);
  const [busy, setBusy] = useState(false);
  const { rebuilding, error } = ops.search;
  const rebuildingId = useId();

  // Asks again until the rebuild is done; the settings it brings back end the wait.
  useEffect(() => {
    if (!rebuilding) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      timer = setTimeout(() => {
        NodeApi.settings()
          .then((next) => {
            if (!alive) return;
            if (next.search.rebuilding) poll();
            else onSaved(next);
          })
          .catch(() => alive && poll());
      }, POLL_MS);
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [rebuilding, onSaved]);

  async function save() {
    setBusy(true);
    status.clear();
    try {
      const res = await NodeApi.saveSettings({ search: { languages } });
      onSaved(res);
      setLanguages(res.search.languages);
      status.setNotice({ status: "success", message: "Saved." });
    } catch (e) {
      status.fail(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <VStack gap={5}>
      <SectionStatusBanners status={status} />
      {error && !rebuilding && !status.error && <Banner status="warning" title="The search index wasn’t rebuilt" description={error} />}
      <VStack gap={3}>
        <Heading level={2}>Search languages</Heading>
        <Text type="supporting" color="secondary">
          {SEARCH_LANGUAGES_NOTE}
        </Text>
        <SearchLanguageList choices={ops.search.choices} value={languages} onChange={setLanguages} isDisabled={busy} isLabelHidden />
        <HStack gap={3} vAlign="center" wrap="wrap">
          <Button label="Save" variant="primary" size="sm" isLoading={busy} onClick={() => void save()} />
          {/* Beside Save, on its line: a labelled Spinner would stack its label under the ring. */}
          {rebuilding && (
            <HStack gap={2} vAlign="center">
              <Spinner size="sm" shade="subtle" aria-labelledby={rebuildingId} />
              <Text id={rebuildingId} type="supporting" color="secondary">
                Rebuilding the search index…
              </Text>
            </HStack>
          )}
        </HStack>
      </VStack>
    </VStack>
  );
}
