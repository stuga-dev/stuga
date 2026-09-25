/** The pages that need a session: a signed-out visit signs in first and comes back. */
import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Login } from "../pages/Login";
import { getToken } from "../lib/session/tokens";
import { rememberLoginReturn } from "../lib/session/return-path";
import { startMediaSession } from "../lib/session/tickets";

/** Invite and share links sign in where they are, so the link stays in the address bar to copy. */
const LINK_PAGE = /^\/(join|s)\//;

export function AuthLayout() {
  const { pathname, search } = useLocation();
  const signedIn = getToken() !== null;
  useEffect(() => {
    if (signedIn) startMediaSession();
  }, [signedIn]);
  if (!signedIn) {
    rememberLoginReturn(pathname + search);
    return LINK_PAGE.test(pathname) ? <Login /> : <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
