import { t } from "../../i18n/i18n";
import { presentServerMessage } from "../http/server-messages";
import { PRODUCT_NAME } from "../../shell/Brand";
import { providerLabel } from "./auth-config";

/** Web Storage refused a write the session depends on. */
export class StorageBlockedError extends Error {
  constructor() {
    super(t("auth.errors.storageBlocked"));
    this.name = "StorageBlockedError";
  }
}

/** A refusal from the node's auth routes: its status, and its code as the message. */
export class AuthError extends Error {
  status: number;
  /** The node's own sentence, for a code this app has no words for. */
  detail?: string;
  /** An available username, sent with a refused one. */
  suggestion?: string;
  /** With `reauth_required`: how this person can confirm it is them (lib/session/reauth.ts). */
  methods?: string[];
  constructor(status: number, message: string, extra: { detail?: string; suggestion?: string; methods?: string[] } = {}) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.detail = extra.detail;
    this.suggestion = extra.suggestion;
    this.methods = extra.methods;
  }
}

/** The node's refusal codes in words: a code is never shown as it is. Lazy, so each reads the interface language. */
const CODE_MESSAGES: Record<string, (err: AuthError) => string> = {
  invite_invalid: () => t("auth.errors.inviteInvalid"),
  invite_required: () => t("auth.errors.inviteRequired"),
  invite_local_only: () => t("auth.errors.inviteLocalOnly"),
  reset_invalid: () => t("auth.errors.resetInvalid"),
  setup_required: () => t("auth.errors.setupRequired"),
  // The field that appears with this says where to find the code.
  setup_code_required: () => t("auth.errors.setupCodeRequired"),
  setup_code_invalid: () => t("auth.errors.setupCodeInvalid"),
  // The first account is made on the node's own network, where its setup code is.
  setup_not_remote: () => t("auth.errors.setupNotRemote"),
  username_taken: () => t("auth.errors.usernameTaken"),
  username_reserved: () => t("auth.errors.usernameReserved"),
  // USERNAME_RULE (@stuga/protocol) in the reader's language; errors.test.ts holds the English to it.
  invalid_username: () => t("auth.username.rule"),
  // Linking from the profile, a first visit's link, or a subject linked meanwhile: one sentence covers all three.
  already_linked: () => {
    const provider = providerLabel();
    return provider ? t("auth.errors.alreadyLinked", { provider }) : t("auth.errors.alreadyLinkedUnnamed");
  },
  handoff_invalid: () => t("auth.errors.handoffInvalid"),
  ticket_invalid: () => t("auth.errors.ticketInvalid"),
  no_provider: () => t("auth.errors.noProvider"),
  provider_unreachable: () => {
    const provider = providerLabel();
    return provider ? t("auth.errors.providerUnreachable", { provider }) : t("auth.errors.providerUnreachableUnnamed");
  },
  invalid_token: () => t("auth.errors.invalidToken"),
  password_required: () => t("auth.errors.passwordRequired"),
  password_set: () => t("auth.errors.passwordSet"),
  remote_password_weak: () => t("auth.errors.remotePasswordWeak", { count: 15 }),
  passkey_invalid: () => t("auth.errors.passkeyInvalid"),
  passkey_not_added: () => t("auth.errors.passkeyNotAdded"),
  passkey_exists: () => t("auth.errors.passkeyExists"),
  no_passkey: () => t("auth.errors.noPasskey"),
  remote_off: () => t("auth.errors.remoteOff"),
  // The node's sentence says how long: it is the only part that varies.
  sign_in_paused: (err) => (err.detail ? presentServerMessage(err.detail) : t("auth.errors.signInPaused")),
  busy: () => t("auth.errors.busy", { product: PRODUCT_NAME }),
  // The node's sentence names the remote address when there is one.
  password_off_network: (err) => (err.detail ? presentServerMessage(err.detail) : t("auth.errors.passwordOffNetwork")),
  wrong_account: () => t("auth.errors.wrongAccount"),
  reauth_required: () => t("auth.errors.reauthRequired"),
};

/** The node's own sentence, in the reader's language when the catalog has it. */
const nodeSentence = (detail: string | undefined): string | undefined => (detail ? presentServerMessage(detail) : undefined);

/** A sign-in failure as one sentence a person can act on. */
export function describeError(err: unknown): string {
  if (err instanceof StorageBlockedError) return err.message;
  // The passkey prompt closed (lib/session/passkey.ts): its own sentence.
  if (err instanceof Error && err.name === "PasskeyCancelled") return err.message;
  if (err instanceof AuthError) {
    const known = CODE_MESSAGES[err.message];
    if (known) return known(err);
    if (err.status === 401) return t("auth.errors.credentialsMismatch");
    // A 403 carries a code, never prose: never pass it through.
    if (err.status === 403) return t("auth.errors.inviteOnly");
    if (err.status === 409) return CODE_MESSAGES.username_taken!(err);
    if (err.status === 429) return t("auth.errors.tooManyAttempts");
    // Starting, upgrading or backing up says so; a 503 without a sentence is the busy one.
    if (err.status === 503) return nodeSentence(err.detail) || CODE_MESSAGES.busy!(err);
    if (err.status === 400) return nodeSentence(err.detail) || t("auth.errors.checkCredentials");
    return nodeSentence(err.detail) || err.message || t("auth.errors.generic");
  }
  return t("auth.errors.connection");
}
