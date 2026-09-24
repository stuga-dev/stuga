/** Whether the signed-in person administers the node, read once per page load; signing out reloads the page. */
import { useEffect, useState } from "react";
import { Me } from "../api";
import { cachedResource } from "../lib/store";

const nodeAdmin = cachedResource(async () => (await Me.whoami()).node_admin);

/** Null until known. False when it cannot be read, so nobody is sent to a page that refuses them. */
export function useIsNodeAdmin(): boolean | null {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(() => nodeAdmin.peek() ?? null);

  useEffect(() => {
    if (nodeAdmin.peek() !== undefined) return;
    let alive = true;
    nodeAdmin.get().then(
      (v) => alive && setIsAdmin(v),
      () => alive && setIsAdmin(false),
    );
    return () => {
      alive = false;
    };
  }, []);

  return isAdmin;
}
