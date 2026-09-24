/** The password and name rules every sign-in endpoint shares. */
import { randomUUID } from "node:crypto";
import { hashPassword } from "@stuga/auth";
import { fail } from "./http.js";

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 1024;
export const MAX_NAME = 100;

/** Verified against when no account or no password matches, so a failed sign-in costs the same either way. */
let decoyHash: Promise<string> | null = null;
export function decoy(): Promise<string> {
  decoyHash ??= hashPassword(randomUUID());
  return decoyHash;
}

/** The answer for a password that fails the policy; null when it passes. */
export function passwordPolicy(password: string): Response | null {
  if (password.length < MIN_PASSWORD) return fail(400, "weak_password", `password must be at least ${MIN_PASSWORD} characters`);
  if (password.length > MAX_PASSWORD) return fail(400, "invalid_password", "password is too long");
  return null;
}
