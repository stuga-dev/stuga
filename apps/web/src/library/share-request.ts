/** Opening the Share dialog from an address, as an access request's notification does. */
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

/** The search param that opens the Share dialog on an item's page, as an access request's notification does. */
export const SHARE_PARAM = "share";

/** Opens the Share dialog once when the page's address asks for it, and takes the request out of the address. */
export function useShareRequested(open: () => void): void {
  const [params, setParams] = useSearchParams();
  const asked = params.has(SHARE_PARAM);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!asked) return;
    openRef.current();
    setParams(
      (cur) => {
        const next = new URLSearchParams(cur);
        next.delete(SHARE_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [asked, setParams]);
}
