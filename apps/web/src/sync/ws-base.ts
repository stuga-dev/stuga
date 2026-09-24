/** WebSocket origin: this page's origin, with the scheme flipped to ws/wss. */
export function wsBase(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}
