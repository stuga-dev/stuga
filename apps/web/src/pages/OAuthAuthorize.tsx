/**
 * The consent screen /oauth/authorize hands a person to: which workspaces the
 * app may use, and whether it may only read. Anyone can link straight to this
 * page with any query string, so it never navigates to the redirect it was
 * given, and what it says about the app comes from the node, not the link:
 * both answers go to POST /oauth/consent, which checks the address against the
 * client's registered ones and returns where to go.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Text, Heading } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Link } from "@astryxdesign/core/Link";
import { Workspaces, type WorkspaceInfo } from "../api";
import { Brand, nodeName } from "../shell/Brand";
import { authHeaders } from "../lib/http/client";
import { REAUTH_HEADER, confirmIdentity, reauthMethods } from "../lib/session/reauth";
import { t } from "../i18n/i18n";
import { tRich } from "../i18n/rich";

export interface ConsentRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

/** What the person grants: the workspaces ("all" includes ones joined later) and the access. */
export interface ConsentChoice {
  workspaces: "all" | string[];
  access: "read" | "propose";
}

/** Where the server sends the browser after this answer, or null when it refused the request. */
export async function answerConsent(decision: "allow" | "deny", request: ConsentRequest, choice?: ConsentChoice): Promise<string | null> {
  try {
    const send = async () =>
      fetch("/oauth/consent", {
        method: "POST",
        headers: await authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          decision,
          client_id: request.clientId,
          redirect_uri: request.redirectUri,
          code_challenge: request.codeChallenge,
          state: request.state,
          ...(decision === "allow" && choice ? { workspaces: choice.workspaces, access: choice.access } : {}),
        }),
      });
    let res = await send();
    // At the remote address an app is connected only from a sign-in confirmed in the last five minutes.
    if (res.status === 401 && res.headers.get(REAUTH_HEADER)) {
      const refused = (await res.json().catch(() => null)) as { error?: unknown; methods?: unknown } | null;
      if (!(await confirmIdentity(reauthMethods({ code: refused?.error, methods: refused?.methods }) ?? []))) return null;
      res = await send();
    }
    if (!res.ok) return null;
    const body = (await res.json()) as { redirect?: unknown };
    return typeof body.redirect === "string" ? body.redirect : null;
  } catch {
    return null;
  }
}

interface ClientInfo {
  client_name: string;
  /** The host that vouches for the app; null for one that registered itself. */
  verified_host: string | null;
}

/** The node's own record of the app, or null when it has none. */
export async function clientInfo(clientId: string): Promise<ClientInfo | null> {
  try {
    const res = await fetch(`/oauth/client?client_id=${encodeURIComponent(clientId)}`);
    return res.ok ? ((await res.json()) as ClientInfo) : null;
  } catch {
    return null;
  }
}

/**
 * Where the answer goes back to: the host of a web address, or a native app's own
 * scheme in full (`cursor://anysphere.cursor-mcp`, `com.example.app:`), which names
 * the app. "" when the address does not parse.
 */
function hostOf(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:" || url.protocol === "http:") return url.host;
    return url.host ? `${url.protocol}//${url.host}` : url.protocol;
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

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [client, setClient] = useState<ClientInfo | null>(null);
  // A guest connects no agent, so their guest workspaces are not offered.
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [later, setLater] = useState(false);
  const [access, setAccess] = useState<"read" | "propose">("propose");

  useEffect(() => {
    let alive = true;
    void clientInfo(request.clientId).then((info) => alive && setClient(info));
    Workspaces.list()
      .then(({ workspaces: all }) => {
        if (!alive) return;
        const own = all.filter((w) => w.role !== "guest");
        setWorkspaces(own);
        setChosen(own.map((w) => w.workspace_id));
      })
      .catch(() => alive && setWorkspaces([]));
    return () => {
      alive = false;
    };
  }, [request.clientId]);

  const redirectHost = hostOf(request.redirectUri);
  const valid = Boolean(request.clientId && redirectHost && request.codeChallenge);
  // The app's own name is self-asserted unless the node fetched it from a host that vouches for it.
  const appName = client?.client_name || null;
  const canAllow = later || chosen.length > 0;

  async function allow() {
    setBusy(true);
    setErr(null);
    const redirect = await answerConsent("allow", request, { workspaces: later ? "all" : chosen, access });
    if (redirect) {
      window.location.assign(redirect);
      return;
    }
    setErr(t("auth.oauth.failed"));
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
            <Heading level={2}>{t("auth.oauth.incomplete")}</Heading>
            <Text color="secondary">{t("auth.oauth.incompleteBody")}</Text>
            <HStack gap={2}>
              <Button label={t("common.allDocuments")} variant="primary" onClick={() => nav("/")} />
            </HStack>
          </>
        ) : workspaces !== null && workspaces.length === 0 ? (
          <>
            <Heading level={2}>{t("auth.oauth.noWorkspace")}</Heading>
            <Text color="secondary">{t("auth.oauth.noWorkspaceBody")}</Text>
            <HStack gap={2}>
              <Button label={t("auth.oauth.deny")} variant="ghost" isDisabled={busy} onClick={deny} />
            </HStack>
          </>
        ) : (
          <>
            <Heading level={2}>{appName ? t("auth.oauth.connect", { app: appName }) : t("auth.oauth.connectUnnamed")}</Heading>
            <Text type="supporting" color="secondary">
              {client?.verified_host
                ? tRich("auth.oauth.verified", { host: client.verified_host, redirect: redirectHost, strong: (chunks) => <strong>{chunks}</strong> })
                : tRich("auth.oauth.unverified", { redirect: redirectHost, strong: (chunks) => <strong>{chunks}</strong> })}
            </Text>
            {workspaces && (
              <VStack gap={2}>
                <CheckboxList label={t("auth.oauth.workspaces")} value={chosen} onChange={setChosen} density="compact" isDisabled={later}>
                  {workspaces.map((w) => (
                    <CheckboxListItem key={w.workspace_id} value={w.workspace_id} label={w.name} />
                  ))}
                </CheckboxList>
                <CheckboxInput label={t("auth.oauth.joinLater")} value={later} onChange={setLater} />
              </VStack>
            )}
            <RadioList label={t("common.access")} value={access} onChange={(v) => setAccess(v === "read" ? "read" : "propose")}>
              <RadioListItem value="propose" label={t("auth.oauth.readAndSuggest")} description={t("auth.oauth.readAndSuggestHint")} />
              <RadioListItem value="read" label={t("auth.oauth.readOnly")} />
            </RadioList>
            <Text type="supporting" color="secondary">
              {tRich("auth.oauth.revoke", {
                settings: t("common.settings"),
                agents: t("common.yourAiAgents"),
                link: (chunks) => (
                  <Link href="/settings/agents" target="_blank" rel="noopener noreferrer" type="supporting">
                    {chunks}
                  </Link>
                ),
              })}
            </Text>
            {err && (
              <Text type="supporting" color="secondary">
                {err}
              </Text>
            )}
            <HStack gap={2}>
              <Button label={busy ? t("auth.oauth.connecting") : t("auth.oauth.allow")} variant="primary" isDisabled={busy || !canAllow} onClick={allow} />
              <Button label={t("auth.oauth.deny")} variant="ghost" isDisabled={busy} onClick={deny} />
            </HStack>
          </>
        )}
      </VStack>
    </div>
  );
}
