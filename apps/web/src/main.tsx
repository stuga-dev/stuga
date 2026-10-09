// Astryx's layered CSS and theme first, then Stuga's global styles; each
// feature's entry module imports its own stylesheet.
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./styles/tokens.css";
import "./styles/base.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { applyTheme } from "./state/theme";
import { applyBranding } from "./state/branding";
import { installClipboardFallback } from "./lib/clipboard";
import { loadAuthConfig, nodeUnclaimed } from "./lib/session/auth-config";
import { clearTokens } from "./lib/session/tokens";
import { loadUiLanguage } from "./i18n/i18n";
import { bootUiLanguage } from "./i18n/preference";
import { I18nProvider } from "./i18n/I18nProvider";

applyTheme(); // before first paint
installClipboardFallback(); // a LAN node is plain http, where the Clipboard API is missing

// The node decides how people sign in and how it is branded; read once before the first render.
// The app's modules load after the catalog, so a message they read at import is already translated.
void Promise.all([loadAuthConfig(), loadUiLanguage(bootUiLanguage())]).then(async () => {
  // A node nobody has set up has issued no session. One kept here is from a node since wiped, and
  // would carry the setup link into the app, whose 401 lands on /login without the code.
  if (nodeUnclaimed()) clearTokens();
  applyBranding();
  const { App } = await import("./App");
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </React.StrictMode>,
  );
});
