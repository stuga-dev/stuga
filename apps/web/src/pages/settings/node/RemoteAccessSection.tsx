/**
 * Remote access: this node at its own https address, reachable from anywhere through a relay that
 * forwards the encrypted bytes (docs/remote-access.md). The node does the work; this page turns it
 * on and off and says where it stands. The rail lists it only where the packaging offers it.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack } from "@astryxdesign/core/HStack";
import { Link } from "@astryxdesign/core/Link";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { Globe } from "lucide-react";
import type { ConnectorStatus, RemoteAccessStatus, RemoteError, RemoteErrorCode } from "@stuga/protocol/api/remote-access";
import { NodeSettings as NodeApi } from "../../../api";
import { copyText } from "../../../lib/clipboard";
import { shortDate, timeOfDay, versionLabel } from "../../../lib/format";
import { errorMessage } from "../../../lib/http/client";
import { readStored, writeStored } from "../../../lib/storage";
import { LoadFailed } from "../../../ui/LoadFailed";
import { SectionStatusBanners, useSectionStatus } from "./status";

type Status = Extract<RemoteAccessStatus, { available: true }>;

/** Where the agreement lives until the node's certificate account names the version it took. */
const CA_TERMS_URL = "https://letsencrypt.org/repository/";

/** How soon the page asks again: often while it starts, now and then once it runs. */
const POLL_STARTING_MS = 3000;
const POLL_MS = 30_000;

/** The connector settings this browser last saw, so a later change is pointed out; a per-viewer convenience. */
const CONNECTOR_SEEN_KEY = "stuga:remote-access:connector-seen";

/** One sentence per problem that leaves the address working, or trying to. */
const DEGRADED: Partial<Record<RemoteErrorCode, string>> = {
  service_unreachable: "Couldn’t reach the remote access service.",
  service_refused: "The remote access service refused a request.",
  issuance_budget: "Too many certificates were issued for these addresses this week.",
  acme_rate_limited: "The certificate authority asked the node to wait.",
  acme_challenge_failed: "The certificate authority couldn’t verify this address.",
  dns_not_visible: "The certificate check’s DNS record didn’t appear in time.",
  acme_error: "Getting a certificate failed.",
  connector_unreachable: "The address doesn’t reach this node. Check that the connector is running.",
  wrong_certificate: "Another computer is using this address. Turn off remote access on the one you no longer use.",
  certificate_expired: "The certificate expired. The node is getting a new one.",
  connector_failed: "The connector couldn’t start.",
};

/** Where the packaging runs the connector, nobody is asked to check on it. */
const MANAGED_UNREACHABLE = "The connector is starting or can’t reach the relay.";

/** The connector's status line, where the packaging runs it: a reason where it has one. */
function connectorLabel(status: ConnectorStatus | null): string {
  if (!status) return "Starting…";
  switch (status.state) {
    case "installing":
      return "Installing…";
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    default:
      return status.message || (status.state === "unavailable" ? "Not included in this installation" : "Couldn’t start");
  }
}

/** A time today by the clock, another day with its date. */
function when(iso: string): string {
  return new Date(iso).toDateString() === new Date().toDateString() ? timeOfDay(iso) : versionLabel(iso);
}

const isFuture = (iso: string | null | undefined, now: number) => !!iso && Date.parse(iso) > now;

/** What a starting node is waiting on, in the order it gets there. */
function progress(status: Status, now: number): string {
  if (!isFuture(status.certificate?.expires_at, now)) return "Getting a certificate…";
  if (!isFuture(status.credential?.expires_at, now)) return "Connecting to the relay…";
  if (status.connector?.managed && status.connector.status?.state === "installing") return "Installing the connector…";
  return "Checking the address…";
}

/** A path as one shell word. */
function shellWord(path: string): string {
  return /^[\w./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

export function RemoteAccessSection() {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [failed, setFailed] = useState(false);
  /** Bumped by a failed poll, so the next one is still scheduled. */
  const [misses, setMisses] = useState(0);

  const load = useCallback(async () => {
    setStatus(await NodeApi.getRemoteAccess());
    setFailed(false);
  }, []);

  const retry = useCallback(() => {
    setFailed(false);
    load().catch(() => setFailed(true));
  }, [load]);

  useEffect(retry, [retry]);

  // Hidden in its Activity, the section has no effects, so this polls only while it is shown.
  useEffect(() => {
    if (!status?.available || !status.enabled) return;
    const t = setTimeout(
      () => void load().catch(() => setMisses((n) => n + 1)),
      status.state === "starting" ? POLL_STARTING_MS : POLL_MS,
    );
    return () => clearTimeout(t);
  }, [status, misses, load]);

  if (failed && !status) {
    return <LoadFailed isCompact icon={<Globe size={22} />} title="Couldn’t load remote access" onRetry={retry} />;
  }
  if (!status) return <Spinner />;
  if (!status.available) return <Text color="secondary">Remote access isn’t available on this node.</Text>;
  return <RemoteAccessPanel status={status} onStatus={setStatus} />;
}

function RemoteAccessPanel({ status, onStatus }: { status: Status; onStatus: (s: RemoteAccessStatus) => void }) {
  const section = useSectionStatus();
  const [code, setCode] = useState("");
  const [accepted, setAccepted] = useState(false);
  /** "Use a different code" is open: only then does a bound node send one. */
  const [otherCode, setOtherCode] = useState(false);
  /** A refused turn-on that carried a code, shown under the code field. */
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "on" | "off" | "retry">("");
  const [confirmOff, setConfirmOff] = useState(false);

  const now = Date.now();
  const bound = status.address !== null;
  const error = status.last_error;
  // The node keeps only an https link; checked here too, since it came from the CA's directory.
  const termsUrl = status.ca_terms?.url?.startsWith("https://") ? status.ca_terms.url : CA_TERMS_URL;

  async function turnOn(withCode: boolean) {
    setBusy("on");
    section.clear();
    setCodeError(null);
    const sent = withCode ? code.trim() : "";
    try {
      const next = await NodeApi.enableRemoteAccess({ ...(sent ? { code: sent } : {}), accept_ca_terms: true });
      setCode("");
      setAccepted(false);
      setOtherCode(false);
      onStatus(next);
    } catch (e) {
      const message = errorMessage(e, String(e));
      if (sent) setCodeError(message);
      else section.setError(message);
    } finally {
      setBusy("");
    }
  }

  async function turnOff() {
    setBusy("off");
    section.clear();
    try {
      onStatus(await NodeApi.disableRemoteAccess());
    } catch (e) {
      section.fail(e);
    } finally {
      setBusy("");
    }
  }

  async function retryConnector() {
    setBusy("retry");
    section.clear();
    try {
      onStatus(await NodeApi.retryRemoteConnector());
    } catch (e) {
      section.fail(e);
    } finally {
      setBusy("");
    }
  }

  const turnOffButton = (
    <Button
      label="Turn off"
      variant="secondary"
      size="sm"
      isDisabled={busy !== ""}
      isLoading={busy === "off"}
      onClick={() => setConfirmOff(true)}
    />
  );

  /**
   * The code field, the agreement and Turn on; `codeRequired` for a node with no address, or one
   * whose key was refused, which is still on and keeps Turn off beside it.
   */
  const turnOnForm = (codeRequired: boolean, beside?: ReactNode) => {
    const codeField = (
      <TextInput
        label="Code"
        value={code}
        placeholder="XXXX-XXXX-XXXX-XXXX"
        autoComplete="off"
        width="min(100%, 20rem)"
        status={codeError ? { type: "error", message: codeError } : undefined}
        onChange={(v: string) => {
          setCode(v);
          setCodeError(null);
        }}
      />
    );
    const withCode = codeRequired || otherCode;
    return (
      <VStack gap={3}>
        {codeRequired ? (
          codeField
        ) : (
          <Collapsible trigger="Use a different code" isOpen={otherCode} onOpenChange={setOtherCode}>
            {codeField}
          </Collapsible>
        )}
        <HStack gap={2} vAlign="center">
          <CheckboxInput
            label="I accept the Let’s Encrypt Subscriber Agreement."
            isLabelHidden
            value={accepted}
            onChange={(v: boolean) => setAccepted(v)}
          />
          <Text>
            I accept the{" "}
            <Link href={termsUrl} isExternalLink>
              Let’s Encrypt Subscriber Agreement
            </Link>
            .
          </Text>
        </HStack>
        <HStack gap={2}>
          <Button
            label="Turn on"
            variant="primary"
            size="sm"
            isDisabled={!accepted || (codeRequired && !code.trim()) || busy !== ""}
            isLoading={busy === "on"}
            onClick={() => void turnOn(withCode)}
          />
          {beside}
        </HStack>
      </VStack>
    );
  };

  const turnOffRow = <HStack gap={2}>{turnOffButton}</HStack>;

  let body;
  if (!status.enabled) {
    // A moved address is forgotten here, so turning on again takes a code.
    body = (
      <>
        {error?.code === "moved" && <Banner status="info" title="This address moved to another computer." />}
        {bound && <Text color="secondary">{status.address}</Text>}
        {turnOnForm(!bound)}
      </>
    );
  } else if (status.state === "denied") {
    const title = "Remote access is off for this address.";
    body = (
      <>
        <Banner status="error" title={title} description={error && error.message !== title ? error.message : undefined} />
        {turnOffRow}
      </>
    );
  } else if (status.state === "error" && error) {
    body = (
      <>
        <Banner
          status="error"
          title={errorSentence(error)}
          description={error.code === "connector_refused" && error.message ? error.message : undefined}
        />
        {error.code === "binding_rejected" ? (
          turnOnForm(true, turnOffButton)
        ) : error.code === "connector_refused" ? (
          <HStack gap={2}>
            <Button
              label="Retry"
              variant="primary"
              size="sm"
              isDisabled={busy !== ""}
              isLoading={busy === "retry"}
              onClick={() => void retryConnector()}
            />
            {turnOffButton}
          </HStack>
        ) : (
          turnOffRow
        )}
      </>
    );
  } else {
    // starting, on, degraded: the address and how to keep it reachable.
    const running = status.state !== "starting";
    const managed = status.connector?.managed ?? false;
    const reported = status.connector?.status ?? null;
    // While starting, a reason to wait that progress() doesn't already give.
    const connectorLine = managed && (running || (reported !== null && reported.state !== "installing"));
    const expiredAt = status.certificate && !isFuture(status.certificate.expires_at, now) ? status.certificate.expires_at : null;
    const title = error?.code === "connector_unreachable" && managed ? MANAGED_UNREACHABLE : error ? (DEGRADED[error.code] ?? error.message) : "";
    body = (
      <>
        {status.address && <AddressRow address={status.address} canCopy={running} />}
        {status.state === "starting" && (
          <HStack gap={2} vAlign="center">
            <Spinner size="sm" />
            <Text color="secondary">{progress(status, now)}</Text>
          </HStack>
        )}
        {expiredAt ? (
          <Text type="supporting" color="secondary">
            Certificate expired {shortDate(expiredAt)}.
          </Text>
        ) : (
          running &&
          status.certificate?.renew_at && (
            <Text type="supporting" color="secondary">
              Certificate renews {shortDate(status.certificate.renew_at)}.
            </Text>
          )
        )}
        {connectorLine && (
          <Text type="supporting" color="secondary">
            Connector: {connectorLabel(reported)}
          </Text>
        )}
        {status.state === "degraded" && error && (
          <Banner
            status={error.code === "wrong_certificate" ? "error" : "warning"}
            title={title}
            description={error.retry_at ? `Next try ${when(error.retry_at)}.` : undefined}
          />
        )}
        {!managed && status.connector?.config_path && (
          <ConnectorHint configPath={status.connector.config_path} changedAt={status.connector.config_changed_at} />
        )}
        {turnOffRow}
      </>
    );
  }

  return (
    <VStack gap={3}>
      <Heading level={2}>Remote access</Heading>
      <Text type="supporting" color="secondary">
        Reach this node from anywhere at its own address.
      </Text>
      <SectionStatusBanners status={section} />
      {body}
      <AlertDialog
        isOpen={confirmOff}
        onOpenChange={(o) => !o && setConfirmOff(false)}
        title="Turn off remote access?"
        description={`Nobody reaches this node at ${status.address ?? "its remote address"} until it is on again. The address is kept.`}
        actionLabel="Turn off"
        onAction={() => {
          setConfirmOff(false);
          void turnOff();
        }}
      />
    </VStack>
  );
}

/** What an administrator, or a newer Stuga, has to fix before remote access works again. */
function errorSentence(error: RemoteError): string {
  switch (error.code) {
    case "binding_rejected":
      return "The remote access service no longer accepts this node’s key. Enter a restore code to keep this address.";
    case "upgrade_required":
      return "Update Stuga to use remote access.";
    case "acme_action_required":
      return `The certificate authority needs attention: ${error.message}`;
    case "connector_refused":
      // The packaging's reason goes beneath.
      return "The connector didn’t pass its checks, so it isn’t running.";
    default:
      // The shared directory or the socket: the node's message names the path and what is wrong with it.
      return error.message;
  }
}

function AddressRow({ address, canCopy }: { address: string; canCopy: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <HStack gap={2} vAlign="center">
      <Text>{address}</Text>
      {canCopy && (
        <Button
          label={copied ? "Copied" : "Copy"}
          variant="ghost"
          size="sm"
          onClick={() =>
            void copyText(address).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        />
      )}
    </HStack>
  );
}

/**
 * Where no helper runs the connector, the command that does. A change to its settings after this
 * browser first saw them is pointed out until dismissed: a running connector reads them only at start.
 */
function ConnectorHint({ configPath, changedAt }: { configPath: string; changedAt: string | null }) {
  const [seen, setSeen] = useState(() => readStored("local", CONNECTOR_SEEN_KEY));

  useEffect(() => {
    // The first settings seen here are the ones the connector is about to be started with.
    if (changedAt && seen === null) {
      writeStored("local", CONNECTOR_SEEN_KEY, changedAt);
      setSeen(changedAt);
    }
  }, [changedAt, seen]);

  const changed = changedAt !== null && seen !== null && Date.parse(changedAt) > Date.parse(seen);
  return (
    <VStack gap={2}>
      <Text type="supporting" color="secondary">
        Run the connector on this machine:
      </Text>
      {/* Without a title the copy button sits over a wrapped path's last characters. */}
      <CodeBlock code={`frpc -c ${shellWord(configPath)}`} title="Connector" width="100%" isWrapped size="sm" />
      {changed && (
        <Banner
          status="info"
          title={`Its settings changed at ${when(changedAt)}.`}
          description="Restart it if it was already running."
          isDismissable
          dismissLabel="Dismiss"
          onDismiss={() => {
            writeStored("local", CONNECTOR_SEEN_KEY, changedAt);
            setSeen(changedAt);
          }}
        />
      )}
    </VStack>
  );
}
