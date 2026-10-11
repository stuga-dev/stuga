/** The pages that need a session: a signed-out visit signs in first and comes back. */
import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Login } from "../pages/Login";
import { getToken } from "../lib/session/tokens";
import { onLinkPage, rememberLoginReturn } from "../lib/session/return-path";
import { startMediaSession } from "../lib/session/tickets";
import { syncAccountLanguage } from "../i18n/preference";
import { useToast } from "../ui/use-toast";
import { takeNotice } from "../lib/session/notice";

export function AuthLayout() {
  const { pathname, search } = useLocation();
  const signedIn = getToken() !== null;
  const toast = useToast();
  useEffect(() => {
    if (!signedIn) return;
    startMediaSession();
    void syncAccountLanguage();
  }, [signedIn]);
  // What a change that reloaded the app had to say, such as a workspace deleted; taken once.
  useEffect(() => {
    if (!signedIn) return;
    const notice = takeNotice();
    if (notice) toast({ body: notice, type: "info" });
  }, [signedIn, toast]);
  if (!signedIn) {
    rememberLoginReturn(pathname + search);
    // Invite and share links sign in where they are, so the link stays in the address bar to copy.
    return onLinkPage(pathname) ? <Login /> : <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
