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
import { loadAuthConfig } from "../../../lib/session/auth-config";
import { SectionStatusBanners, useSectionStatus } from "./status";
import { StoredSecret } from "./StoredSecret";

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
function lockedOut(withoutPassword: number): string | null {
  if (withoutPassword === 0) return null;
  const who = withoutPassword === 1 ? "1 person has" : `${withoutPassword} people have`;
  return `${who} no password. Anyone still signed in can set one in Profile; the rest need a reset link.`;
}

function removeConsequence(withoutPassword: number): string {
  return lockedOut(withoutPassword) ?? "People sign in with their password only.";
}

/** A different issuer drops every link, as removing the provider does: a subject means nothing under another one. */
function changeConsequence(withoutPassword: number): string {
  return ["Everyone linked to the current provider has to link again.", lockedOut(withoutPassword)].filter(Boolean).join(" ");
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
    try {
      applied(await NodeApi.saveSettings(input), message);
    } catch (e) {
      status.fail(e);
    } finally {
      setBusy("");
    }
  }

  function save() {
    void run("save", providerInput(form, secretRemoved), "Saved — live now, no restart.");
  }

  async function copy(url: string) {
    if (!(await copyText(url))) return;
    setCopied(url);
    setTimeout(() => setCopied((c) => (c === url ? null : c)), 2000);
  }

  return (
    <VStack gap={3}>
      <Heading level={2}>Identity provider</Heading>
      <Text type="supporting" color="secondary">
        Lets people sign in with an outside account as well as a password.
      </Text>
      <SectionStatusBanners status={status} />
      {ip.client_secret_stale && (
        <Banner
          status="warning"
          title="The client secret is missing from this node&apos;s files"
          description="Paste it again to restore sign-in with the provider."
        />
      )}
      <TextInput
        label="Issuer URL"
        value={form.issuer}
        placeholder="https://id.example.com"
        onChange={(v: string) => setForm({ ...form, issuer: v })}
      />
      <TextInput label="Client ID" value={form.clientId} onChange={(v: string) => setForm({ ...form, clientId: v })} />
      <VStack gap={1}>
        <TextInput
          label="Client secret"
          type="password"
          isOptional
          value={form.clientSecret}
          isDisabled={secretRemoved}
          placeholder={ip.client_secret_set ? "Leave blank to keep the one on file" : "None for a public client"}
          onChange={(v: string) => setForm({ ...form, clientSecret: v })}
        />
        <StoredSecret
          onFile={ip.client_secret_set ? `On file · ${ip.client_secret_label ?? "set"}` : null}
          removed={secretRemoved}
          onRemove={() => setSecretRemoved(true)}
          removeLabel="Remove"
          removedNote="It will be removed when you save."
        />
      </VStack>
      <TextInput
        label="Button label"
        isOptional
        value={form.label}
        placeholder={hostOf(form.issuer) ?? ip.default_label ?? ""}
        onChange={(v: string) => setForm({ ...form, label: v })}
      />
      <TextInput
        label="Scopes"
        isOptional
        value={form.scopes}
        placeholder={ip.default_scopes}
        onChange={(v: string) => setForm({ ...form, scopes: v })}
      />
      {ip.callback_urls.length > 0 && (
        <VStack gap={1}>
          <Text size="sm" color="secondary">
            Callback URLs · register each with the provider
          </Text>
          {ip.callback_urls.map((url) => (
            <HStack key={url} gap={2} vAlign="center">
              <Text>{url}</Text>
              <Button label={copied === url ? "Copied" : "Copy"} variant="ghost" size="sm" onClick={() => void copy(url)} />
            </HStack>
          ))}
        </VStack>
      )}
      <HStack gap={2} vAlign="center">
        <Button
          label="Save"
          variant="primary"
          size="sm"
          isDisabled={!form.issuer.trim() || !form.clientId.trim()}
          isLoading={busy === "save"}
          onClick={() => (ip.issuer !== null && !sameIssuer(form.issuer, ip.issuer) ? setConfirmChange(true) : save())}
        />
        {ip.issuer !== null && (
          <Button
            label="Remove provider"
            variant="ghost"
            size="sm"
            isLoading={busy === "remove"}
            onClick={() => setConfirmRemove(true)}
          />
        )}
      </HStack>
      <AlertDialog
        isOpen={confirmRemove}
        title="Remove the identity provider?"
        description={removeConsequence(ip.accounts_without_password)}
        onOpenChange={(open) => !open && setConfirmRemove(false)}
        actionLabel="Remove"
        onAction={() => {
          setConfirmRemove(false);
          void run("remove", { identity_provider: null }, "Identity provider removed.");
        }}
      />
      <AlertDialog
        isOpen={confirmChange}
        title="Change the identity provider?"
        description={changeConsequence(ip.accounts_without_password)}
        onOpenChange={(open) => !open && setConfirmChange(false)}
        actionLabel="Change"
        onAction={() => {
          setConfirmChange(false);
          save();
        }}
      />
    </VStack>
  );
}
