/** Hands Astryx's own catalog for the interface language to its components. */
import { useMemo, type ReactNode } from "react";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { astryxMessages } from "./i18n";

export function I18nProvider({ children }: { children: ReactNode }) {
  const catalog = astryxMessages();
  // Its context memoizes on the identity of `messages`; the language is fixed for the page load.
  const messages = useMemo(() => (catalog ? { [catalog.tag]: catalog.messages } : undefined), [catalog]);
  if (!catalog) return children;
  return (
    <InternationalizationProvider locale={catalog.tag} messages={messages as never} dir="ltr">
      {children}
    </InternationalizationProvider>
  );
}
