import { useEffect, useState } from "react";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Banner } from "@astryxdesign/core/Banner";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Selector } from "@astryxdesign/core/Selector";
import { useToast } from "@astryxdesign/core/Toast";
import { KeyRound } from "lucide-react";
import { AgentKeys, Folders, type Folder, type KeyNarrowing } from "../api";
import { errorMessage } from "../lib/http/client";
import { t } from "../i18n/i18n";

function accessOptions() {
  return [
    { value: "propose", label: t("agents.key.accessPropose"), description: t("agents.key.accessProposeDescription") },
    { value: "read", label: t("agents.key.accessRead"), description: t("agents.key.accessReadDescription") },
  ];
}

function expiryOptions() {
  return [
    { value: "", label: t("agents.key.neverExpires") },
    { value: "7", label: t("agents.key.expiresInDays", { days: 7 }) },
    { value: "30", label: t("agents.key.expiresInDays", { days: 30 }) },
    { value: "90", label: t("agents.key.expiresInDays", { days: 90 }) },
    { value: "365", label: t("agents.key.expiresInYear") },
  ];
}

/**
 * Minting a key for a config. The token lives only in this state: the node
 * keeps a hash and never returns it again.
 */
export function useMintKey(onKeyCreated: () => void) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [narrowing, setNarrowing] = useState<KeyNarrowing>({});
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);

  useEffect(() => {
    // Without the folder list the key simply cannot be confined to folders.
    Folders.list()
      .then(({ folders }) => setFolders(folders))
      .catch(() => {});
  }, []);

  async function mint(fallback?: string) {
    const trimmed = name.trim() || (fallback ?? "").trim();
    if (!trimmed) return;
    setMinting(true);
    try {
      const key = await AgentKeys.create(trimmed, narrowing);
      setMinted({ name: key.name, token: key.token });
      // The next key is another agent with its own reach.
      setName("");
      setNarrowing({});
      toast({ body: t("agents.key.created", { name: key.name }), type: "info" });
      onKeyCreated();
    } catch (e) {
      toast({ body: errorMessage(e, t("agents.key.createFailed")), type: "error" });
    } finally {
      setMinting(false);
    }
  }

  return { name, setName, narrowing, setNarrowing, minting, minted, folders, mint };
}

export type MintKeyState = ReturnType<typeof useMintKey>;

/**
 * The key form beside a config that needs a token. Every choice only narrows the
 * owner's own reach. A tab that knows its client passes `defaultName` and asks
 * for no name at all: the key is that client, and Connected agents renames it
 * for the rare person who connects the same client twice.
 */
export function MintKey({ mint, defaultName }: { mint: MintKeyState; defaultName?: string }) {
  const { name, setName, narrowing, setNarrowing, minting, minted, folders } = mint;
  const willName = name.trim() || (defaultName ?? "").trim();
  return (
    <>
      {defaultName === undefined && (
        <TextInput
          label={t("agents.key.agentName")}
          description={t("agents.key.agentNameDescription")}
          placeholder="my-agent"
          value={name}
          onChange={setName}
          onEnter={() => void mint.mint(defaultName)}
        />
      )}
      <HStack gap={2} vAlign="end" style={{ flexWrap: "wrap", rowGap: 8 }}>
        <Selector
          label={t("common.access")}
          size="sm"
          width={210}
          value={narrowing.access ?? "propose"}
          onChange={(v) => setNarrowing({ ...narrowing, access: v as "read" | "propose" })}
          options={accessOptions()}
        />
        <Selector
          label={t("agents.key.lifetime")}
          size="sm"
          width={190}
          value={narrowing.expires_in_days ? String(narrowing.expires_in_days) : ""}
          onChange={(v) => setNarrowing({ ...narrowing, expires_in_days: v ? Number(v) : null })}
          options={expiryOptions()}
        />
        {folders.length > 0 && (
          <MultiSelector
            label={t("agents.key.folders")}
            options={folders.map((f) => ({ value: f.folder_id, label: f.title || t("common.untitledFolder") }))}
            value={narrowing.scope_folders ?? []}
            hasSearch
            onChange={(ids: string[]) => setNarrowing({ ...narrowing, scope_folders: ids.length ? ids : null })}
          />
        )}
        {/* In the same row as what it acts on, and last: the choices are made before the key exists. */}
        <Button
          label={t("agents.key.create")}
          variant="secondary"
          size="sm"
          icon={<KeyRound size={15} />}
          onClick={() => void mint.mint(defaultName)}
          isDisabled={!willName}
          isLoading={minting}
        />
      </HStack>
      {minted && (
        <Banner
          status="warning"
          title={t("agents.key.copyTitle", { name: minted.name })}
          description={t("agents.key.copyDescription")}
        />
      )}
    </>
  );
}
