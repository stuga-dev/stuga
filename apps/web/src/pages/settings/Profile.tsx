/**
 * How the caller appears to collaborators and how to reach them, and how they
 * sign in: the username is fixed, the email is optional and editable, a
 * password can be set or changed, and the node's identity provider, when it
 * has one, can be linked or unlinked.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { UserRound } from "lucide-react";
import { isEmailShaped } from "@stuga/protocol/domain/username";
import { LoadFailed } from "../../ui/LoadFailed";
import { useSettingsScope } from "./SettingsLayout";
import { PageColumn } from "../../ui/PageColumn";
import { Me } from "../../api";
import { errorMessage } from "../../lib/http/client";
import { providerLabel } from "../../lib/session/auth-config";
import { AuthError, describeError } from "../../lib/session/errors";
import { clearLinkPending } from "../../lib/session/provider";
import {
  changePassword,
  linkProvider,
  passwordOk,
  passwordRulesText,
  setFirstPassword,
  unlinkProvider,
} from "../../lib/session/sign-in";
import { setSession } from "../../lib/session/tokens";
import { usePageRestored } from "../../lib/use-page-restored";

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

/** Set a first password (the session is the proof), or change one (the current password is). */
function PasswordSection({ username, hasPassword, onSet }: { username: string; hasPassword: boolean; onSet: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  /** The button's condition, which Enter in either field goes through too. */
  const filled = next !== "" && (!hasPassword || current !== "");

  async function submit() {
    if (!filled || busy) return;
    if (!passwordOk(next)) {
      toast({ body: `Choose another password. ${passwordRulesText()}`, type: "error" });
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
      const wrongCurrent = hasPassword && err instanceof AuthError && err.status === 401;
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
      {hasPassword && (
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
        description={passwordRulesText()}
      />
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
