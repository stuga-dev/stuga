/**
 * The TopNav's workspace picker. Switching stores the choice and reloads the
 * app, so no state from the previous tenant survives. Once the person keeps
 * bookmarks to other Stuga nodes, this node's name heads its workspaces and
 * Other nodes lists the bookmarks: opening one navigates the whole page to its
 * origin, where that node's own session applies. Alone, neither heading shows.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DropdownMenu, type DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { PanelsTopLeft, Plus, Check, Server, ServerPlus, Settings2 } from "lucide-react";
import { OtherNodes, Workspaces, onWorkspaceListChanged, type OtherNode, type WorkspaceInfo } from "../api";
import { getActiveWorkspace, setActiveWorkspace } from "../lib/session/workspace-pointer";
import { nodeLabel } from "./Brand";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";
import { OtherNodesDialog } from "./OtherNodesDialog";
import { createWorkspaceFrom, landingPath, type StartChoice } from "./StartWith";
import type { DocAccessMode } from "@stuga/protocol/domain/workspaces";

/**
 * Paths that carry no tenant's ids, so a switch stays on them; any other path
 * names an item of the old workspace and lands in the library.
 */
const TENANT_AGNOSTIC_PREFIXES = ["/settings"];

export function survivesSwitch(path: string): boolean {
  return TENANT_AGNOSTIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export function WorkspaceSwitcher() {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [active, setActive] = useState<string | null>(getActiveWorkspace());
  const [showCreate, setShowCreate] = useState(false);
  const [otherNodes, setOtherNodes] = useState<OtherNode[]>([]);
  const [showNodes, setShowNodes] = useState(false);

  const alive = useRef(true);
  const readWorkspaces = useCallback(() => {
    Workspaces.list()
      .then(({ workspaces, active }) => {
        if (!alive.current) return;
        setWorkspaces(workspaces);
        setActive(active);
        // Adopt the server's resolution, null included, so a stale id stops riding requests.
        if (getActiveWorkspace() !== active) setActiveWorkspace(active);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    alive.current = true;
    readWorkspaces();
    // A rename on the page below would otherwise leave this naming the old name.
    const stop = onWorkspaceListChanged(readWorkspaces);
    return () => {
      alive.current = false;
      stop();
    };
  }, [readWorkspaces]);

  useEffect(() => {
    let alive = true;
    function read() {
      // A failed read leaves the menu as it is with none: only the row that adds one.
      OtherNodes.list()
        .then(({ nodes }) => alive && setOtherNodes(nodes))
        .catch(() => {});
    }
    read();
    const stop = OtherNodes.onChanged(read);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  const activeWs = workspaces.find((w) => w.workspace_id === active);
  const activeName = activeWs?.name ?? "Workspace";

  function switchTo(workspaceId: string) {
    if (workspaceId === active) return;
    setActiveWorkspace(workspaceId);
    const here = window.location.pathname;
    window.location.assign(survivesSwitch(here) ? here : "/");
  }

  // A failure is the dialog's to show; a new workspace opens with a reload, like a switch.
  async function createWorkspace(name: string, defaultDocAccess: DocAccessMode, start: StartChoice) {
    const ws = await createWorkspaceFrom(start, name, defaultDocAccess);
    setActiveWorkspace(ws.workspace_id);
    window.location.assign(landingPath(ws));
  }

  // A node's name only tells it apart from another: with no other node kept, it would name the obvious.
  const hasOtherNodes = otherNodes.length > 0;

  const items: DropdownMenuOption[] = [
    {
      type: "section",
      id: "workspaces",
      ...(hasOtherNodes ? { title: nodeLabel() } : {}),
      items: workspaces.map((w) => ({
        // Keyed by id: the list grows after first paint, and a shifted row would switch to the wrong tenant.
        id: w.workspace_id,
        label: w.name,
        icon: w.workspace_id === active ? <Check size={15} /> : <PanelsTopLeft size={15} />,
        onClick: () => switchTo(w.workspace_id),
      })),
    },
    { type: "divider" },
    { id: "create", label: "Create workspace", icon: <Plus size={15} />, onClick: () => setShowCreate(true) },
    ...(hasOtherNodes
      ? ([
          { type: "divider" },
          {
            type: "section",
            id: "other-nodes",
            title: "Other nodes",
            items: [
              ...otherNodes.map((node) => {
                const origin = openableOrigin(node.origin);
                return {
                  id: `node-${node.id}`,
                  label: node.label,
                  description: bookmarkHost(node),
                  icon: <Server size={15} />,
                  isDisabled: origin === null,
                  onClick: () => {
                    if (origin !== null) window.location.assign(origin);
                  },
                };
              }),
              { id: "manage-nodes", label: "Add or remove nodes…", icon: <Settings2 size={15} />, onClick: () => setShowNodes(true) },
            ],
          },
        ] satisfies DropdownMenuOption[])
      : [{ id: "add-node", label: "Add another node…", icon: <ServerPlus size={15} />, onClick: () => setShowNodes(true) }]),
  ];

  return (
    <>
      <DropdownMenu
        button={{ label: activeName, variant: "ghost", size: "sm", icon: <PanelsTopLeft size={15} /> }}
        menuWidth={240}
        placement="below"
        hasChevron
        items={items}
        // Read again on opening: an import the create dialog stopped waiting for lands later.
        onOpenChange={(isOpen) => isOpen && readWorkspaces()}
      />
      <CreateWorkspaceDialog
        isOpen={showCreate}
        onSubmit={createWorkspace}
        onClose={() => setShowCreate(false)}
      />
      <OtherNodesDialog isOpen={showNodes} nodes={otherNodes} onClose={() => setShowNodes(false)} />
    </>
  );
}

/**
 * A bookmark's origin, only if it is a web address: the node refuses anything
 * else, but whatever this page navigates to runs as this node, so a value that
 * reached the list some other way (a `javascript:` URL) is never followed.
 */
export function openableOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** The bookmark's host under its label, unless the label already is the host; nothing for an address that is not one. */
export function bookmarkHost(node: OtherNode): string | undefined {
  const origin = openableOrigin(node.origin);
  if (origin === null) return undefined;
  const host = new URL(origin).host;
  return node.label === host ? undefined : host;
}
