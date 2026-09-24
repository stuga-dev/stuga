/**
 * The consent screen /oauth/authorize hands a person to. Anyone can link
 * straight to this page with any query string, so it never navigates to the
 * redirect it was given: both answers go to POST /oauth/consent, which checks
 * the address against the client's registered ones and returns where to go.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@astryxdesign/core/Button";
import { Text, Heading } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { Link } from "@astryxdesign/core/Link";
import { getActiveWorkspace } from "../lib/session/workspace-pointer";
import { Workspaces } from "../api";
import { Brand, nodeName } from "../shell/Brand";
import { authHeaders } from "../lib/http/client";

export interface ConsentRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

/** Where the server sends the browser after this answer, or null when it refused the request. */
export async function answerConsent(decision: "allow" | "deny", request: ConsentRequest): Promise<string | null> {
  try {
    const res = await fetch("/oauth/consent", {
      method: "POST",
      headers: await authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        decision,
        client_id: request.clientId,
        redirect_uri: request.redirectUri,
        code_challenge: request.codeChallenge,
        state: request.state,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { redirect?: unknown };
    return typeof body.redirect === "string" ? body.redirect : null;
  } catch {
    return null;
  }
}

/** The host the answer goes back to; "" when the address does not parse. */
function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return "";
  }
}

export function OAuthAuthorize() {
  const nav = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const request: ConsentRequest = {
    clientId: params.get("client_id") ?? "",
    redirectUri: params.get("redirect_uri") ?? "",
    codeChallenge: params.get("code_challenge") ?? "",
    state: params.get("state") ?? "",
  };
  // Registration is open, so this name identifies nothing by itself; the redirect host is shown beside it.
  const clientName = params.get("client_name") || "an application";

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A failure costs the workspace's name, not the screen.
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Workspaces.list()
      .then(({ workspaces, active }) => {
        if (!alive) return;
        const id = getActiveWorkspace() ?? active;
        setWorkspaceName(workspaces.find((w) => w.workspace_id === id)?.name ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const redirectHost = hostOf(request.redirectUri);
  const valid = Boolean(request.clientId && redirectHost && request.codeChallenge);
  const scopeName = workspaceName ?? "this workspace";

  async function allow() {
    setBusy(true);
    setErr(null);
    const redirect = await answerConsent("allow", request);
    if (redirect) {
      window.location.assign(redirect);
      return;
    }
    setErr("Connection failed. Try again or restart it from the app.");
    setBusy(false);
  }

  async function deny() {
    setBusy(true);
    window.location.assign((await answerConsent("deny", request)) ?? "/");
  }

  return (
    <div style={{ maxWidth: 460, margin: "10vh auto", padding: "0 1.5rem" }}>
      <VStack gap={4}>
        <div className="brand">
          <Brand />
          <Heading level={1}>{nodeName()}</Heading>
        </div>
        {!valid ? (
          <>
            <Heading level={2}>Incomplete request</Heading>
            <Text color="secondary">
              This link is missing app details. Restart the connection from the app.
            </Text>
            <HStack gap={2}>
              <Button label="All documents" variant="primary" onClick={() => nav("/")} />
            </HStack>
          </>
        ) : (
          <>
            <Heading level={2}>
              Connect {clientName} to {scopeName}
            </Heading>
            <Text type="supporting" color="secondary">
              You’ll return to <strong>{redirectHost}</strong>. Deny if you don’t recognize it.
            </Text>
            <Text>
              <strong>{clientName}</strong> can act as you to:
            </Text>
            <List listStyle="disc" density="compact">
              <ListItem
                label={<Text type="supporting">Read your documents, databases and comments</Text>}
              />
              <ListItem label={<Text type="supporting">Create and edit documents</Text>} />
              <ListItem
                label={
                  <Text type="supporting">
                    Create tables and edit database rows
                  </Text>
                }
              />
              <ListItem label={<Text type="supporting">Comment and upload images</Text>} />
            </List>
            <Text type="supporting" color="secondary">
              Starts in {scopeName}, but can use any workspace you belong to with your current role. It can’t manage
              access. Changes are attributed and require review unless auto-apply is enabled.
            </Text>
            <Text type="supporting" color="secondary">
              Revoke anytime in{" "}
              <Link href="/settings/agents" target="_blank" rel="noopener noreferrer" type="supporting">
                Settings → Your own AI
              </Link>{" "}
              (opens in a new tab).
            </Text>
            {err && (
              <Text type="supporting" color="secondary">
                {err}
              </Text>
            )}
            <HStack gap={2}>
              <Button label={busy ? "Connecting…" : "Allow"} variant="primary" isDisabled={busy} onClick={allow} />
              <Button label="Deny" variant="ghost" isDisabled={busy} onClick={deny} />
            </HStack>
          </>
        )}
      </VStack>
    </div>
  );
}
