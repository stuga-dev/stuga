/**
 * Stands in for elkjs, which mermaid loads only for a diagram that asks for `layout: elk`. elkjs is
 * EPL-2.0 without a secondary license, which cannot be combined with Stuga's AGPL, so the build
 * aliases it here and such a diagram shows mermaid's error instead of a drawing.
 */
import { t } from "../i18n/i18n";

export default class ELK {
  constructor() {
    throw new Error(t("editor.mermaid.elkUnavailable"));
  }
}
