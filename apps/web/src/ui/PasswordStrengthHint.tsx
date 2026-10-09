/**
 * One line under a field that sets a password, while the remote address is on: whether this password
 * also signs in there. Only a hint; it never stops the form.
 */
import { Text } from "@astryxdesign/core/Text";
import { t } from "../i18n/i18n";
import { atRemoteAddress, remoteOrigin } from "../lib/session/auth-config";
import { passkeysOffered } from "../lib/session/passkey";
import type { RemoteStrength } from "../lib/session/password-strength";

/** Long enough for the remote address: a password short of it is told to be longer, one past it to be harder to guess. */
const REMOTE_LENGTH = 15;

export const WORKS_ANYWHERE = t("ui.passwordHint.worksAnywhere");
export const WORKS_HERE_ONLY = t("ui.passwordHint.worksHereOnly", { count: REMOTE_LENGTH });
export const GUESSABLE_HERE_ONLY = t("ui.passwordHint.guessableHereOnly");
export const USE_LONGER_HERE = t("ui.passwordHint.useLongerHere", { count: REMOTE_LENGTH });
export const GUESSABLE_HERE = t("ui.passwordHint.guessableHere");
/** The same, where this browser can add a passkey. */
export const USE_LONGER_OR_PASSKEY = t("ui.passwordHint.useLongerOrPasskey", { count: REMOTE_LENGTH });
export const GUESSABLE_OR_PASSKEY = t("ui.passwordHint.guessableOrPasskey");

export function PasswordStrengthHint({ password, strength }: { password: string; strength: RemoteStrength }) {
  if (remoteOrigin() === null || password === "" || !strength.settled) return null;
  const long = [...password].length >= REMOTE_LENGTH;
  const here = atRemoteAddress();
  const passkey = here && passkeysOffered();
  const text = strength.strong
    ? WORKS_ANYWHERE
    : here
      ? long
        ? passkey
          ? GUESSABLE_OR_PASSKEY
          : GUESSABLE_HERE
        : passkey
          ? USE_LONGER_OR_PASSKEY
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
