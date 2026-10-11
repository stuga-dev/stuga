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
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { Globe } from "lucide-react";
import type {
  ConnectorStatus,
  RemoteAccessEnableErrorCode,
  RemoteAccessStatus,
  RemoteError,
  RemoteErrorCode,
} from "@stuga/protocol/api/remote-access";
import { NodeSettings as NodeApi } from "../../../api";
import { copyText } from "../../../lib/clipboard";
import { atRemoteAddress, authConfig } from "../../../lib/session/auth-config";
import { shortDate, timeOfDay, versionLabel } from "../../../lib/format";
import { errorMessage, type ApiError } from "../../../lib/http/client";
import { readStored, writeStored } from "../../../lib/storage";
import { LoadFailed } from "../../../ui/LoadFailed";
import { SectionStatusBanners, useSectionStatus } from "./status";
import { t, type MessageKey } from "../../../i18n/i18n";
import { tRich } from "../../../i18n/rich";
import { presentServerMessage } from "../../../lib/http/server-messages";

type Status = Extract<RemoteAccessStatus, { available: true }>;

/** Where the agreement lives until the node's certificate account names the version it took. */
const CA_TERMS_URL = "https://letsencrypt.org/repository/";

/** How soon the page asks again: often while it starts, now and then once it runs. */
const POLL_STARTING_MS = 3000;
const POLL_MS = 30_000;

/** The connector settings this browser last saw, so a later change is pointed out; a per-viewer convenience. */
const CONNECTOR_SEEN_KEY = "stuga:remote-access:connector-seen";

/** One sentence per problem that leaves the address working, or trying to. */
const DEGRADED: Partial<Record<RemoteErrorCode, MessageKey>> = {
  service_unreachable: "nodeAccess.remote.degraded.serviceUnreachable",
  service_refused: "nodeAccess.remote.degraded.serviceRefused",
  issuance_budget: "nodeAccess.remote.degraded.issuanceBudget",
  acme_rate_limited: "nodeAccess.remote.degraded.acmeRateLimited",
  acme_challenge_failed: "nodeAccess.remote.degraded.acmeChallengeFailed",
  dns_not_visible: "nodeAccess.remote.degraded.dnsNotVisible",
  acme_error: "nodeAccess.remote.degraded.acmeError",
  connector_unreachable: "nodeAccess.remote.degraded.connectorUnreachable",
  wrong_certificate: "nodeAccess.remote.degraded.wrongCertificate",
  certificate_expired: "nodeAccess.remote.degraded.certificateExpired",
  connector_failed: "nodeAccess.remote.degraded.connectorFailed",
};

/** A problem with this node's own files: a sentence, with the node's text, which names the path, beneath. */
const LOCAL_PROBLEMS: Record<Extract<RemoteAccessEnableErrorCode, "remote_dir_unusable" | "socket_path_too_long" | "key_unreadable">, MessageKey> = {
  remote_dir_unusable: "nodeAccess.remote.error.dirUnusable",
  socket_path_too_long: "nodeAccess.remote.error.socketPathTooLong",
  key_unreadable: "nodeAccess.remote.error.keyUnreadable",
};

function localProblem(code: string | undefined): MessageKey | undefined {
  return code && Object.hasOwn(LOCAL_PROBLEMS, code) ? LOCAL_PROBLEMS[code as keyof typeof LOCAL_PROBLEMS] : undefined;
}

/** What the node says of a denied address when the service gives no reason of its own. */
const NODE_DENIED = "Remote access is off for this address."; // i18n-exempt: the node's sentence, compared, never shown

/** A degraded problem in words: the sentence for its code, or the node's own. */
function degradedSentence(error: RemoteError): string {
  const key = DEGRADED[error.code];
  return key ? t(key) : presentServerMessage(error.message);
}

/** The connector's status line, where the packaging runs it: a reason where it has one. */
function connectorLabel(status: ConnectorStatus | null): string {
  if (!status) return t("nodeAccess.remote.connector.starting");
  switch (status.state) {
    case "installing":
      return t("nodeAccess.remote.connector.installing");
    case "running":
      return t("nodeAccess.remote.connector.running");
    case "stopped":
      return t("nodeAccess.remote.connector.stopped");
    default:
      if (status.message) return presentServerMessage(status.message);
      return status.state === "unavailable" ? t("nodeAccess.remote.connector.unavailable") : t("nodeAccess.remote.connector.failed");
  }
}

/** A time today by the clock, another day with its date. */
function when(iso: string): string {
  return new Date(iso).toDateString() === new Date().toDateString() ? timeOfDay(iso) : versionLabel(iso);
}

const isFuture = (iso: string | null | undefined, now: number) => !!iso && Date.parse(iso) > now;

/** What a starting node is waiting on, in the order it gets there. */
function progress(status: Status, now: number): string {
  if (!isFuture(status.certificate?.expires_at, now)) return t("nodeAccess.remote.progress.certificate");
  if (!isFuture(status.credential?.expires_at, now)) return t("nodeAccess.remote.progress.relay");
  if (status.connector?.managed && status.connector.status?.state === "installing") return t("nodeAccess.remote.progress.connector");
  return t("nodeAccess.remote.progress.address");
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
    const timer = setTimeout(
      () => void load().catch(() => setMisses((n) => n + 1)),
      status.state === "starting" ? POLL_STARTING_MS : POLL_MS,
    );
    return () => clearTimeout(timer);
  }, [status, misses, load]);

  if (failed && !status) {
    return <LoadFailed isCompact icon={<Globe size={22} />} title={t("nodeAccess.remote.loadFailed")} onRetry={retry} />;
  }
  if (!status) return <Spinner />;
  if (!status.available) return <Text color="secondary">{t("nodeAccess.remote.unavailable")}</Text>;
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
  /** The node's own text under a refusal worded here, naming the path it is about. */
  const [detail, setDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "on" | "off" | "retry">("");
  const [confirmOff, setConfirmOff] = useState(false);

  const now = Date.now();
  const bound = status.address !== null;
  const error = status.last_error;
  // The node keeps only an https link; checked here too, since it came from the CA's directory.
  const termsUrl = status.ca_terms?.url?.startsWith("https://") ? status.ca_terms.url : CA_TERMS_URL;

  function clear() {
    section.clear();
    setDetail(null);
  }

  async function turnOn(withCode: boolean) {
    setBusy("on");
    clear();
    setCodeError(null);
    const sent = withCode ? code.trim() : "";
    try {
      const next = await NodeApi.enableRemoteAccess({ ...(sent ? { code: sent } : {}), accept_ca_terms: true });
      setCode("");
      setAccepted(false);
      setOtherCode(false);
      onStatus(next);
    } catch (e) {
      const local = localProblem((e as ApiError).code);
      const message = errorMessage(e, String(e));
      if (local) {
        // About this node's files, whatever code was sent: the node's text says which file.
        section.setError(t(local));
        setDetail(message);
      } else if (sent) setCodeError(message);
      else section.setError(message);
    } finally {
      setBusy("");
    }
  }

  async function turnOff() {
    setBusy("off");
    clear();
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
    clear();
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
      label={t("nodeAccess.remote.turnOff")}
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
        label={t("nodeAccess.remote.code")}
        value={code}
        placeholder="XXXX-XXXX-XXXX-XXXX" // i18n-exempt: the shape of a code, not words
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
          <Collapsible trigger={t("nodeAccess.remote.otherCode")} isOpen={otherCode} onOpenChange={setOtherCode}>
            {codeField}
          </Collapsible>
        )}
        <HStack gap={2} vAlign="center">
          <CheckboxInput
            label={t("nodeAccess.remote.acceptTerms")}
            isLabelHidden
            value={accepted}
            onChange={(v: boolean) => setAccepted(v)}
          />
          <Text>
            {tRich("nodeAccess.remote.acceptTermsLink", {
              link: (chunks) => (
                <Link href={termsUrl} isExternalLink>
                  {chunks}
                </Link>
              ),
            })}
          </Text>
        </HStack>
        <HStack gap={2}>
          <Button
            label={t("nodeAccess.remote.turnOn")}
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
        {error?.code === "moved" && <Banner status="info" title={t("nodeAccess.remote.moved")} />}
        {bound && <Text color="secondary">{status.address}</Text>}
        {turnOnForm(!bound)}
      </>
    );
  } else if (status.state === "denied") {
    // The node's general sentence repeats the title; only a reason of the service's own goes beneath.
    const reason = error && error.message !== NODE_DENIED ? presentServerMessage(error.message) : undefined;
    body = (
      <>
        <Banner status="error" title={t("nodeAccess.remote.denied")} description={reason || undefined} />
        {turnOffRow}
      </>
    );
  } else if (status.state === "error" && error) {
    body = (
      <>
        <Banner
          status="error"
          title={errorSentence(error)}
          description={
            error.code === "connector_refused" && error.message
              ? presentServerMessage(error.message)
              : localProblem(error.code)
                ? error.message
                : undefined
          }
        />
        {error.code === "binding_rejected" ? (
          turnOnForm(true, turnOffButton)
        ) : error.code === "connector_refused" ? (
          <HStack gap={2}>
            <Button
              label={t("common.retry")}
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
    // Where the packaging runs the connector, nobody is asked to check on it.
    const title =
      error?.code === "connector_unreachable" && managed ? t("nodeAccess.remote.managedUnreachable") : error ? degradedSentence(error) : "";
    body = (
      <>
        {status.address && <AddressRow address={status.address} canCopy={running} />}
        {running && status.address && <ShareLines address={status.address} />}
        {status.state === "starting" && (
          <HStack gap={2} vAlign="center">
            <Spinner size="sm" />
            <Text color="secondary">{progress(status, now)}</Text>
          </HStack>
        )}
        {expiredAt ? (
          <Text type="supporting" color="secondary">
            {t("nodeAccess.remote.certificateExpired", { date: shortDate(expiredAt) })}
          </Text>
        ) : (
          running &&
          status.certificate?.renew_at && (
            <Text type="supporting" color="secondary">
              {t("nodeAccess.remote.certificateRenews", { date: shortDate(status.certificate.renew_at) })}
            </Text>
          )
        )}
        {connectorLine && (
          <Text type="supporting" color="secondary">
            {t("nodeAccess.remote.connector.line", { status: connectorLabel(reported) })}
          </Text>
        )}
        {status.state === "degraded" && error && (
          <Banner
            status={error.code === "wrong_certificate" ? "error" : "warning"}
            title={title}
            description={error.retry_at ? t("nodeAccess.remote.nextTry", { time: when(error.retry_at) }) : undefined}
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
      <Text type="supporting" color="secondary">
        {t("nodeAccess.remote.intro")}
      </Text>
      <SectionStatusBanners status={section} />
      {section.error && detail && (
        <Text type="supporting" color="secondary">
          {detail}
        </Text>
      )}
      {body}
      <AlertDialog
        isOpen={confirmOff}
        onOpenChange={(o) => !o && setConfirmOff(false)}
        title={t("nodeAccess.remote.confirmOff.title")}
        description={
          status.address
            ? t("nodeAccess.remote.confirmOff.description", { address: status.address })
            : t("nodeAccess.remote.confirmOff.descriptionNoAddress")
        }
        actionLabel={t("nodeAccess.remote.turnOff")}
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
      return t("nodeAccess.remote.error.bindingRejected");
    case "upgrade_required":
      return t("nodeAccess.remote.error.upgradeRequired");
    case "acme_action_required":
      return t("nodeAccess.remote.error.acmeActionRequired", { message: presentServerMessage(error.message) });
    case "connector_refused":
      // The packaging's reason goes beneath.
      return t("nodeAccess.remote.error.connectorRefused");
    case "remote_dir_unusable":
    case "socket_path_too_long":
      // The node's message, which names the path and what is wrong with it, goes beneath.
      return t(LOCAL_PROBLEMS[error.code]);
    default:
      return presentServerMessage(error.message);
  }
}

/** Which address to hand out, and how people sign in there; the node's own stays on its network. */
function ShareLines({ address }: { address: string }) {
  // Not named at the remote address, which never shows the network's own.
  const local = atRemoteAddress() ? null : authConfig().origin;
  return (
    <VStack gap={1}>
      <Text type="supporting" color="secondary">
        {t("nodeAccess.remote.share", { address })}
      </Text>
      <Text type="supporting" color="secondary">
        {local ? t("nodeAccess.remote.keepLocal", { address: local }) : t("nodeAccess.remote.keepLocalUnnamed")}
      </Text>
    </VStack>
  );
}

function AddressRow({ address, canCopy }: { address: string; canCopy: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <HStack gap={2} vAlign="center">
      <Text>{address}</Text>
      {canCopy && (
        <Button
          label={copied ? t("common.copied") : t("common.copy")}
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
        {t("nodeAccess.remote.runConnector")}
      </Text>
      {/* Without a title the copy button sits over a wrapped path's last characters. */}
      <CodeBlock
        code={`frpc -c ${shellWord(configPath)}`} // i18n-exempt: a shell command
        title={t("nodeAccess.remote.connectorTitle")}
        width="100%"
        isWrapped
        size="sm"
      />
      {changed && (
        <Banner
          status="info"
          title={t("nodeAccess.remote.settingsChanged", { time: when(changedAt) })}
          description={t("nodeAccess.remote.restartConnector")}
          isDismissable
          dismissLabel={t("common.dismiss")}
          onDismiss={() => {
            writeStored("local", CONNECTOR_SEEN_KEY, changedAt);
            setSeen(changedAt);
          }}
        />
      )}
    </VStack>
  );
}
