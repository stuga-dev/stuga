/**
 * "Confirm it's you": asked when the node wants a recent confirmation before a change that hands out
 * a way in (lib/session/reauth.ts). With a passkey (at the remote address, for someone who has one
 * there) or a password, the change goes ahead as soon as it is confirmed. Through the identity provider the page leaves and comes back with ?reauth=, and the
 * change is made again from there. Mounted once, for the whole app.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useToast } from "@astryxdesign/core/Toast";
import { t } from "../i18n/i18n";
import { providerLabel } from "../lib/session/auth-config";
import { AuthError, describeError } from "../lib/session/errors";
import { PasskeyCancelled, confirmWithPasskey, passkeysOffered } from "../lib/session/passkey";
import { setConfirmer, type ConfirmMethod } from "../lib/session/reauth";
import { confirmWithPassword, confirmWithProvider } from "../lib/session/sign-in";

interface Asking {
  methods: ConfirmMethod[];
  resolve: (confirmed: boolean) => void;
}

/** The outcome a confirmation through the provider came back with, read once from the address bar. */
function takeProviderOutcome(): string | null {
  const url = new URL(window.location.href);
  const outcome = url.searchParams.get("reauth");
  if (!outcome) return null;
  url.searchParams.delete("reauth");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  return outcome;
}

export function ConfirmIdentity() {
  const toast = useToast();
  const [asking, setAsking] = useState<Asking | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Typing the password instead of using the passkey this person has. */
  const [usePassword, setUsePassword] = useState(false);

  useEffect(
    () =>
      setConfirmer(
        (methods) =>
          new Promise<boolean>((resolve) => {
            setPassword("");
            setError(null);
            setUsePassword(false);
            setAsking({ methods, resolve });
          }),
      ),
    [],
  );

  useEffect(() => {
    const outcome = takeProviderOutcome();
    if (outcome === "confirmed") toast({ body: t("ui.confirmIdentity.confirmed"), type: "info" });
    else if (outcome === "failed") {
      const provider = providerLabel();
      toast({
        body: provider === null ? t("ui.confirmIdentity.providerFailedUnnamed") : t("ui.confirmIdentity.providerFailed", { provider }),
        type: "error",
      });
    }
  }, [toast]);

  function finish(confirmed: boolean) {
    asking?.resolve(confirmed);
    setAsking(null);
    setBusy(false);
  }

  async function withPassword() {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await confirmWithPassword(password);
      finish(true);
    } catch (err) {
      setError(err instanceof AuthError && err.message === "invalid_credentials" ? t("ui.confirmIdentity.wrongPassword") : describeError(err));
      setBusy(false);
    }
  }

  async function withPasskey() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await confirmWithPasskey();
      finish(true);
    } catch (err) {
      setError(err instanceof PasskeyCancelled ? err.message : describeError(err));
      setBusy(false);
    }
  }

  async function withProvider() {
    setBusy(true);
    try {
      // Leaves the page; it comes back here with ?reauth=.
      await confirmWithProvider(window.location.pathname + window.location.search);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  const methods = asking?.methods ?? [];
  const passkeyOffered = methods.includes("passkey") && passkeysOffered();
  const byPasskey = passkeyOffered && !usePassword;
  const byPassword = methods.includes("password") && !byPasskey;
  const label = providerLabel();
  const byProvider = methods.includes("provider") && label !== null;

  return (
    <Dialog isOpen={asking !== null} onOpenChange={(open) => !open && !busy && finish(false)} purpose="form" width={400}>
      <Layout
        header={<DialogHeader title={t("ui.confirmIdentity.title")} onOpenChange={(open) => !open && !busy && finish(false)} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              {byPasskey ? (
                <Text type="supporting" color="secondary">
                  {t("ui.confirmIdentity.byPasskey")}
                </Text>
              ) : byPassword ? (
                <>
                  <Text type="supporting" color="secondary">
                    {t("ui.confirmIdentity.byPassword")}
                  </Text>
                  <TextInput
                    label={t("common.password")}
                    type="password"
                    value={password}
                    onChange={setPassword}
                    onEnter={() => void withPassword()}
                    htmlName="current-password"
                    autoComplete="current-password"
                    {...(error ? { status: { type: "error" as const, message: error } } : {})}
                  />
                </>
              ) : byProvider ? (
                <Text type="supporting" color="secondary">{t("ui.confirmIdentity.byProvider", { provider: label })}</Text>
              ) : (
                <Text type="supporting" color="secondary">
                  {t("ui.confirmIdentity.signInAgain")}
                </Text>
              )}
              {!byPassword && error && <Banner status="error" title={error} />}
              {byPasskey && methods.includes("password") && (
                <Button label={t("ui.confirmIdentity.usePassword")} variant="ghost" size="sm" onClick={() => setUsePassword(true)} isDisabled={busy} />
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label={t("common.cancel")} variant="ghost" onClick={() => finish(false)} isDisabled={busy} />
              {(byPassword || byPasskey) && byProvider && (
                <Button label={t("ui.confirmIdentity.useProvider", { provider: label })} variant="secondary" onClick={() => void withProvider()} isDisabled={busy} />
              )}
              {byPasskey ? (
                <Button label={t("ui.confirmIdentity.continue")} variant="primary" onClick={() => void withPasskey()} isLoading={busy} />
              ) : byPassword ? (
                <Button label={t("ui.confirmIdentity.continue")} variant="primary" onClick={() => void withPassword()} isDisabled={!password} isLoading={busy} />
              ) : byProvider ? (
                <Button label={t("ui.confirmIdentity.continueWithProvider", { provider: label })} variant="primary" onClick={() => void withProvider()} isLoading={busy} />
              ) : null}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
