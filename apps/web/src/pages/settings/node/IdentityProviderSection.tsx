import { useState } from "react";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Banner } from "@astryxdesign/core/Banner";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import {
  NodeSettings as NodeApi,
  type IdentityProviderSettings,
  type NodeOperationalSettings,
  type NodeOperationalSettingsInput,
} from "../../../api";
import { copyText } from "../../../lib/clipboard";
import type { ApiError } from "../../../lib/http/client";
import { loadAuthConfig } from "../../../lib/session/auth-config";
import { SectionStatusBanners, useSectionStatus } from "./status";
import { onFileBadge, StoredSecret } from "./StoredSecret";
import { t, type MessageKey } from "../../../i18n/i18n";

interface ProviderForm {
  issuer: string;
  clientId: string;
  /** Write-only: blank keeps what is on file. */
  clientSecret: string;
  label: string;
  scopes: string;
}

function toForm(ip: IdentityProviderSettings): ProviderForm {
  return { issuer: ip.issuer ?? "", clientId: ip.client_id ?? "", clientSecret: "", label: ip.label ?? "", scopes: ip.scopes ?? "" };
}

/** The whole form, so an emptied label or scopes goes back to the default; the secret only when it changes. */
function providerInput(form: ProviderForm, secretRemoved: boolean): NodeOperationalSettingsInput {
  const secret = secretRemoved ? { client_secret: "" } : form.clientSecret ? { client_secret: form.clientSecret } : {};
  return {
    identity_provider: {
      issuer: form.issuer.trim(),
      client_id: form.clientId.trim(),
      label: form.label.trim(),
      scopes: form.scopes.trim(),
      ...secret,
    },
  };
}

/** Why the node would not take the issuer, by the code its discovery check refused with. */
const DISCOVERY_REFUSALS: Record<string, MessageKey> = {
  provider_discovery_unreachable: "nodeAccess.identity.discovery.unreachable",
  provider_discovery_status: "nodeAccess.identity.discovery.status",
  provider_discovery_invalid: "nodeAccess.identity.discovery.invalid",
  provider_discovery_incomplete: "nodeAccess.identity.discovery.incomplete",
  provider_discovery_issuer: "nodeAccess.identity.discovery.issuer",
  provider_discovery_flow: "nodeAccess.identity.discovery.flow",
  provider_discovery_pkce: "nodeAccess.identity.discovery.pkce",
};

/** What the button says by default: the host of the issuer being typed. */
function hostOf(url: string): string | null {
  try {
    return new URL(url.trim()).host || null;
  } catch {
    return null;
  }
}

/** Compared as the node's discovery check compares: one trailing slash either way is the same issuer. */
function sameIssuer(a: string, b: string): boolean {
  return a.trim().replace(/\/$/, "") === b.trim().replace(/\/$/, "");
}

/**
 * Who loses the only way in when every link to the provider is dropped. Nobody
 * is signed out, so whoever is still signed in can set a password first.
 */
function removeConsequence(withoutPassword: number): string {
  if (withoutPassword === 0) return t("nodeAccess.identity.passwordOnly");
  return t("nodeAccess.identity.lockedOut", { count: withoutPassword });
}

/** A different issuer drops every link, as removing the provider does: a subject means nothing under another one. */
function changeConsequence(withoutPassword: number): string {
  if (withoutPassword === 0) return t("nodeAccess.identity.relink");
  return t("nodeAccess.identity.relinkLockedOut", { count: withoutPassword });
}

/** The one identity provider the sign-in page offers beside passwords. */
export function IdentityProviderSection({
  ops,
  onSaved,
}: {
  ops: NodeOperationalSettings;
  onSaved: (ops: NodeOperationalSettings) => void;
}) {
  const ip = ops.identity_provider;
  const status = useSectionStatus();
  const [form, setForm] = useState<ProviderForm>(() => toForm(ip));
  const [secretRemoved, setSecretRemoved] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "remove">("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmChange, setConfirmChange] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  /** The node's own text under a discovery refusal: the URL or field it is about. */
  const [detail, setDetail] = useState<string | null>(null);

  function applied(res: NodeOperationalSettings, message: string) {
    onSaved(res);
    setForm(toForm(res.identity_provider));
    setSecretRemoved(false);
    status.setNotice({ status: "success", message });
    // The sign-in page and Profile read the button text from the config this tab cached at load.
    void loadAuthConfig();
  }

  async function run(which: "save" | "remove", input: NodeOperationalSettingsInput, message: string) {
    setBusy(which);
    status.clear();
    setDetail(null);
    try {
      applied(await NodeApi.saveSettings(input), message);
    } catch (e) {
      const code = (e as ApiError).code;
      const issuer = input.identity_provider?.issuer;
      if (code && issuer && Object.hasOwn(DISCOVERY_REFUSALS, code)) {
        status.setError(t(DISCOVERY_REFUSALS[code]!, { issuer }));
        setDetail((e as Error).message);
      } else status.fail(e);
    } finally {
      setBusy("");
    }
  }

  function save() {
    void run("save", providerInput(form, secretRemoved), t("common.savedLive"));
  }

  async function copy(url: string) {
    if (!(await copyText(url))) return;
    setCopied(url);
    setTimeout(() => setCopied((c) => (c === url ? null : c)), 2000);
  }

  return (
    <VStack gap={3}>
      <Heading level={2}>{t("nodeAccess.identity.heading")}</Heading>
      <Text type="supporting" color="secondary">
        {t("nodeAccess.identity.intro")}
      </Text>
      <SectionStatusBanners status={status} />
      {status.error && detail && (
        <Text type="supporting" color="secondary">
          {detail}
        </Text>
      )}
      {ip.client_secret_stale && (
        <Banner
          status="warning"
          title={t("nodeAccess.identity.secretStale")}
          description={t("nodeAccess.identity.secretStaleHelp")}
        />
      )}
      <TextInput
        label={t("nodeAccess.identity.issuer")}
        value={form.issuer}
        placeholder="https://id.example.com"
        onChange={(v: string) => setForm({ ...form, issuer: v })}
      />
      <TextInput label={t("nodeAccess.identity.clientId")} value={form.clientId} onChange={(v: string) => setForm({ ...form, clientId: v })} />
      <VStack gap={1}>
        <TextInput
          label={t("nodeAccess.identity.clientSecret")}
          type="password"
          isOptional
          value={form.clientSecret}
          isDisabled={secretRemoved}
          placeholder={ip.client_secret_set ? t("nodeAccess.secret.keepOnFile") : t("nodeAccess.identity.publicClient")}
          onChange={(v: string) => setForm({ ...form, clientSecret: v })}
        />
        <StoredSecret
          onFile={ip.client_secret_set ? onFileBadge(ip.client_secret_label) : null}
          removed={secretRemoved}
          onRemove={() => setSecretRemoved(true)}
          removeLabel={t("common.remove")}
          removedNote={t("nodeAccess.secret.removedNote")}
        />
      </VStack>
      <TextInput
        label={t("nodeAccess.identity.buttonLabel")}
        isOptional
        value={form.label}
        placeholder={hostOf(form.issuer) ?? ip.default_label ?? ""}
        onChange={(v: string) => setForm({ ...form, label: v })}
      />
      <TextInput
        label={t("nodeAccess.identity.scopes")}
        isOptional
        value={form.scopes}
        placeholder={ip.default_scopes}
        onChange={(v: string) => setForm({ ...form, scopes: v })}
      />
      {ip.callback_urls.length > 0 && (
        <VStack gap={1}>
          <Text size="sm" color="secondary">
            {t("nodeAccess.identity.callbackUrls")}
          </Text>
          {ip.callback_urls.map((url) => (
            <HStack key={url} gap={2} vAlign="center">
              <Text>{url}</Text>
              <Button label={copied === url ? t("common.copied") : t("common.copy")} variant="ghost" size="sm" onClick={() => void copy(url)} />
            </HStack>
          ))}
        </VStack>
      )}
      <HStack gap={2} vAlign="center">
        <Button
          label={t("common.save")}
          variant="primary"
          size="sm"
          isDisabled={!form.issuer.trim() || !form.clientId.trim()}
          isLoading={busy === "save"}
          onClick={() => (ip.issuer !== null && !sameIssuer(form.issuer, ip.issuer) ? setConfirmChange(true) : save())}
        />
        {ip.issuer !== null && (
          <Button
            label={t("nodeAccess.identity.removeProvider")}
            variant="ghost"
            size="sm"
            isLoading={busy === "remove"}
            onClick={() => setConfirmRemove(true)}
          />
        )}
      </HStack>
      <AlertDialog
        isOpen={confirmRemove}
        title={t("nodeAccess.identity.confirmRemove")}
        description={removeConsequence(ip.accounts_without_password)}
        onOpenChange={(open) => !open && setConfirmRemove(false)}
        actionLabel={t("common.remove")}
        onAction={() => {
          setConfirmRemove(false);
          void run("remove", { identity_provider: null }, t("nodeAccess.identity.removed"));
        }}
      />
      <AlertDialog
        isOpen={confirmChange}
        title={t("nodeAccess.identity.confirmChange")}
        description={changeConsequence(ip.accounts_without_password)}
        onOpenChange={(open) => !open && setConfirmChange(false)}
        actionLabel={t("nodeAccess.identity.change")}
        onAction={() => {
          setConfirmChange(false);
          save();
        }}
      />
    </VStack>
  );
}
