/**
 * How the caller appears to collaborators and how to reach them, and how they
 * sign in: the username is fixed, the email is optional and editable, a
 * password can be set or changed, and the node's identity provider, when it
 * has one, can be linked or unlinked. Passkeys are added at the remote address
 * and listed, renamed and removed at either. Revoke everything takes every way
 * in back at once; an alert about a sign-in opens it here (?revoke=1).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { Pencil, UserRound } from "lucide-react";
import { isEmailShaped } from "@stuga/protocol/domain/username";
import { LoadFailed } from "../../ui/LoadFailed";
import { useSettingsScope } from "./SettingsLayout";
import { PageColumn } from "../../ui/PageColumn";
import { Me, type PasskeySummary, type RevokeEverythingCounts } from "../../api";
import { absoluteTime, relativeTime } from "../../lib/format";
import { PasskeyCancelled, addPasskey, passkeysOffered } from "../../lib/session/passkey";
import { withConfirmation } from "../../lib/session/reauth";
import { logout } from "../../lib/session/tokens";
import { errorMessage } from "../../lib/http/client";
import { atRemoteAddress, providerLabel, remoteOrigin } from "../../lib/session/auth-config";
import { AuthError, describeError } from "../../lib/session/errors";
import { clearLinkPending } from "../../lib/session/provider";
import {
  changePassword,
  linkProvider,
  passwordOk,
  passwordRulesText,
  revokeEverything,
  setFirstPassword,
  unlinkProvider,
} from "../../lib/session/sign-in";
import { setSession } from "../../lib/session/tokens";
import { usePageRestored } from "../../lib/use-page-restored";
import { useRemoteStrength } from "../../lib/session/password-strength";
import { PasswordStrengthHint } from "../../ui/PasswordStrengthHint";

const PROFILE_PATH = "/settings/profile";

/** How a link through the provider came back (?provider=), in words. */
function linkOutcome(outcome: string, label: string): { body: string; type: "info" | "error" } | null {
  if (outcome === "linked") return { body: `Linked to ${label}.`, type: "info" };
  if (outcome === "taken") return { body: `That ${label} account is already linked to another account here.`, type: "error" };
  if (outcome === "failed") return { body: `Couldn’t link ${label}. Try again.`, type: "error" };
  return null;
}

export function Profile() {
  const toast = useToast();
  const scope = useSettingsScope();
  const nav = useNavigate();
  const { search } = useLocation();
  const label = providerLabel();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [savedEmail, setSavedEmail] = useState("");
  const [email, setEmail] = useState("");
  const [savedName, setSavedName] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);
  const [linked, setLinked] = useState(false);
  /** StrictMode runs effects twice; the outcome of a link is announced once. */
  const outcomeShown = useRef(false);

  const load = useCallback(async () => {
    setFailed(false);
    setLoading(true);
    try {
      const me = await Me.whoami();
      setSavedName(me.display_name ?? "");
      setName(me.display_name ?? "");
      setUsername(me.username ?? null);
      setSavedEmail(me.email ?? "");
      setEmail(me.email ?? "");
      setHasPassword(me.has_password === true);
      setLinked(me.provider_linked === true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  /** After a credential changes: the sign-in facts only, without the page's spinner. */
  const reloadSignIn = useCallback(async () => {
    const me = await Me.whoami();
    setHasPassword(me.has_password === true);
    setLinked(me.provider_linked === true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A link this tab left for is over by the time Profile opens again: it came back with ?provider=, or never will.
  useEffect(() => clearLinkPending(), []);

  useEffect(() => {
    const outcome = new URLSearchParams(search).get("provider");
    if (!outcome || outcomeShown.current) return;
    outcomeShown.current = true;
    const shown = linkOutcome(outcome, label ?? "the identity provider");
    if (shown) toast(shown);
    // Out of the address bar, so a reload does not announce it again.
    nav(PROFILE_PATH, { replace: true });
  }, [search, label, toast, nav]);

  const nameChanged = name.trim() !== savedName.trim();
  const emailChanged = email.trim() !== savedEmail.trim();
  const emailInvalid = email.trim() !== "" && !isEmailShaped(email.trim());

  async function save() {
    if (emailChanged && emailInvalid) return;
    setSaving(true);
    try {
      if (nameChanged) {
        const { display_name } = await Me.setDisplayName(name);
        setSavedName(display_name);
        setName(display_name);
        void scope.reload();
      }
      if (emailChanged) {
        const { email: stored } = await Me.setEmail(email.trim());
        setSavedEmail(stored ?? "");
        setEmail(stored ?? "");
      }
      toast({ body: "Profile updated.", type: "info" });
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn’t save your profile."), type: "error" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <PageColumn>
        <VStack gap={2} hAlign="center" style={{ paddingTop: "20vh" }}>
          <Spinner label="Loading…" />
        </VStack>
      </PageColumn>
    );
  }
  if (failed) {
    return (
      <PageColumn>
        <LoadFailed icon={<UserRound size={28} />} title="Couldn’t load your profile" onRetry={() => void load()} />
      </PageColumn>
    );
  }

  return (
    <PageColumn>
      <VStack gap={5}>
        <VStack gap={3}>
          <Heading level={2}>Profile</Heading>
          {/* Previews the unsaved name. */}
          <HStack gap={3} vAlign="center">
            <Avatar name={name || username || "You"} size="lg" tooltip={false} />
            <Text size="sm" color="secondary">
              Generated from your name.
            </Text>
          </HStack>
          {username && (
            <VStack gap={0}>
              <Text size="sm" color="secondary">Username</Text>
              <Text>@{username}</Text>
              <Text size="sm" color="secondary">
                Used to sign in and find you. It can’t be changed.
              </Text>
            </VStack>
          )}
          <TextInput label="Name" value={name} onChange={setName} onEnter={save} />
          <Text size="sm" color="secondary">
            Shown to collaborators.
          </Text>
          <TextInput
            label="Email"
            type="email"
            isOptional
            value={email}
            onChange={setEmail}
            onEnter={save}
            description="Notifications only. Not verified or used to sign in."
            {...(emailChanged && emailInvalid ? { status: { type: "error" as const, message: "Enter an email address, or leave it empty." } } : {})}
          />
          <HStack justify="end">
            <Button
              label="Save"
              variant="primary"
              isDisabled={!(nameChanged || emailChanged) || (emailChanged && emailInvalid)}
              isLoading={saving}
              onClick={save}
            />
          </HStack>
        </VStack>

        {username && (
          <>
            <Divider />
            <PasswordSection username={username} hasPassword={hasPassword} onSet={() => void reloadSignIn().catch(() => {})} />
          </>
        )}

        <PasskeysSection />

        {username && (
          <>
            <Divider />
            <RevokeEverythingSection username={username} onDone={() => void reloadSignIn().catch(() => {})} />
          </>
        )}

        {label && (
          <>
            <Divider />
            <ProviderSection
              label={label}
              linked={linked}
              hasPassword={hasPassword}
              onUnlinked={() => void reloadSignIn().catch(() => {})}
            />
          </>
        )}
      </VStack>
    </PageColumn>
  );
}

/**
 * Set a first password (the session is the proof), or change one (the current password is, on the
 * node's own network; at the remote address a recently confirmed session is, as for a first one).
 */
function PasswordSection({ username, hasPassword, onSet }: { username: string; hasPassword: boolean; onSet: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const strength = useRemoteStrength(next, { username });
  const askCurrent = hasPassword && !atRemoteAddress();
  /** The button's condition, which Enter in either field goes through too. */
  const filled = next !== "" && (!askCurrent || current !== "");

  async function submit() {
    if (!filled || busy) return;
    if (!passwordOk(next, strength.strong)) {
      toast({ body: `Choose another password. ${passwordRulesText(strength.strong)}`, type: "error" });
      return;
    }
    setBusy(true);
    try {
      if (hasPassword) {
        // The node ends every other session and answers with this browser's next one.
        setSession(await changePassword(username, current, next));
        toast({ body: "Password changed. You’re signed out everywhere else.", type: "info" });
      } else {
        await setFirstPassword(next);
        toast({ body: "Password set.", type: "info" });
        onSet();
      }
      setCurrent("");
      setNext("");
    } catch (err) {
      const wrongCurrent = askCurrent && err instanceof AuthError && err.message === "invalid_credentials";
      toast({ body: wrongCurrent ? "That isn’t your current password." : describeError(err), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <VStack gap={3}>
      <Heading level={2}>Password</Heading>
      <Text type="supporting" color="secondary">
        {hasPassword ? "Changing it signs you out everywhere else." : `Lets you sign in with @${username} and a password.`}
      </Text>
      {askCurrent && (
        <TextInput
          label="Current password"
          type="password"
          value={current}
          onChange={setCurrent}
          onEnter={() => void submit()}
          htmlName="current-password"
          autoComplete="current-password"
        />
      )}
      <TextInput
        label="New password"
        type="password"
        value={next}
        onChange={setNext}
        onEnter={() => void submit()}
        htmlName="new-password"
        autoComplete="new-password"
        description={passwordRulesText(strength.strong)}
      />
      <PasswordStrengthHint password={next} strength={strength} />
      <HStack justify="end">
        <Button
          label={hasPassword ? "Change password" : "Set password"}
          variant="secondary"
          isDisabled={!filled}
          isLoading={busy}
          onClick={() => void submit()}
        />
      </HStack>
    </VStack>
  );
}

/** Link the node's identity provider to this account, or unlink it while a password remains to sign in with. */
function ProviderSection({
  label,
  linked,
  hasPassword,
  onUnlinked,
}: {
  label: string;
  linked: boolean;
  hasPassword: boolean;
  onUnlinked: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  // Back from the provider without finishing: the link is abandoned, and the button usable again.
  usePageRestored(
    useCallback(() => {
      clearLinkPending();
      setBusy(false);
    }, []),
  );

  async function link() {
    setBusy(true);
    try {
      // Leaves the page; it comes back here with ?provider=.
      await linkProvider(PROFILE_PATH);
    } catch (err) {
      // The sign-in page's wording offers a password instead, which someone signed in has no use for.
      const unreachable = err instanceof AuthError && err.message === "provider_unreachable";
      toast({ body: unreachable ? `Couldn’t reach ${label}. Try again shortly.` : describeError(err), type: "error" });
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    try {
      await unlinkProvider();
      toast({ body: `Unlinked ${label}.`, type: "info" });
      onUnlinked();
    } catch (err) {
      toast({ body: describeError(err), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <VStack gap={3}>
      <Heading level={2}>{`Sign-in with ${label}`}</Heading>
      <Text type="supporting" color="secondary">
        {!linked ? `Sign in here with your ${label} account.` : hasPassword ? "Linked." : "Set a password first."}
      </Text>
      <HStack justify="end">
        {linked ? (
          <Button label="Unlink" variant="secondary" isDisabled={!hasPassword} isLoading={busy} onClick={() => void unlink()} />
        ) : (
          <Button label="Link" variant="secondary" isLoading={busy} onClick={() => void link()} />
        )}
      </HStack>
    </VStack>
  );
}

/** "a thing", "{n} things", or nothing for none. */
function counted(n: number, one: string, many: string): string | null {
  return n === 0 ? null : n === 1 ? `a ${one}` : `${n} ${many}`;
}

/** "a, b and c". */
function listed(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** What the dialog says Revoke everything takes, from the node's count. */
export function revokeSummary(counts: RevokeEverythingCounts, provider: string | null): string {
  const parts = [
    counted(counts.passkeys, "passkey", "passkeys"),
    counts.provider ? `${provider ?? "identity provider"} sign-in` : null,
    counted(counts.apps, "connected app", "connected apps"),
    counts.api_keys === 1 ? "an API key" : counted(counts.api_keys, "API key", "API keys"),
    counted(counts.invites + counts.share_links, "link you shared", "links you shared"),
  ].filter((p): p is string => p !== null);
  return `Signs you out everywhere${parts.length > 0 ? ` and removes ${listed(parts)}` : ""}. Choose a new password to sign in with.`;
}

/**
 * Revoke everything: every session ends, every other way in goes, and the new password chosen here is
 * the only way back. The node asks for a recent confirmation first.
 */
function RevokeEverythingSection({ username, onDone }: { username: string; onDone: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const { search } = useLocation();
  const provider = providerLabel();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<RevokeEverythingCounts | null>(null);
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const strength = useRemoteStrength(next, { username });

  const show = useCallback(() => {
    setNext("");
    setCounts(null);
    setOpen(true);
    Me.revokeEverythingCounts()
      .then(setCounts)
      .catch(() => setCounts(null));
  }, []);

  // An alert's link lands here with ?revoke=1: open the dialog, once.
  useEffect(() => {
    if (new URLSearchParams(search).get("revoke") !== "1") return;
    nav(PROFILE_PATH, { replace: true });
    show();
  }, [search, nav, show]);

  async function submit() {
    if (!next || busy) return;
    if (!passwordOk(next, strength.strong)) {
      toast({ body: `Choose another password. ${passwordRulesText(strength.strong)}`, type: "error" });
      return;
    }
    setBusy(true);
    try {
      setSession(await revokeEverything(next));
      setOpen(false);
      toast({ body: "Everything was revoked. You’re signed in here with your new password.", type: "info" });
      onDone();
    } catch (err) {
      toast({ body: describeError(err), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <VStack gap={3}>
      <Heading level={2}>Security</Heading>
      <Text type="supporting" color="secondary">
        If something looks wrong, sign out everywhere and start again with a new password.
      </Text>
      <HStack justify="end">
        <Button label="Revoke everything" variant="secondary" onClick={show} />
      </HStack>
      <Dialog isOpen={open} onOpenChange={(o) => !o && !busy && setOpen(false)} purpose="form" width={440}>
        <Layout
          header={<DialogHeader title="Revoke everything" onOpenChange={(o) => !o && !busy && setOpen(false)} />}
          content={
            <LayoutContent>
              <VStack gap={3}>
                <Text type="supporting" color="secondary">
                  {counts ? revokeSummary(counts, provider) : "Signs you out everywhere. Choose a new password to sign in with."}
                </Text>
                <TextInput
                  label="New password"
                  type="password"
                  value={next}
                  onChange={setNext}
                  onEnter={() => void submit()}
                  htmlName="new-password"
                  autoComplete="new-password"
                  description={passwordRulesText(strength.strong)}
                />
                <PasswordStrengthHint password={next} strength={strength} />
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} justify="end">
                <Button label="Cancel" variant="ghost" onClick={() => setOpen(false)} isDisabled={busy} />
                <Button label="Revoke everything" variant="primary" onClick={() => void submit()} isDisabled={!next} isLoading={busy} />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </VStack>
  );
}

/** The remote address's host, as a person reads it: k7f3q2.mystuga.com. */
function remoteHost(): string | null {
  const origin = remoteOrigin();
  return origin ? (URL.parse(origin)?.host ?? origin) : null;
}

/**
 * Passkeys: added at the remote address only, where they sign in; listed, renamed and removed at
 * either. Shown while remote access is on, or while the person has one.
 */
function PasskeysSection() {
  const toast = useToast();
  const [passkeys, setPasskeys] = useState<PasskeySummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const host = remoteHost();
  const canAdd = passkeysOffered();

  const load = useCallback(() => {
    Me.passkeys()
      .then(setPasskeys)
      .catch(() => setPasskeys([]));
  }, []);
  useEffect(load, [load]);

  if (passkeys === null) return null;
  if (host === null && passkeys.length === 0) return null;

  async function add() {
    setBusy("add");
    try {
      const added = await withConfirmation(addPasskey);
      toast({ body: `Passkey added: ${added.name}.`, type: "info" });
      load();
    } catch (err) {
      toast({ body: err instanceof PasskeyCancelled ? err.message : describeError(err), type: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function rename(p: PasskeySummary, name: string) {
    if (!name.trim() || name.trim() === p.name) {
      setRenaming(null);
      return;
    }
    setBusy(p.id);
    try {
      await Me.renamePasskey(p.id, name.trim());
      setRenaming(null);
      load();
    } catch (err) {
      toast({ body: errorMessage(err, "Couldn’t rename that passkey."), type: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function remove(p: PasskeySummary) {
    setBusy(p.id);
    try {
      const { signed_out } = await Me.removePasskey(p.id);
      // This very sign-in was made with it, and ended with it.
      if (signed_out) {
        logout();
        return;
      }
      setConfirming(null);
      toast({ body: `Removed ${p.name}.`, type: "info" });
      load();
    } catch (err) {
      toast({ body: errorMessage(err, "Couldn’t remove that passkey."), type: "error" });
    } finally {
      setBusy(null);
    }
  }

  const intro =
    passkeys.length > 0
      ? null
      : canAdd
        ? `Sign in at ${host} with your face, fingerprint or screen lock.`
        : `Add one at ${host}.`;

  return (
    <>
      <Divider />
      <VStack gap={3}>
        <Heading level={2}>Passkeys</Heading>
        {intro && (
          <Text type="supporting" color="secondary">
            {canAdd || !host ? intro : (
              <>
                Add one at <a href={`${remoteOrigin()}/settings/profile`}>{host}</a>.
              </>
            )}
          </Text>
        )}
        {passkeys.length > 0 && (
          <ul className="member-list">
            {passkeys.map((p) => (
              <li key={p.id} className="member-row">
                <VStack gap={0}>
                  <HStack gap={2} vAlign="center">
                    {renaming?.id === p.id ? (
                      <TextInput
                        label="Passkey name"
                        isLabelHidden
                        size="sm"
                        value={renaming.name}
                        onChange={(v: string) => setRenaming({ id: p.id, name: v })}
                        onEnter={() => void rename(p, renaming.name)}
                      />
                    ) : (
                      <Text>{p.name}</Text>
                    )}
                    {/* A name such as "Synced · Chrome" says it already. */}
                    {p.synced && !p.name.startsWith("Synced") && <Badge variant="neutral" label="Synced" />}
                  </HStack>
                  <Text size="sm" color="secondary">
                    {confirming === p.id ? (
                      p.synced ? (
                        `Remove ${p.name}? It is signed out on every device that shares it.`
                      ) : (
                        `Remove ${p.name}? Anyone signed in with it${host ? ` at ${host}` : ""} is signed out.`
                      )
                    ) : p.elsewhere ? (
                      "Made for an earlier remote address. It signs in nowhere now."
                    ) : (
                      <>
                        <span title={absoluteTime(p.created_at)}>Added {relativeTime(p.created_at)}</span>
                        {" · "}
                        {p.last_used_at ? <span title={absoluteTime(p.last_used_at)}>Last used {relativeTime(p.last_used_at)}</span> : "Never used"}
                      </>
                    )}
                  </Text>
                </VStack>
                <HStack gap={2} vAlign="center">
                  {confirming === p.id ? (
                    <>
                      <Button label="Cancel" variant="ghost" size="sm" onClick={() => setConfirming(null)} />
                      <Button label="Remove" variant="destructive" size="sm" isLoading={busy === p.id} onClick={() => void remove(p)} />
                    </>
                  ) : renaming?.id === p.id ? (
                    <>
                      <Button label="Cancel" variant="ghost" size="sm" onClick={() => setRenaming(null)} />
                      <Button label="Save" variant="secondary" size="sm" isLoading={busy === p.id} onClick={() => void rename(p, renaming.name)} />
                    </>
                  ) : (
                    <>
                      <Button label="Rename" variant="ghost" size="sm" icon={<Pencil size={13} />} onClick={() => setRenaming({ id: p.id, name: p.name })} />
                      <Button label="Remove" variant="ghost" size="sm" onClick={() => setConfirming(p.id)} />
                    </>
                  )}
                </HStack>
              </li>
            ))}
          </ul>
        )}
        {canAdd && (
          <HStack justify="end">
            <Button label="Add a passkey" variant="secondary" isLoading={busy === "add"} onClick={() => void add()} />
          </HStack>
        )}
      </VStack>
    </>
  );
}
