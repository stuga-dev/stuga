/** Requests to the node's own auth routes (/auth/*). */
import { AuthError } from "./errors";

/**
 * POST JSON to an auth route, with `bearer` when the step acts for the
 * signed-in account. Not the app's client on purpose: a refusal here is an
 * answer to show, never a reason to end the session. Null for a 204.
 */
export async function authRequest<T>(path: string, body: Record<string, unknown>, bearer?: string): Promise<T | null> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  if (res.status === 204) return null;
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const text = (key: string) => (typeof json?.[key] === "string" ? (json[key] as string) : undefined);
    throw new AuthError(res.status, text("error") ?? `${path} → ${res.status}`, {
      detail: text("message"),
      suggestion: text("suggestion"),
    });
  }
  return json as T | null;
}
