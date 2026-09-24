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

const ACCESS_OPTIONS = [
  { value: "propose", label: "Read and propose edits", description: "Can read and search, and propose changes." },
  { value: "read", label: "Read only", description: "Can read and search, but not make changes." },
];

const EXPIRY_OPTIONS = [
  { value: "", label: "Never expires" },
  { value: "7", label: "Expires in 7 days" },
  { value: "30", label: "Expires in 30 days" },
  { value: "90", label: "Expires in 90 days" },
  { value: "365", label: "Expires in a year" },
];

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
      toast({ body: `${key.name} created. Copy the config below — it carries the key.`, type: "info" });
      onKeyCreated();
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't create that key."), type: "error" });
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
          label="Agent name"
          description="How this agent's edits are attributed in version history."
          placeholder="my-agent"
          value={name}
          onChange={setName}
          onEnter={() => void mint.mint(defaultName)}
        />
      )}
      <HStack gap={2} vAlign="end" style={{ flexWrap: "wrap", rowGap: 8 }}>
        <Selector
          label="Access"
          size="sm"
          width={210}
          value={narrowing.access ?? "propose"}
          onChange={(v) => setNarrowing({ ...narrowing, access: v as "read" | "propose" })}
          options={ACCESS_OPTIONS}
        />
        <Selector
          label="Lifetime"
          size="sm"
          width={190}
          value={narrowing.expires_in_days ? String(narrowing.expires_in_days) : ""}
          onChange={(v) => setNarrowing({ ...narrowing, expires_in_days: v ? Number(v) : null })}
          options={EXPIRY_OPTIONS}
        />
        {folders.length > 0 && (
          <MultiSelector
            label="Only these folders (empty = everything you can reach)"
            options={folders.map((f) => ({ value: f.folder_id, label: f.title || "Untitled folder" }))}
            value={narrowing.scope_folders ?? []}
            hasSearch
            onChange={(ids: string[]) => setNarrowing({ ...narrowing, scope_folders: ids.length ? ids : null })}
          />
        )}
        {/* In the same row as what it acts on, and last: the choices are made before the key exists. */}
        <Button
          label="Create key"
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
          title={`Copy this config now — it carries ${minted.name}’s key`}
          description="Shown once. Treat it like a password."
        />
      )}
    </>
  );
}
