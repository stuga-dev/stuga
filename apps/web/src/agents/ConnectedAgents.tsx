/**
 * Everything that acts with the viewer's access: apps that signed in (each a
 * grant over the workspaces the viewer chose) and keys they minted by hand,
 * with Rename, Rotate (keys) and Revoke. Which way access was granted is said
 * in the row's own line ("signed in" or "key created") rather than badged:
 * every row here is a connection, so that is not what a badge should
 * distinguish, and badges are left to what deviates — read-only, fewer
 * workspaces, folder scope, expiry, another workspace, revoked. Renaming lives
 * here rather than at connecting: an agent is named after its client, and only
 * someone who connected that client twice needs to tell the two apart — by
 * then both are in this list.
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
import { AgentKeys, Connections, type AgentKeyInfo, type ConnectionInfo, type WorkspaceInfo } from "../api";
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

/** One row: a sign-in or a key, as the list shows and acts on it. */
type Row = { id: string; name: string; agentId: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; access: "read" | "propose" } & (
  | { kind: "sign-in"; connection: ConnectionInfo }
  | { kind: "key"; key: AgentKeyInfo }
);

const fromConnection = (c: ConnectionInfo): Row => ({
  id: c.grant_id,
  name: c.name,
  agentId: c.agent_id,
  createdAt: c.created_at,
  lastUsedAt: c.last_used_at,
  revokedAt: c.revoked_at,
  access: c.access,
  kind: "sign-in",
  connection: c,
});

const fromKey = (k: AgentKeyInfo): Row => ({
  id: k.key_id,
  name: k.name,
  agentId: k.agent_id,
  createdAt: k.created_at,
  lastUsedAt: k.last_used_at,
  revokedAt: k.revoked_at,
  access: k.access,
  kind: "key",
  key: k,
});

export function ConnectedAgents({ activeWorkspaceId, workspaces, reloadSignal }: Props) {
  const toast = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Revoking cuts off a live integration, so it takes a second click on the same row.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // A rotated key's new token, shown once.
  const [rotated, setRotated] = useState<{ keyId: string; name: string; token: string } | null>(null);
  // The row being renamed, and the text typed into it.
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [{ connections }, { keys }] = await Promise.all([Connections.mine(), AgentKeys.mine()]);
      // Retired connector keys: their apps now sign in as connections.
      setRows([...connections.map(fromConnection), ...keys.filter((k) => k.kind === "key").map(fromKey)]);
    } catch {
      // Null, so a retry in flight never reads as "no agents".
      setFailed(true);
      setRows(null);
    }
  }, []);

  useEffect(() => {
    setConfirming(null);
    void load();
  }, [load, reloadSignal]);

  async function revoke(r: Row) {
    setBusy(r.id);
    try {
      await (r.kind === "sign-in" ? Connections.revoke(r.id) : AgentKeys.revoke(r.id));
      toast({ body: `${r.name} can no longer reach your documents.`, type: "info" });
      await load();
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't revoke that agent."), type: "error" });
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  async function rotate(r: Row) {
    setBusy(r.id);
    try {
      const out = await AgentKeys.rotate(r.id);
      setRotated({ keyId: r.id, name: r.name || r.agentId, token: out.token });
      toast({ body: `${r.name} has a new key. The old one stopped working just now.`, type: "info" });
      await load();
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't rotate that key."), type: "error" });
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }

  async function rename(r: Row, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || trimmed === r.name) return setRenaming(null);
    setBusy(r.id);
    try {
      await (r.kind === "sign-in" ? Connections.rename(r.id, trimmed) : AgentKeys.rename(r.id, trimmed));
      setRenaming(null);
      await load();
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn't rename that agent."), type: "error" });
    } finally {
      setBusy(null);
    }
  }

  function workspaceLabel(id: string): string | null {
    if (id === activeWorkspaceId) return null;
    return workspaces.find((w) => w.workspace_id === id)?.name ?? "another workspace";
  }

  /** What the agent may not do that its owner may. */
  function narrowingBadges(r: Row) {
    const out: React.ReactNode[] = [];
    if (r.access === "read") out.push(<Badge key="ro" variant="neutral" label="Read-only" />);
    if (r.kind === "sign-in") {
      const reach = r.connection.workspaces;
      if (reach && workspaces.some((w) => !reach.includes(w.workspace_id))) {
        const only = reach.length === 1 ? workspaces.find((w) => w.workspace_id === reach[0])?.name : undefined;
        out.push(<Badge key="ws" variant="neutral" label={only ?? `${reach.length} workspace${reach.length === 1 ? "" : "s"}`} />);
      }
      return out;
    }
    const k = r.key;
    const where = workspaceLabel(k.workspace_id);
    if (where) out.push(<Badge key="where" variant="neutral" label={where} />);
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

  // Live agents first; revoked keys are purged after a while, and revoked sign-ins stay as history.
  const shown = [...(rows ?? []).filter((r) => !r.revokedAt), ...(rows ?? []).filter((r) => r.revokedAt)];

  return (
    <Card>
      <VStack gap={3} style={{ padding: 20 }}>
        <Heading level={2} id="connected-agents">
          Connected agents
        </Heading>
        <Text color="secondary">These agents act with your access. Revoke one to end its access.</Text>

        {/* Before the spinner branch: a failed load leaves `rows` null too. */}
        {failed ? (
          <LoadFailed isCompact icon={<Plug size={22} />} title="Couldn’t load connected agents" onRetry={() => void load()} />
        ) : rows === null ? (
          <VStack gap={2} hAlign="center" style={{ padding: "1.5rem 0" }}>
            <Spinner label="Loading connected agents…" />
          </VStack>
        ) : shown.length === 0 ? (
          <VStack gap={1}>
            <Text color="secondary">You haven’t connected any agents yet.</Text>
          </VStack>
        ) : (
          <ul className="member-list">
            {shown.map((r) => {
              const isRevoked = Boolean(r.revokedAt);
              return (
                <li key={r.id} className="member-row" style={isRevoked ? { opacity: 0.55 } : undefined}>
                  <VStack gap={0}>
                    <HStack gap={2} vAlign="center">
                      {renaming?.id === r.id ? (
                        <TextInput
                          label="Agent name"
                          isLabelHidden
                          size="sm"
                          value={renaming.name}
                          onChange={(v: string) => setRenaming({ id: r.id, name: v })}
                          onEnter={() => void rename(r, renaming.name)}
                        />
                      ) : (
                        <Text>{r.name || r.agentId}</Text>
                      )}
                      {isRevoked && <Badge variant="neutral" label="Revoked" />}
                      {!isRevoked && narrowingBadges(r)}
                    </HStack>
                    {rotated?.keyId === r.id && (
                      <VStack gap={1} style={{ marginTop: 8 }}>
                        <Banner status="warning" title={`Copy ${rotated.name}’s new key now`} description="Shown once. Replace the old key with it." />
                        <CodeBlock code={rotated.token} width="100%" isWrapped hasCopyButton size="sm" />
                      </VStack>
                    )}
                    <Text size="sm" color="secondary">
                      {isRevoked ? (
                        <span title={absoluteTime(r.revokedAt!)}>Revoked {relativeTime(r.revokedAt!)}</span>
                      ) : r.lastUsedAt ? (
                        <span title={absoluteTime(r.lastUsedAt)}>Last used {relativeTime(r.lastUsedAt)}</span>
                      ) : (
                        "Never used"
                      )}
                      {" · "}
                      {/* How the access was granted, which is also what revoking it undoes: an app signs in again, a pasted key stops working. */}
                      <span title={absoluteTime(r.createdAt)}>
                        {r.kind === "sign-in" ? "signed in " : "key created "}
                        {relativeTime(r.createdAt)}
                      </span>
                      {r.kind === "sign-in" && r.connection.verified_host && ` · verified by ${r.connection.verified_host}`}
                    </Text>
                  </VStack>
                  {!isRevoked && (
                    <HStack gap={2} vAlign="center">
                      {confirming === r.id ? (
                        <>
                          <Button label="Cancel" variant="ghost" size="sm" onClick={() => setConfirming(null)} />
                          <Button label="Confirm revoke" variant="destructive" size="sm" isLoading={busy === r.id} onClick={() => revoke(r)} />
                        </>
                      ) : renaming?.id === r.id ? (
                        <>
                          <Button label="Cancel" variant="ghost" size="sm" onClick={() => setRenaming(null)} />
                          <Button label="Save" variant="secondary" size="sm" isLoading={busy === r.id} onClick={() => void rename(r, renaming.name)} />
                        </>
                      ) : (
                        <>
                          <Button label="Rename" variant="ghost" size="sm" icon={<Pencil size={13} />} onClick={() => setRenaming({ id: r.id, name: r.name || "" })} />
                          {/* A sign-in's tokens refresh themselves, so only a pasted key rotates. */}
                          {r.kind === "key" && (
                            <Button label="Rotate" variant="ghost" size="sm" icon={<RefreshCw size={13} />} isLoading={busy === r.id} onClick={() => void rotate(r)} />
                          )}
                          <Button label="Revoke" variant="ghost" size="sm" onClick={() => setConfirming(r.id)} />
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
