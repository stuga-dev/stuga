/**
 * "Confirm it's you": asked when the node wants a recent confirmation before a change that hands out
 * a way in (lib/session/reauth.ts). With a password, the change goes ahead as soon as it is
 * confirmed. Through the identity provider the page leaves and comes back with ?reauth=, and the
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
import { providerLabel } from "../lib/session/auth-config";
import { AuthError, describeError } from "../lib/session/errors";
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

  useEffect(
    () =>
      setConfirmer(
        (methods) =>
          new Promise<boolean>((resolve) => {
            setPassword("");
            setError(null);
            setAsking({ methods, resolve });
          }),
      ),
    [],
  );

  useEffect(() => {
    const outcome = takeProviderOutcome();
    if (outcome === "confirmed") toast({ body: "Confirmed. Try that again.", type: "info" });
    else if (outcome === "failed") toast({ body: `Couldn’t confirm with ${providerLabel() ?? "the identity provider"}. Try again.`, type: "error" });
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
      setError(err instanceof AuthError && err.message === "invalid_credentials" ? "That isn’t your password." : describeError(err));
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
  const byPassword = methods.includes("password");
  const label = providerLabel();
  const byProvider = methods.includes("provider") && label !== null;

  return (
    <Dialog isOpen={asking !== null} onOpenChange={(open) => !open && !busy && finish(false)} purpose="form" width={400}>
      <Layout
        header={<DialogHeader title="Confirm it’s you" onOpenChange={(open) => !open && !busy && finish(false)} />}
        content={
          <LayoutContent>
            <VStack gap={3}>
              {byPassword ? (
                <>
                  <Text type="supporting" color="secondary">
                    Enter your password to continue.
                  </Text>
                  <TextInput
                    label="Password"
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
                <Text type="supporting" color="secondary">{`Sign in with ${label} again to continue.`}</Text>
              ) : (
                <Text type="supporting" color="secondary">
                  Sign out and sign in again to continue.
                </Text>
              )}
              {!byPassword && error && <Banner status="error" title={error} />}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label="Cancel" variant="ghost" onClick={() => finish(false)} isDisabled={busy} />
              {byPassword && byProvider && (
                <Button label={`Use ${label}`} variant="secondary" onClick={() => void withProvider()} isDisabled={busy} />
              )}
              {byPassword ? (
                <Button label="Continue" variant="primary" onClick={() => void withPassword()} isDisabled={!password} isLoading={busy} />
              ) : byProvider ? (
                <Button label={`Continue with ${label}`} variant="primary" onClick={() => void withProvider()} isLoading={busy} />
              ) : null}
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
