/**
 * Landing pages for invite links (/join/:token) and document share links
 * (/s/:token). Redeeming is not undoable from here and binds whichever account
 * this browser is signed in as, so the account is named and the person confirms.
 * Redeeming is also the only lookup, so nothing about the target shows first.
 */
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Section } from "@astryxdesign/core/Section";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Button } from "@astryxdesign/core/Button";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Docs, Me, Workspaces } from "../api";
import { setActiveWorkspace } from "../lib/session/workspace-pointer";
import { logout } from "../lib/session/tokens";
import { errorMessage } from "../lib/http/client";
import { t } from "../i18n/i18n";

interface LinkCopy {
  missingToken: string;
  failedTitle: string;
  failedFallback: string;
  failedHint: string;
  title: string;
  /** What confirming does to the named account. */
  consequence: (account: string | null) => string;
  confirm: (account: string | null) => string;
  /** Signing out lands on the sign-in page, not back on this link. */
  switchHint: string;
}

/** Redeems the token and names the page to load; the page reloads so every workspace-scoped view starts clean. */
type Redeem = (token: string) => Promise<{ workspaceId: string; destination: string }>;

function RedeemLinkPage({ redeem, copy }: { redeem: Redeem; copy: LinkCopy }) {
  const { token } = useParams<{ token: string }>();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  /** Whether "/" lands in the library or, for a member of no workspace, in onboarding. */
  const [ownsWorkspace, setOwnsWorkspace] = useState(true);
  /** Undefined while whoami is in flight; null when it failed, which costs the name, not the step. */
  const [account, setAccount] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setError(copy.missingToken);
      return;
    }
    let alive = true;
    Me.whoami()
      .then(({ username, email, display_name, alias }) => {
        if (alive) setAccount(username ? `@${username}` : email || display_name || alias || null);
      })
      .catch(() => {
        if (alive) setAccount(null);
      });
    return () => {
      alive = false;
    };
  }, [token, copy.missingToken]);

  function confirm() {
    if (!token || busy) return;
    setBusy(true);
    redeem(token)
      .then(({ workspaceId, destination }) => {
        setActiveWorkspace(workspaceId);
        window.location.assign(destination);
      })
      .catch((e) => {
        setBusy(false);
        setError(errorMessage(e, copy.failedFallback));
        // Only to label the way out honestly; a failure keeps the default label.
        Workspaces.list()
          .then(({ workspaces }) => setOwnsWorkspace(workspaces.length > 0))
          .catch(() => {});
      });
  }

  return (
    <AppShell>
      <Section padding={6} variant="transparent">
        <VStack gap={3} hAlign="center" style={{ paddingTop: "22vh" }}>
          {error ? (
            <>
              <Heading level={1}>{copy.failedTitle}</Heading>
              <Text color="secondary">{error}</Text>
              <Text type="supporting" color="secondary">
                {copy.failedHint}
              </Text>
              <Button
                label={ownsWorkspace ? t("common.allDocuments") : t("auth.join.createOwnWorkspace")}
                variant="primary"
                onClick={() => nav("/")}
              />
            </>
          ) : account === undefined ? (
            <Spinner label={t("auth.join.checkingAccount")} />
          ) : (
            <>
              <Heading level={1}>{copy.title}</Heading>
              <Text color="secondary">{copy.consequence(account)}</Text>
              <HStack gap={2}>
                <Button label={copy.confirm(account)} variant="primary" isLoading={busy} onClick={confirm} />
                <Button label={t("auth.useDifferentAccount")} variant="ghost" isDisabled={busy} onClick={logout} />
              </HStack>
              <Text type="supporting" color="secondary">
                {copy.switchHint}
              </Text>
            </>
          )}
        </VStack>
      </Section>
    </AppShell>
  );
}

const WORKSPACE_COPY: LinkCopy = {
  missingToken: t("auth.join.workspace.missingToken"),
  failedTitle: t("auth.join.workspace.failedTitle"),
  failedFallback: t("auth.join.workspace.failedFallback"),
  failedHint: t("auth.join.workspace.failedHint"),
  title: t("auth.join.workspace.title"),
  consequence: (account) =>
    account ? t("auth.join.workspace.consequenceNamed", { account }) : t("auth.join.workspace.consequence"),
  confirm: (account) => (account ? t("auth.join.workspace.confirmNamed", { account }) : t("auth.join.workspace.title")),
  switchHint: t("auth.join.switchHint"),
};

const redeemInvite: Redeem = async (token) => {
  const r = await Workspaces.redeemInvite(token);
  return { workspaceId: r.workspace_id, destination: "/" };
};

/** A new account never sees this page: registration redeems the stashed invite itself. */
export function JoinWorkspace() {
  return <RedeemLinkPage redeem={redeemInvite} copy={WORKSPACE_COPY} />;
}

const DOC_COPY: LinkCopy = {
  missingToken: t("auth.join.doc.missingToken"),
  failedTitle: t("auth.join.doc.failedTitle"),
  failedFallback: t("auth.join.doc.failedFallback"),
  failedHint: t("auth.join.doc.failedHint"),
  title: t("auth.join.doc.title"),
  consequence: (account) => (account ? t("auth.join.doc.consequenceNamed", { account }) : t("auth.join.doc.consequence")),
  confirm: (account) => (account ? t("auth.join.doc.confirmNamed", { account }) : t("auth.join.doc.confirm")),
  switchHint: t("auth.join.switchHint"),
};

const redeemShareLink: Redeem = async (token) => {
  const r = await Docs.redeemShareLink(token);
  // The document may live in a workspace the caller just became a guest of.
  return { workspaceId: r.workspace_id, destination: `/doc/${r.doc_id}` };
};

export function JoinDoc() {
  return <RedeemLinkPage redeem={redeemShareLink} copy={DOC_COPY} />;
}
