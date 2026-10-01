/** Where an invite or password link points (./address.ts). */
import { describe, expect, it } from "vitest";
import { linkAddresses, linkOrigin, type LinkMaker } from "./address.js";

const LAN = "http://office.local:8787";
const REMOTE = "https://k7f3q2.mystuga.com";

function maker(over: { arrival?: "local" | "remote"; servedOrigin?: string; publicOrigin?: string; remoteOn?: boolean } = {}): LinkMaker {
  const arrival = over.arrival ?? "local";
  const publicOrigin = over.publicOrigin ?? LAN;
  return {
    arrival,
    servedOrigin: over.servedOrigin ?? (arrival === "remote" ? REMOTE : publicOrigin),
    env: {
      publicOrigin,
      remote: { current: () => ({ enabled: over.remoteOn ?? true, id: "k7f3q2", hostname: "k7f3q2.mystuga.com", origin: REMOTE }) },
    },
  };
}

describe("where a link points", () => {
  it("by default, at the address its maker is using", () => {
    expect(linkOrigin(maker(), undefined)).toEqual({ origin: LAN, address: "local" });
    expect(linkOrigin(maker({ arrival: "remote" }), undefined)).toEqual({ origin: REMOTE, address: "remote" });
    expect(linkAddresses(maker())).toEqual({ remote: true, local: "network", default: "local" });
    expect(linkAddresses(maker({ arrival: "remote" }))).toEqual({ remote: true, local: "network", default: "remote" });
  });

  it("at either address when asked, the node's own from the remote address too", () => {
    expect(linkOrigin(maker(), "remote")).toEqual({ origin: REMOTE, address: "remote" });
    expect(linkOrigin(maker({ arrival: "remote" }), "local")).toEqual({ origin: LAN, address: "local" });
    // On the node's network, the address the maker used, which may be one of EXTRA_ORIGINS.
    expect(linkOrigin(maker({ servedOrigin: "https://nas.example.test" }), "local")).toEqual({ origin: "https://nas.example.test", address: "local" });
  });

  it("at the remote address only while it is on", () => {
    expect(linkOrigin(maker({ remoteOn: false }), "remote")).toMatchObject({ status: 409, error: "remote_off" });
    expect(linkOrigin(maker({ remoteOn: false }), undefined)).toEqual({ origin: LAN, address: "local" });
    expect(linkAddresses(maker({ remoteOn: false }))).toEqual({ remote: false, local: "network", default: "local" });
  });

  it("at the remote address by default when the node's own opens only on this computer", () => {
    const loopback = maker({ publicOrigin: "http://localhost:8787" });
    expect(linkAddresses(loopback)).toEqual({ remote: true, local: "computer", default: "remote" });
    expect(linkOrigin(loopback, undefined)).toEqual({ origin: REMOTE, address: "remote" });
    expect(linkOrigin(loopback, "local")).toEqual({ origin: "http://localhost:8787", address: "local" });
    for (const host of ["http://127.0.0.1:8787", "http://[::1]:8787"]) {
      expect(linkAddresses(maker({ publicOrigin: host })).local).toBe("computer");
    }
    expect(linkAddresses(maker({ publicOrigin: "http://localhost:8787", remoteOn: false }))).toEqual({ remote: false, local: "computer", default: "local" });
  });

  it("refuses anything but local or remote", () => {
    expect(linkOrigin(maker(), "anywhere")).toMatchObject({ status: 400 });
    expect(linkOrigin(maker(), 1)).toMatchObject({ status: 400 });
  });
});
