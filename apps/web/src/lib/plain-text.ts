/**
 * A name or label a person types, checked as they type against the rules the
 * node applies on save. The node stays the authority; this only says why
 * before a round trip does.
 */
import { UNSAFE_TEXT, hasVisibleText } from "@stuga/protocol/domain/node-name";
import { t } from "../i18n/i18n";

/** Why a non-empty `value` would be refused, as a sentence for under the field, or null when it would not. */
export function plainTextProblem(value: string, max: number): string | null {
  if (value.length > max) return t("ui.plainText.tooLong", { max });
  if (UNSAFE_TEXT.test(value)) return t("ui.plainText.hiddenCharacters");
  if (!hasVisibleText(value)) return t("ui.plainText.noVisibleText");
  return null;
}
