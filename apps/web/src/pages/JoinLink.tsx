/**
 * Landing pages for invite links (/join/:token) and document share links
 * (/s/:token). Redeeming is not undoable from here and binds whichever account
 * this browser is signed in as, so the account is named and the person confirms.
 * An invite link is checked first, so the page names the workspace, the role and
 * who invited, says when the link is dead, and tells a member they are in already.
 * A share link is looked up only by redeeming it, so nothing about its target shows first.
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
import { previewInvite } from "../lib/session/sign-in";
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

/**
 * What a link is before it is used: dead (with why), for a workspace the person is in already, or
 * worth confirming, in words that name what it admits to.
 */
type LinkCheck =
  | { kind: "dead"; message: string }
  | { kind: "member"; workspaceId: string; workspaceName: string }
  | { kind: "live"; title: string; invitation: string };

function RedeemLinkPage({ redeem, copy, check }: { redeem: Redeem; copy: LinkCopy; check?: (token: string) => Promise<LinkCheck | null> }) {
  const { token } = useParams<{ token: string }>();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  /** Whether "/" lands in the library or, for a member of no workspace, in onboarding. */
  const [ownsWorkspace, setOwnsWorkspace] = useState(true);
  /** Undefined while whoami is in flight; null when it failed, which costs the name, not the step. */
  const [account, setAccount] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  /** Undefined while the link is checked; null when there is no check or it failed, which costs the words, not the step. */
  const [checked, setChecked] = useState<LinkCheck | null | undefined>(check ? undefined : null);

  useEffect(() => {
    if (!token || !check) return;
    let alive = true;
    check(token)
      .catch(() => null)
      .then((found) => {
        if (!alive) return;
        if (found?.kind === "dead") {
          setError(found.message);
          labelWayOut();
        }
        setChecked(found);
      });
    return () => {
      alive = false;
    };
  }, [token, check]);

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

  /** Only to label the way out honestly; a failure keeps the default label. */
  function labelWayOut() {
    Workspaces.list()
      .then(({ workspaces }) => setOwnsWorkspace(workspaces.length > 0))
      .catch(() => {});
  }

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
        labelWayOut();
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
          ) : account === undefined || checked === undefined ? (
            <Spinner label={t("auth.join.checkingAccount")} />
          ) : checked?.kind === "member" ? (
            <>
              <Heading level={1}>{t("auth.join.workspace.memberTitle", { workspace: checked.workspaceName })}</Heading>
              <Button
                label={t("auth.join.workspace.open", { workspace: checked.workspaceName })}
                variant="primary"
                onClick={() => {
                  setActiveWorkspace(checked.workspaceId);
                  window.location.assign("/");
                }}
              />
            </>
          ) : (
            <>
              <Heading level={1}>{checked?.kind === "live" ? checked.title : copy.title}</Heading>
              {checked?.kind === "live" && <Text>{checked.invitation}</Text>}
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

/** The invite as its holder may see it, against the workspaces the signed-in account is in already. */
const checkInvite = async (token: string): Promise<LinkCheck> => {
  const [invite, mine] = await Promise.all([previewInvite(token), Workspaces.list().catch(() => null)]);
  if (invite.status === "invalid") return { kind: "dead", message: t("auth.join.workspace.dead") };
  const joined = mine?.workspaces.find((w) => w.workspace_id === invite.workspace_id);
  if (joined) return { kind: "member", workspaceId: joined.workspace_id, workspaceName: joined.name };
  if (invite.status === "local_only") return { kind: "dead", message: t("auth.errors.inviteLocalOnly") };
  const { workspace_name: workspace, role, invited_by: inviter } = invite;
  return {
    kind: "live",
    title: t("auth.join.workspace.titleNamed", { workspace }),
    invitation: inviter ? t("auth.join.workspace.invitedBy", { inviter, role }) : t("auth.join.workspace.invitedAs", { role }),
  };
};

/** A new account never sees this page: registration redeems the stashed invite itself. */
export function JoinWorkspace() {
  return <RedeemLinkPage redeem={redeemInvite} copy={WORKSPACE_COPY} check={checkInvite} />;
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
