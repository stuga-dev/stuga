/**
 * The settings shell: one rail with three scopes as groups (preferences, this
 * workspace, this node). It is not under WorkspaceLayout, because node settings
 * need no workspace; the workspace scope sends a member of none to onboarding.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "@astryxdesign/core/AppShell";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Bot, Gauge, Palette, Plug, ScrollText, SlidersHorizontal, UserRound, Users } from "lucide-react";
import { AppTopNav } from "../../shell/AppTopNav";
import { CommandPalette } from "../../shell/command-palette/CommandPalette";
import { CommandPaletteProvider } from "../../shell/command-palette/context";
import { NODE_CATEGORIES } from "./node/categories";
import { Me, NodeSettings, Workspaces, type AvailableUpdate, type WorkspaceInfo } from "../../api";
import { getActiveWorkspace } from "../../lib/session/workspace-pointer";
import type { WorkspaceRole } from "@stuga/protocol/domain/roles";
import "../../styles/settings.css";

/** What every settings page needs to know about who is asking and about what. */
interface SettingsScope {
  /** False until identity and the workspace list have landed; until then a null `workspace` means nothing. */
  isReady: boolean;
  /** The active workspace, or null when the caller belongs to none. */
  workspace: WorkspaceInfo | null;
  role: WorkspaceRole | null;
  /** Owner or admin of the active workspace: may change tenant settings. */
  canManage: boolean;
  isOwner: boolean;
  /** Administers the machine. Orthogonal to any workspace role. */
  isNodeAdmin: boolean;
  /** The caller's own alias, for telling their member row from everyone else's. */
  me: string;
  /** Re-read identity and workspace after a page changes them, such as a rename the rail's heading shows. */
  reload: () => Promise<void>;
}

const Ctx = createContext<SettingsScope | null>(null);

export function useSettingsScope(): SettingsScope {
  const scope = useContext(Ctx);
  if (!scope) throw new Error("useSettingsScope() requires <SettingsLayout>");
  return scope;
}

export function SettingsLayout() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [isReady, setIsReady] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [isNodeAdmin, setIsNodeAdmin] = useState(false);
  const [me, setMe] = useState("");
  /** A newer version the node knows of, which marks About in the rail; only an administrator is told. */
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);

  const load = useCallback(async () => {
    // Together, so the gated groups appear at once instead of growing the rail under the pointer.
    const [identity, list] = await Promise.allSettled([Me.whoami(), Workspaces.list()]);
    if (identity.status === "fulfilled") {
      setIsNodeAdmin(identity.value.node_admin);
      setMe(identity.value.alias);
    }
    if (list.status === "fulfilled") {
      const { workspaces, active } = list.value;
      const id = active ?? getActiveWorkspace();
      setWorkspace(workspaces.find((w) => w.workspace_id === id) ?? null);
    }
    setIsReady(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!isNodeAdmin) return;
    let alive = true;
    NodeSettings.version().then(
      (v) => alive && setUpdate(v.update.available),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [isNodeAdmin]);

  const role = workspace?.role ?? null;
  const scope = useMemo<SettingsScope>(
    () => ({
      isReady,
      workspace,
      role,
      canManage: role === "owner" || role === "admin",
      isOwner: role === "owner",
      isNodeAdmin,
      me,
      reload: load,
    }),
    [isReady, workspace, role, isNodeAdmin, me, load],
  );

  // The server refuses these below admin; the pages keep their own refusal states for deep links.
  const canSeeLedger = scope.canManage;
  // Your own AI mints keys pinned to the active workspace, so it needs one too.
  const needsWorkspace = pathname.startsWith("/settings/workspace") || pathname === "/settings/agents";

  const item = (label: string, icon: ReactNode, path: string, endContent?: ReactNode) => (
    <SideNavItem
      key={path}
      label={label}
      icon={icon}
      isSelected={pathname === path}
      onClick={() => nav(path)}
      endContent={endContent}
    />
  );

  const updateMark = update && (
    <StatusDot
      variant={update.security ? "warning" : "accent"}
      label={update.security ? `Security update: Stuga ${update.version}` : `Stuga ${update.version} is available`}
    />
  );

  const shell = (
    <AppShell
      topNav={<AppTopNav title="Settings" hasWorkspaceSwitcher={workspace !== null} />}
      contentPadding={0}
      sideNav={
        // The library and Ask rails' geometry, so the content edge does not jump between them.
        <SideNav resizable={{ defaultWidth: 248, minWidth: 200, maxWidth: 380, autoSaveId: "stuga-settings-nav" }}>
          <SideNavSection title="Preferences">
            {item("Profile", <UserRound size={16} />, "/settings/profile")}
            {item("Appearance", <Palette size={16} />, "/settings/appearance")}
            {item("Your own AI", <Plug size={16} />, "/settings/agents")}
          </SideNavSection>

          {isReady && workspace && (
            <SideNavSection title={`This workspace — ${workspace.name}`}>
              {item("General", <SlidersHorizontal size={16} />, "/settings/workspace")}
              {item("Members", <Users size={16} />, "/settings/workspace/members")}
              {item("Agents", <Bot size={16} />, "/settings/workspace/agents")}
              {canSeeLedger && item("Audit log", <ScrollText size={16} />, "/settings/workspace/audit")}
              {canSeeLedger && item("AI usage", <Gauge size={16} />, "/settings/workspace/usage")}
            </SideNavSection>
          )}

          {isReady && isNodeAdmin && (
            <SideNavSection title="This node">
              {NODE_CATEGORIES.map((c) => item(c.label, c.icon, `/settings/node/${c.key}`, c.key === "about" ? updateMark : undefined))}
            </SideNavSection>
          )}
        </SideNav>
      }
    >
      <Ctx.Provider value={scope}>
        <Outlet />
      </Ctx.Provider>
    </AppShell>
  );

  if (isReady && needsWorkspace && !workspace) return <Navigate to="/onboarding" replace />;

  // The palette searches a workspace, so a member of none gets the shell without it.
  return workspace ? (
    <CommandPaletteProvider>
      <CommandPalette />
      {shell}
    </CommandPaletteProvider>
  ) : (
    shell
  );
}
