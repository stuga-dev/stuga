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
import { formatLocale, t, uiLanguage } from "../../i18n/i18n";
import { tRich } from "../../i18n/rich";

const PROFILE_PATH = "/settings/profile";

/** How a link through the provider came back (?provider=), in words. */
function linkOutcome(outcome: string, provider: string): { body: string; type: "info" | "error" } | null {
  if (outcome === "linked") return { body: t("settings.profile.linked", { provider }), type: "info" };
  if (outcome === "taken") return { body: t("settings.profile.linkTaken", { provider }), type: "error" };
  if (outcome === "failed") return { body: t("settings.profile.linkFailed", { provider }), type: "error" };
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
    const shown = linkOutcome(outcome, label ?? t("settings.profile.identityProvider"));
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
      toast({ body: t("settings.profile.updated"), type: "info" });
    } catch (e) {
      toast({ body: errorMessage(e, t("settings.profile.saveFailed")), type: "error" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <PageColumn>
        <VStack gap={2} hAlign="center" style={{ paddingTop: "20vh" }}>
          <Spinner label={t("common.loading")} />
        </VStack>
      </PageColumn>
    );
  }
  if (failed) {
    return (
      <PageColumn>
        <LoadFailed icon={<UserRound size={28} />} title={t("settings.profile.loadFailed")} onRetry={() => void load()} />
      </PageColumn>
    );
  }

  return (
    <PageColumn>
      <VStack gap={5}>
        <VStack gap={3}>
          <Heading level={2}>{t("settings.profile.heading")}</Heading>
          {/* Previews the unsaved name. */}
          <HStack gap={3} vAlign="center">
            <Avatar name={name || username || t("settings.profile.you")} size="lg" tooltip={false} />
            <Text size="sm" color="secondary">
              {t("settings.profile.avatarNote")}
            </Text>
          </HStack>
          {username && (
            <VStack gap={0}>
              <Text size="sm" color="secondary">{t("common.username")}</Text>
              <Text>@{username}</Text>
              <Text size="sm" color="secondary">
                {t("settings.profile.usernameNote")}
              </Text>
            </VStack>
          )}
          <TextInput label={t("common.name")} value={name} onChange={setName} onEnter={save} />
          <Text size="sm" color="secondary">
            {t("settings.profile.nameNote")}
          </Text>
          <TextInput
            label={t("settings.profile.email")}
            type="email"
            isOptional
            value={email}
            onChange={setEmail}
            onEnter={save}
            description={t("settings.profile.emailNote")}
            {...(emailChanged && emailInvalid ? { status: { type: "error" as const, message: t("settings.profile.emailInvalid") } } : {})}
          />
          <HStack justify="end">
            <Button
              label={t("common.save")}
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
      toast({ body: t("settings.password.chooseAnother", { rules: passwordRulesText(strength.strong) }), type: "error" });
      return;
    }
    setBusy(true);
    try {
      if (hasPassword) {
        // The node ends every other session and answers with this browser's next one.
        setSession(await changePassword(username, current, next));
        toast({ body: t("settings.password.changed"), type: "info" });
      } else {
        await setFirstPassword(next);
        toast({ body: t("settings.password.set"), type: "info" });
        onSet();
      }
      setCurrent("");
      setNext("");
    } catch (err) {
      const wrongCurrent = askCurrent && err instanceof AuthError && err.message === "invalid_credentials";
      toast({ body: wrongCurrent ? t("settings.password.wrongCurrent") : describeError(err), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <VStack gap={3}>
      <Heading level={2}>{t("common.password")}</Heading>
      <Text type="supporting" color="secondary">
        {hasPassword ? t("settings.password.changeNote") : t("settings.password.setNote", { username })}
      </Text>
      {askCurrent && (
        <TextInput
          label={t("settings.password.current")}
          type="password"
          value={current}
          onChange={setCurrent}
          onEnter={() => void submit()}
          htmlName="current-password"
          autoComplete="current-password"
        />
      )}
      <TextInput
        label={t("settings.password.new")}
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
          label={hasPassword ? t("settings.password.change") : t("settings.password.setButton")}
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
      toast({ body: unreachable ? t("settings.provider.unreachable", { provider: label }) : describeError(err), type: "error" });
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    try {
      await unlinkProvider();
      toast({ body: t("settings.provider.unlinked", { provider: label }), type: "info" });
      onUnlinked();
    } catch (err) {
      toast({ body: describeError(err), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <VStack gap={3}>
      <Heading level={2}>{t("settings.provider.heading", { provider: label })}</Heading>
      <Text type="supporting" color="secondary">
        {!linked ? t("settings.provider.notLinked", { provider: label }) : hasPassword ? t("settings.provider.linked") : t("settings.provider.setPasswordFirst")}
      </Text>
      <HStack justify="end">
        {linked ? (
          <Button label={t("settings.provider.unlink")} variant="secondary" isDisabled={!hasPassword} isLoading={busy} onClick={() => void unlink()} />
        ) : (
          <Button label={t("common.link")} variant="secondary" isLoading={busy} onClick={() => void link()} />
        )}
      </HStack>
    </VStack>
  );
}

/** What the dialog says Revoke everything takes, from the node's count. */
export function revokeSummary(counts: RevokeEverythingCounts, provider: string | null): string {
  const links = counts.invites + counts.share_links;
  const parts = [
    counts.passkeys > 0 ? t("settings.revoke.passkeys", { count: counts.passkeys }) : null,
    counts.provider
      ? provider
        ? t("settings.revoke.providerSignIn", { provider })
        : t("settings.revoke.identityProviderSignIn")
      : null,
    counts.apps > 0 ? t("settings.revoke.apps", { count: counts.apps }) : null,
    counts.api_keys > 0 ? t("settings.revoke.apiKeys", { count: counts.api_keys }) : null,
    links > 0 ? t("settings.revoke.links", { count: links }) : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return t("settings.revoke.summaryNone");
  // The app's English lists without a serial comma ("a, b and c"), which en-GB's list format matches.
  const items = new Intl.ListFormat(uiLanguage() === "en" ? "en-GB" : formatLocale(), { type: "conjunction" }).format(parts);
  return t("settings.revoke.summary", { items });
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
      toast({ body: t("settings.password.chooseAnother", { rules: passwordRulesText(strength.strong) }), type: "error" });
      return;
    }
    setBusy(true);
    try {
      setSession(await revokeEverything(next));
      setOpen(false);
      toast({ body: t("settings.revoke.done"), type: "info" });
      onDone();
    } catch (err) {
      toast({ body: describeError(err), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <VStack gap={3}>
      <Heading level={2}>{t("settings.revoke.heading")}</Heading>
      <Text type="supporting" color="secondary">
        {t("settings.revoke.intro")}
      </Text>
      <HStack justify="end">
        <Button label={t("settings.revoke.button")} variant="secondary" onClick={show} />
      </HStack>
      <Dialog isOpen={open} onOpenChange={(o) => !o && !busy && setOpen(false)} purpose="form" width={440}>
        <Layout
          header={<DialogHeader title={t("settings.revoke.button")} onOpenChange={(o) => !o && !busy && setOpen(false)} />}
          content={
            <LayoutContent>
              <VStack gap={3}>
                <Text type="supporting" color="secondary">
                  {counts ? revokeSummary(counts, provider) : t("settings.revoke.summaryNone")}
                </Text>
                <TextInput
                  label={t("settings.password.new")}
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
                <Button label={t("common.cancel")} variant="ghost" onClick={() => setOpen(false)} isDisabled={busy} />
                <Button label={t("settings.revoke.button")} variant="primary" onClick={() => void submit()} isDisabled={!next} isLoading={busy} />
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
      toast({ body: t("settings.passkeys.added", { name: added.name }), type: "info" });
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
      toast({ body: errorMessage(err, t("settings.passkeys.renameFailed")), type: "error" });
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
      toast({ body: t("settings.passkeys.removed", { name: p.name }), type: "info" });
      load();
    } catch (err) {
      toast({ body: errorMessage(err, t("settings.passkeys.removeFailed")), type: "error" });
    } finally {
      setBusy(null);
    }
  }

  const intro =
    passkeys.length > 0
      ? null
      : canAdd
        ? t("settings.passkeys.signInAt", { host })
        : tRich("settings.passkeys.addAt", { host, link: (chunks) => <a href={`${remoteOrigin()}/settings/profile`}>{chunks}</a> });

  return (
    <>
      <Divider />
      <VStack gap={3}>
        <Heading level={2}>{t("settings.passkeys.heading")}</Heading>
        {intro && (
          <Text type="supporting" color="secondary">
            {intro}
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
                        label={t("settings.passkeys.nameLabel")}
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
                    {p.synced && !p.name.startsWith("Synced") && <Badge variant="neutral" label={t("settings.passkeys.synced")} />}
                  </HStack>
                  <Text size="sm" color="secondary">
                    {confirming === p.id ? (
                      p.synced ? (
                        t("settings.passkeys.confirmSynced", { name: p.name })
                      ) : host ? (
                        t("settings.passkeys.confirmAt", { name: p.name, host })
                      ) : (
                        t("settings.passkeys.confirm", { name: p.name })
                      )
                    ) : p.elsewhere ? (
                      t("settings.passkeys.elsewhere")
                    ) : (
                      <>
                        <span title={absoluteTime(p.created_at)}>{t("settings.passkeys.addedAgo", { time: relativeTime(p.created_at) })}</span>
                        {" · "}
                        {p.last_used_at ? (
                          <span title={absoluteTime(p.last_used_at)}>{t("settings.passkeys.lastUsed", { time: relativeTime(p.last_used_at) })}</span>
                        ) : (
                          t("settings.passkeys.neverUsed")
                        )}
                      </>
                    )}
                  </Text>
                </VStack>
                <HStack gap={2} vAlign="center">
                  {confirming === p.id ? (
                    <>
                      <Button label={t("common.cancel")} variant="ghost" size="sm" onClick={() => setConfirming(null)} />
                      <Button label={t("common.remove")} variant="destructive" size="sm" isLoading={busy === p.id} onClick={() => void remove(p)} />
                    </>
                  ) : renaming?.id === p.id ? (
                    <>
                      <Button label={t("common.cancel")} variant="ghost" size="sm" onClick={() => setRenaming(null)} />
                      <Button label={t("common.save")} variant="secondary" size="sm" isLoading={busy === p.id} onClick={() => void rename(p, renaming.name)} />
                    </>
                  ) : (
                    <>
                      <Button label={t("common.rename")} variant="ghost" size="sm" icon={<Pencil size={13} />} onClick={() => setRenaming({ id: p.id, name: p.name })} />
                      <Button label={t("common.remove")} variant="ghost" size="sm" onClick={() => setConfirming(p.id)} />
                    </>
                  )}
                </HStack>
              </li>
            ))}
          </ul>
        )}
        {canAdd && (
          <HStack justify="end">
            <Button label={t("settings.passkeys.add")} variant="secondary" isLoading={busy === "add"} onClick={() => void add()} />
          </HStack>
        )}
      </VStack>
    </>
  );
}
