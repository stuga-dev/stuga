/**
 * The remote address's password rule (@stuga/password-strength), for the forms that set a password:
 * the hint under the field while the remote address is on, and the letter-and-number rule a
 * passphrase skips. Loaded only when a form needs it: the remote address is on, or the password is
 * long enough that the rule could pass. Scored with what the node scores with plus the person's
 * display name, so the form never says a password works from anywhere that the node would refuse.
 */
import { useEffect, useState } from "react";
import { authConfig } from "./auth-config";

type StrengthModule = typeof import("@stuga/password-strength");

/** Characters as a person counts them, matching the package's count without loading it. */
const codePoints = (pw: string): number => [...pw].length;
const MIN_CODE_POINTS = 15;

let loading: Promise<StrengthModule> | null = null;
/** Load the package once; a failed load is tried again next time. */
export function loadStrength(): Promise<StrengthModule> {
  loading ??= import("@stuga/password-strength").catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

export interface StrengthPerson {
  /** As typed in the form, or the account's. */
  username: string;
  displayName?: string | null;
}

/** The first label of the remote address's hostname, which the node scores with. */
function remoteHostLabel(): string | null {
  const origin = authConfig().remoteOrigin;
  if (!origin) return null;
  try {
    return new URL(origin).hostname.split(".")[0] ?? null;
  } catch {
    return null;
  }
}

/** Whether `password` meets the remote address's rule; false when the package cannot be loaded. */
export async function meetsRemoteRule(password: string, person: StrengthPerson): Promise<boolean> {
  if (codePoints(password) < MIN_CODE_POINTS) return false;
  const lib = await loadStrength();
  const inputs = lib.strengthInputs({
    username: person.username.trim().replace(/^@/, "").toLowerCase(),
    nodeName: authConfig().nodeName,
    hostLabel: remoteHostLabel(),
    displayName: person.displayName ?? null,
  });
  return lib.remotePasswordOk(password, inputs).ok;
}

export interface RemoteStrength {
  /** The password meets the remote rule. */
  strong: boolean;
  /** The result is for the password as it is now (false while the package loads or scores). */
  settled: boolean;
}

/** `password` against the remote rule as it is typed; nothing is loaded for a short password while the remote address is off. */
export function useRemoteStrength(password: string, person: StrengthPerson): RemoteStrength {
  const [result, setResult] = useState<{ password: string; strong: boolean }>({ password: "", strong: false });
  const remoteOn = authConfig().remoteOrigin !== null;
  const worthScoring = codePoints(password) >= MIN_CODE_POINTS;
  const { username, displayName } = person;
  useEffect(() => {
    if (!worthScoring) return;
    let current = true;
    meetsRemoteRule(password, { username, displayName })
      .then((strong) => current && setResult({ password, strong }))
      .catch(() => current && setResult({ password, strong: false }));
    return () => {
      current = false;
    };
  }, [password, username, displayName, worthScoring]);
  // The hint shows only while the remote address is on; the package is wanted then to say "works from anywhere".
  useEffect(() => {
    if (remoteOn) void loadStrength().catch(() => {});
  }, [remoteOn]);
  if (!worthScoring) return { strong: false, settled: true };
  return result.password === password ? { strong: result.strong, settled: true } : { strong: false, settled: false };
}
