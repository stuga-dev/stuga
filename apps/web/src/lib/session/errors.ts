import { USERNAME_RULE } from "@stuga/protocol/domain/username";
import { providerLabel } from "./auth-config";

/** Web Storage refused a write the session depends on. */
export class StorageBlockedError extends Error {
  constructor() {
    super("Can’t sign in while browser storage is blocked for this site. Enable cookies and site data, then try again.");
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
  constructor(status: number, message: string, extra: { detail?: string; suggestion?: string } = {}) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.detail = extra.detail;
    this.suggestion = extra.suggestion;
  }
}

const provider = () => providerLabel() ?? "the identity provider";

/** The node's refusal codes in words: a code is never shown as it is. */
const CODE_MESSAGES: Record<string, () => string> = {
  invite_invalid: () => "That invite link is no longer valid. Ask whoever sent it for a new one.",
  invite_required: () => "Creating an account here needs an invite link.",
  reset_invalid: () => "This reset link is invalid, expired, or already used.",
  setup_required: () => "This server isn’t set up yet. Its owner creates the first account with a password.",
  // The field that appears with this says where to find the code.
  setup_code_required: () => "Enter the setup code.",
  setup_code_invalid: () => "That setup code isn’t right. Check it and try again.",
  username_taken: () => "That username is taken. Choose another, or sign in if it’s yours.",
  username_reserved: () => "That username is reserved. Choose another.",
  invalid_username: () => USERNAME_RULE,
  // Linking from the profile, a first visit's link, or a subject linked meanwhile: one sentence covers all three.
  already_linked: () => `That account or this ${provider()} sign-in is already linked.`,
  handoff_invalid: () => "That sign-in didn’t complete. Try again.",
  ticket_invalid: () => "That sign-in has expired. Try again.",
  no_provider: () => "Sign-in with an identity provider isn’t set up here.",
  provider_unreachable: () => `Couldn’t reach ${provider()}. Try again, or sign in with your password.`,
  invalid_token: () => "Your session has ended. Sign in again.",
  password_required: () => "Set a password first.",
  password_set: () => "This account already has a password.",
};

/** A sign-in failure as one sentence a person can act on. */
export function describeError(err: unknown): string {
  if (err instanceof StorageBlockedError) return err.message;
  if (err instanceof AuthError) {
    const known = CODE_MESSAGES[err.message];
    if (known) return known();
    if (err.status === 401) return "That username and password don't match.";
    // A 403 carries a code, never prose: never pass it through.
    if (err.status === 403) return "Sign-up is by invitation on this server.";
    if (err.status === 409) return CODE_MESSAGES.username_taken!();
    if (err.status === 429) return "Too many attempts. Wait a moment and try again.";
    if (err.status === 400) return err.detail || "Check the username and password and try again.";
    return err.detail || err.message || "Something went wrong. Try again.";
  }
  return "Something went wrong. Check your connection and try again.";
}
