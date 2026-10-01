/**
 * One line under a field that sets a password, while the remote address is on: whether this password
 * also signs in there. Only a hint; it never stops the form.
 */
import { Text } from "@astryxdesign/core/Text";
import { atRemoteAddress, remoteOrigin } from "../lib/session/auth-config";
import type { RemoteStrength } from "../lib/session/password-strength";

export const WORKS_ANYWHERE = "Works from anywhere.";
export const WORKS_HERE_ONLY = "Works on this network only. Use 15 or more characters to sign in from anywhere.";
export const GUESSABLE_HERE_ONLY = "Works on this network only. Use one that’s harder to guess to sign in from anywhere.";
export const USE_LONGER_HERE = "Use 15 or more characters to sign in here again.";
export const GUESSABLE_HERE = "Use one that’s harder to guess to sign in here again.";

/** Long enough for the remote address: a password short of it is told to be longer, one past it to be harder to guess. */
const REMOTE_LENGTH = 15;

export function PasswordStrengthHint({ password, strength }: { password: string; strength: RemoteStrength }) {
  if (remoteOrigin() === null || password === "" || !strength.settled) return null;
  const long = [...password].length >= REMOTE_LENGTH;
  const here = atRemoteAddress();
  const text = strength.strong
    ? WORKS_ANYWHERE
    : here
      ? long
        ? GUESSABLE_HERE
        : USE_LONGER_HERE
      : long
        ? GUESSABLE_HERE_ONLY
        : WORKS_HERE_ONLY;
  return (
    <Text type="supporting" size="xsm" color="secondary">
      {text}
    </Text>
  );
}
