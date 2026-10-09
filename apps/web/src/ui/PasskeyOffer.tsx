/**
 * "Sign in faster next time": asked once, after a password sign-in at the remote address
 * (lib/session/passkey-offer.ts). Add passkey adds one at once (the sign-in has just confirmed the
 * session); Not now, or closing it, is remembered on the account, on every device. Mounted once.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { Me } from "../api";
import { t } from "../i18n/i18n";
import { remoteOrigin } from "../lib/session/auth-config";
import { describeError } from "../lib/session/errors";
import { PasskeyCancelled, addPasskey } from "../lib/session/passkey";
import { clearPasskeyOffer, onPasskeyOffer, passkeyOfferDue } from "../lib/session/passkey-offer";
import { withConfirmation } from "../lib/session/reauth";

export function PasskeyOffer() {
  const toast = useToast();
  const [open, setOpen] = useState(passkeyOfferDue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => onPasskeyOffer(() => setOpen(true)), []);

  function close() {
    clearPasskeyOffer();
    setOpen(false);
    setBusy(false);
    setError(null);
  }

  function notNow() {
    if (busy) return;
    // Remembered on the account: asked once, on any device.
    void Me.dismissPasskeyOffer().catch(() => {});
    close();
  }

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const added = await withConfirmation(addPasskey);
      close();
      toast({ body: t("ui.passkeyOffer.added", { name: added.name }), type: "info" });
    } catch (err) {
      setError(err instanceof PasskeyCancelled ? err.message : describeError(err));
      setBusy(false);
    }
  }

  const host = (() => {
    const origin = remoteOrigin() ?? window.location.origin;
    return URL.parse(origin)?.host ?? origin;
  })();

  return (
    <Dialog isOpen={open} onOpenChange={(next) => !next && notNow()} purpose="form" width={420}>
      <Layout
        header={<DialogHeader title={t("ui.passkeyOffer.title")} onOpenChange={(next) => !next && notNow()} />}
        content={
          <LayoutContent>
            <Text type="supporting" color="secondary">
              {t("ui.passkeyOffer.body", { host })}
            </Text>
            {error && <Banner status="error" title={error} />}
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} justify="end">
              <Button label={t("ui.passkeyOffer.notNow")} variant="ghost" onClick={notNow} isDisabled={busy} />
              <Button label={t("ui.passkeyOffer.add")} variant="primary" onClick={() => void add()} isLoading={busy} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
