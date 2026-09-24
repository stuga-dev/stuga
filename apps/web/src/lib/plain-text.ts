/**
 * A name or label a person types, checked as they type against the rules the
 * node applies on save. The node stays the authority; this only says why
 * before a round trip does.
 */
import { UNSAFE_TEXT, hasVisibleText } from "@stuga/protocol/domain/node-name";

/** Why a non-empty `value` would be refused, as a sentence for under the field, or null when it would not. */
export function plainTextProblem(value: string, max: number): string | null {
  if (value.length > max) return `Use up to ${max} characters.`;
  if (UNSAFE_TEXT.test(value)) return "Remove the hidden control characters.";
  if (!hasVisibleText(value)) return "Use at least one visible character.";
  return null;
}
