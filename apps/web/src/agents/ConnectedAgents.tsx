/**
 * The keys the viewer minted, across all their workspaces, with Rename, Rotate
 * and Revoke. An OAuth connection is a key too, so disconnecting an app is
 * revoking it. Which way a key was granted is said in the row's own line
 * ("signed in" or "key created") rather than badged: every row here is a
 * connection, so that is not what a badge should distinguish, and badges are
 * left to what deviates — read-only, folder scope, expiry, another workspace,
 * revoked. Renaming lives here rather than at minting: a key is named after the
 * client it is for, and only someone who connected that client twice needs to
 * tell the two apart — by then both are in this list.
 */
import { useCallback, useEffect, useState } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Banner } from "@astryxdesign/core/Banner";
import { useToast } from "@astryxdesign/core/Toast";
import { Pencil, Plug, RefreshCw } from "lucide-react";
import { TextInput } from "@astryxdesign/core/TextInput";
import { AgentKeys, type AgentKeyInfo, type WorkspaceInfo } from "../api";
import { LoadFailed } from "../ui/LoadFailed";
import { relativeTime, absoluteTime } from "../lib/format";
import { errorMessage } from "../lib/http/client";

interface Props {
  /** Keys pinned to another workspace are badged with its name. */
  activeWorkspaceId: string | null;
  workspaces: WorkspaceInfo[];
  /** Bumped when a key is minted elsewhere on the page. */
  reloadSignal: number;
}

export function ConnectedAgents({ activeWorkspaceId, workspaces, reloadSignal }: Props) {
  const toast = useToast();
  const [keys, setKeys] = useState<AgentKeyInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Revoking cuts off a live integration, so it takes a second click on the same row.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // A rotated key's new token, shown once.
  const [rotated, setRotated] = useState<{ keyId: string; name: string; token: string } | null>(null);
  // The row being renamed, and the text typed into it.
  const [renaming, setRenaming] = useState<{ keyId: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const { keys } = await AgentKeys.mine();
      setKeys(keys);
    } catch {
      // Null, so a retry in flight never reads as "no agents".
      setFailed(true);
      setKeys(null);
    }
  }, []);

  useEffect(() => {
    setConfirming(null);
    void load();
  }, [load, reloadSignal]);

  async function revoke(k: AgentKeyInfo) {
    setBusy(k.key_id);
    try {
      await AgentKeys.revoke(k.key_id);
      toast({ body: `${k.name} can no longer reach your documents.`, type: "info" });
      await load();
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't revoke that key."), type: "error" });
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  async function rotate(k: AgentKeyInfo) {
    setBusy(k.key_id);
    try {
      const out = await AgentKeys.rotate(k.key_id);
      setRotated({ keyId: k.key_id, name: k.name || k.agent_id, token: out.token });
      toast({ body: `${k.name} has a new key. The old one stopped working just now.`, type: "info" });
      await load();
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't rotate that key."), type: "error" });
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  function workspaceLabel(id: string): string | null {
    if (id === activeWorkspaceId) return null;
    return workspaces.find((w) => w.workspace_id === id)?.name ?? "another workspace";
  }

  /** What the key may not do that its owner may. */
  function narrowingBadges(k: AgentKeyInfo) {
    const out: React.ReactNode[] = [];
    if (k.access === "read") out.push(<Badge key="ro" variant="neutral" label="Read-only" />);
    if (k.scope_folders && k.scope_folders.length > 0) {
      out.push(<Badge key="scope" variant="neutral" label={`${k.scope_folders.length} folder${k.scope_folders.length === 1 ? "" : "s"}`} />);
    }
    if (k.expires_at) {
      const expired = Date.parse(k.expires_at) <= Date.now();
      out.push(
        <span key="exp" title={absoluteTime(k.expires_at)}>
          <Badge variant={expired ? "red" : "neutral"} label={expired ? "Expired" : `Expires ${relativeTime(k.expires_at)}`} />
        </span>,
      );
    }
    return out;
  }

  async function rename(k: AgentKeyInfo, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || trimmed === k.name) return setRenaming(null);
    setBusy(k.key_id);
    try {
      await AgentKeys.rename(k.key_id, trimmed);
      setRenaming(null);
      await load();
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't rename that agent."), type: "error" });
    } finally {
      setBusy(null);
    }
  }

  // Live keys first; revoked keys are purged after a while, so they need no toggle.
  const shown = [...(keys ?? []).filter((k) => !k.revoked_at), ...(keys ?? []).filter((k) => k.revoked_at)];

  return (
    <Card>
      <VStack gap={3} style={{ padding: 20 }}>
        <Heading level={2} id="connected-agents">
          Connected agents
        </Heading>
        <Text color="secondary">
          These agents act with your access. Revoke one to end its access.
        </Text>

        {/* Before the spinner branch: a failed load leaves `keys` null too. */}
        {failed ? (
          <LoadFailed
            isCompact
            icon={<Plug size={22} />}
            title="Couldn’t load connected agents"
            onRetry={() => void load()}
          />
        ) : keys === null ? (
          <VStack gap={2} hAlign="center" style={{ padding: "1.5rem 0" }}>
            <Spinner label="Loading connected agents…" />
          </VStack>
        ) : shown.length === 0 ? (
          <VStack gap={1}>
            <Text color="secondary">You haven’t connected any agents yet.</Text>
          </VStack>
        ) : (
          <ul className="member-list">
            {shown.map((k) => {
              const where = workspaceLabel(k.workspace_id);
              const isRevoked = Boolean(k.revoked_at);
              const isConnector = k.kind === "connector";
              return (
                <li key={k.key_id} className="member-row" style={isRevoked ? { opacity: 0.55 } : undefined}>
                  <VStack gap={0}>
                    <HStack gap={2} vAlign="center">
                      {renaming?.keyId === k.key_id ? (
                        <TextInput
                          label="Agent name"
                          isLabelHidden
                          size="sm"
                          value={renaming.name}
                          onChange={(v: string) => setRenaming({ keyId: k.key_id, name: v })}
                          onEnter={() => void rename(k, renaming.name)}
                        />
                      ) : (
                        <Text>{k.name || k.agent_id}</Text>
                      )}
                      {isRevoked && <Badge variant="neutral" label="Revoked" />}
                      {where && <Badge variant="neutral" label={where} />}
                      {!isRevoked && narrowingBadges(k)}
                    </HStack>
                    {rotated?.keyId === k.key_id && (
                      <VStack gap={1} style={{ marginTop: 8 }}>
                        <Banner
                          status="warning"
                          title={`Copy ${rotated.name}’s new key now`}
                          description="Shown once. Replace the old key with it."
                        />
                        <CodeBlock code={rotated.token} width="100%" isWrapped hasCopyButton size="sm" />
                      </VStack>
                    )}
                    <Text size="sm" color="secondary">
                      {isRevoked ? (
                        <span title={absoluteTime(k.revoked_at!)}>
                          Revoked {relativeTime(k.revoked_at!)}
                        </span>
                      ) : k.last_used_at ? (
                        <span title={absoluteTime(k.last_used_at)}>Last used {relativeTime(k.last_used_at)}</span>
                      ) : (
                        "Never used"
                      )}
                      {" · "}
                      {/* How the access was granted, which is also what revoking it undoes: an app signs in again, a pasted key stops working. */}
                      <span title={absoluteTime(k.created_at)}>
                        {isConnector ? "signed in " : "key created "}
                        {relativeTime(k.created_at)}
                      </span>
                    </Text>
                  </VStack>
                  {!isRevoked && (
                    <HStack gap={2} vAlign="center">
                      {confirming === k.key_id ? (
                        <>
                          <Button label="Cancel" variant="ghost" size="sm" onClick={() => setConfirming(null)} />
                          <Button
                            label="Confirm revoke"
                            variant="destructive"
                            size="sm"
                            isLoading={busy === k.key_id}
                            onClick={() => revoke(k)}
                          />
                        </>
                      ) : renaming?.keyId === k.key_id ? (
                        <>
                          <Button label="Cancel" variant="ghost" size="sm" onClick={() => setRenaming(null)} />
                          <Button
                            label="Save"
                            variant="secondary"
                            size="sm"
                            isLoading={busy === k.key_id}
                            onClick={() => void rename(k, renaming.name)}
                          />
                        </>
                      ) : (
                        <>
                          <Button
                            label="Rename"
                            variant="ghost"
                            size="sm"
                            icon={<Pencil size={13} />}
                            onClick={() => setRenaming({ keyId: k.key_id, name: k.name || "" })}
                          />
                          {/* A connector's token comes from the OAuth exchange, so a rotated one has nowhere to go. */}
                          {!isConnector && (
                            <Button
                              label="Rotate"
                              variant="ghost"
                              size="sm"
                              icon={<RefreshCw size={13} />}
                              isLoading={busy === k.key_id}
                              onClick={() => void rotate(k)}
                            />
                          )}
                          <Button label="Revoke" variant="ghost" size="sm" onClick={() => setConfirming(k.key_id)} />
                        </>
                      )}
                    </HStack>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </VStack>
    </Card>
  );
}
