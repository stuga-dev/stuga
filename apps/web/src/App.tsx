import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from "react-router-dom";
import { Theme } from "@astryxdesign/core/theme";
import { LayerProvider } from "@astryxdesign/core/Layer";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Section } from "@astryxdesign/core/Section";
import { VStack } from "@astryxdesign/core/VStack";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { DocList } from "./pages/DocList";
import { Login } from "./pages/Login";
import { AuthComplete } from "./pages/AuthComplete";
import { FirstVisit } from "./pages/FirstVisit";
import { ResetPassword } from "./pages/ResetPassword";
import { OAuthAuthorize } from "./pages/OAuthAuthorize";
import { NodeSettingsPage } from "./pages/settings/node";
import { SettingsLayout } from "./pages/settings/SettingsLayout";
import { Profile } from "./pages/settings/Profile";
import { Appearance } from "./pages/settings/Appearance";
import { YourOwnAi } from "./pages/settings/YourOwnAi";
import { WorkspaceGeneral } from "./pages/settings/WorkspaceGeneral";
import { WorkspaceMembers } from "./pages/settings/WorkspaceMembers";
import { AuditLog } from "./pages/settings/AuditLog";
import { AiUsage } from "./pages/settings/AiUsage";
import { AgentSettings } from "./pages/settings/AgentSettings";
import { ReviewPage } from "./pages/ReviewPage";
import { DEFAULT_NODE_CATEGORY } from "./pages/settings/node/categories";
import { JoinDoc, JoinWorkspace } from "./pages/JoinLink";
import { WorkspaceOnboarding } from "./pages/WorkspaceOnboarding";
import { CommandPalette } from "./shell/command-palette/CommandPalette";
import { CommandPaletteProvider } from "./shell/command-palette/context";
import { NodeHealthBanner } from "./shell/NodeHealthBanner";
import { Workspaces } from "./api";
import { getActiveWorkspace, setActiveWorkspace } from "./lib/session/workspace-pointer";
import { getToken } from "./lib/session/tokens";
import { rememberLoginReturn, rememberWorkspaceReturn } from "./lib/session/return-path";
import { ensureMediaTicket, startMediaSession } from "./lib/session/tickets";
import { useThemeMode } from "./state/theme";
import { useBrandingVersion } from "./state/branding";
import "./styles/shell.css";

// Lazy so the editor, the grid and markdown-it stay out of the login and library bundles.
const ItemPage = lazy(() => import("./pages/ItemPage").then(({ ItemPage }) => ({ default: ItemPage })));
const AskPage = lazy(() => import("./pages/AskPage"));

function AuthLayout() {
  const { pathname, search } = useLocation();
  const signedIn = getToken() !== null;
  useEffect(() => {
    if (signedIn) startMediaSession();
  }, [signedIn]);
  if (!signedIn) {
    rememberLoginReturn(pathname + search);
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}

/** Holds the whole shell until the caller's workspaces are known. */
function WorkspaceLayout() {
  const { pathname, search } = useLocation();
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  /** The load has run long enough that a bare spinner no longer explains itself. */
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    setSlow(false);
    const t = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(t);
  }, [attempt]);

  useEffect(() => {
    let alive = true;
    // The media cookie is minted before any view paints document images: an
    // <img> that 401s does not retry. ensureMediaTicket never rejects.
    void Promise.all([Workspaces.list(), ensureMediaTicket()])
      .then(([{ workspaces, active }]) => {
        if (!alive) return;
        // Adopt the server's answer, including "none": a stale id from another
        // account must not keep riding x-stuga-workspace.
        if (getActiveWorkspace() !== active) setActiveWorkspace(active);
        setState(workspaces.length > 0 ? "ready" : "empty");
      })
      .catch(() => {
        if (alive) setState("error");
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = () => {
    setState("loading");
    setAttempt((value) => value + 1);
  };

  if (state === "loading") {
    return (
      <AppShell>
        <Section padding={6} variant="transparent">
          <VStack gap={3} hAlign="center" style={{ paddingTop: "20vh" }}>
            <Spinner label="Loading workspace..." />
            {slow && (
              <>
                <Text type="supporting" color="secondary">
                  This is taking longer than usual. The database may be waking up.
                </Text>
                <Button label="Retry" variant="secondary" onClick={retry} />
              </>
            )}
          </VStack>
        </Section>
      </AppShell>
    );
  }
  if (state === "empty") {
    rememberWorkspaceReturn(pathname + search);
    return <Navigate to="/onboarding" replace />;
  }
  if (state === "error") {
    return (
      <AppShell>
        <Section padding={6} variant="transparent">
          <VStack gap={3} hAlign="center" style={{ paddingTop: "20vh" }}>
            <Banner status="error" title="Couldn't load your workspaces" />
            <Button label="Retry" variant="secondary" onClick={retry} />
          </VStack>
        </Section>
      </AppShell>
    );
  }
  // The palette owns the dialog and a page owns the control that opens it, so the provider wraps both.
  return (
    <CommandPaletteProvider>
      <CommandPalette />
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
    </CommandPaletteProvider>
  );
}

export function App() {
  const mode = useThemeMode();
  // Re-renders the tree when node branding changes, so every brand mark and name repaints.
  useBrandingVersion();
  return (
    <Theme theme={neutralTheme} mode={mode}>
      <LayerProvider>
        {/* Outside the router: an unreachable database concerns every page, the login screen included. */}
        <NodeHealthBanner />
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            {/* Where a sign-in through the identity provider lands; the node leaves both to the app. */}
            <Route path="/auth/complete" element={<AuthComplete />} />
            <Route path="/auth/first-visit" element={<FirstVisit />} />
            {/* A reset link from Account recovery or `reset-password`: signed out, like the login page. */}
            <Route path="/reset/:token" element={<ResetPassword />} />
            <Route element={<AuthLayout />}>
              <Route element={<WorkspaceLayout />}>
                <Route path="/" element={<DocList />} />
                <Route path="/doc/:docId" element={<ItemPage />} />
                <Route path="/ask/:threadId?" element={<AskPage />} />
                <Route path="/review" element={<ReviewPage />} />
                <Route path="/oauth/consent" element={<OAuthAuthorize />} />
              </Route>
              {/* Not under WorkspaceLayout: node settings need no workspace, and
                  SettingsLayout applies the workspace requirement per scope. */}
              <Route path="/settings" element={<SettingsLayout />}>
                <Route index element={<Navigate to="/settings/profile" replace />} />
                <Route path="profile" element={<Profile />} />
                <Route path="appearance" element={<Appearance />} />
                <Route path="agents" element={<YourOwnAi />} />
                <Route path="workspace" element={<WorkspaceGeneral />} />
                <Route path="workspace/members" element={<WorkspaceMembers />} />
                <Route path="workspace/audit" element={<AuditLog />} />
                <Route path="workspace/usage" element={<AiUsage />} />
                <Route path="workspace/agents" element={<AgentSettings />} />
                <Route path="node" element={<Navigate to={`/settings/node/${DEFAULT_NODE_CATEGORY}`} replace />} />
                <Route path="node/:category" element={<NodeSettingsPage />} />
              </Route>
              <Route path="/onboarding" element={<WorkspaceOnboarding />} />
              <Route path="/join/:token" element={<JoinWorkspace />} />
              <Route path="/s/:token" element={<JoinDoc />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </LayerProvider>
    </Theme>
  );
}
