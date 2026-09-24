import { describe, expect, it } from "vitest";
import {
  RESERVED_USERNAMES,
  isEmailShaped,
  isReservedUsername,
  isValidUsername,
  normalizeUsername,
  usernameBase,
  usernameCandidates,
  usernameSource,
} from "./username";

describe("usernames", () => {
  it("normalizes case and surrounding space", () => {
    expect(normalizeUsername("  Ada.Lovelace ")).toBe("ada.lovelace");
  });

  it("accepts short handles with dots, dashes and underscores", () => {
    for (const ok of ["ad", "ada", "ada.l", "a_d-a", "0xada", "a".repeat(32)]) expect(isValidUsername(ok)).toBe(true);
  });

  it("refuses what could not be typed back or confused with an email", () => {
    for (const bad of ["a", "", ".ada", "-ada", "ada lovelace", "Ada", "ada@example.com", "a".repeat(33), "ada\n"]) {
      expect(isValidUsername(bad)).toBe(false);
    }
  });
});

describe("reserved usernames", () => {
  it("reserves the names that read as the node or its staff, by exact match only", () => {
    for (const name of ["admin", "administrator", "root", "stuga", "support", "security", "abuse", "postmaster", "system", "api", "www", "me", "null", "undefined"]) {
      expect(isReservedUsername(name)).toBe(true);
    }
    expect(isReservedUsername("admin-2")).toBe(false);
    expect(isReservedUsername("ada")).toBe(false);
    expect(RESERVED_USERNAMES.every((name) => isValidUsername(name))).toBe(true);
  });
});

describe("username suggestions", () => {
  it("derives a valid base from what a provider or a person offers", () => {
    expect(usernameBase("Ada.Lovelace")).toBe("ada.lovelace");
    expect(usernameBase("ada@example.com")).toBe("ada");
    expect(usernameBase("José Álvarez")).toBe("jose-alvarez");
    expect(usernameBase("  --Ada   Lovelace!!  ")).toBe("ada-lovelace");
    expect(usernameBase("a..b__c")).toBe("a.b_c");
  });

  it("falls back to user when nothing usable is left", () => {
    for (const raw of ["", null, undefined, "李雷", "a", "---", "_"]) expect(usernameBase(raw)).toBe("user");
  });

  it("leaves room for a suffix", () => {
    const base = usernameBase("x".repeat(60));
    expect(base.length).toBe(28);
    for (const name of usernameCandidates(base, 12)) expect(isValidUsername(name)).toBe(true);
  });

  it("offers base, base-2, base-3 … and never a reserved name", () => {
    expect(usernameCandidates("ada", 3)).toEqual(["ada", "ada-2", "ada-3"]);
    expect(usernameCandidates("admin", 3)).toEqual(["admin-2", "admin-3"]);
  });

  it("counts on from a name that already ends in a counter, instead of adding a second one", () => {
    expect(usernameCandidates("admin-2", 3)).toEqual(["admin-2", "admin-3", "admin-4"]);
    expect(usernameCandidates("ada-9", 2)).toEqual(["ada-9", "ada-10"]);
    // A year, or a zero, is part of the name.
    expect(usernameCandidates("liv-1990", 2)).toEqual(["liv-1990", "liv-1990-2"]);
    expect(usernameCandidates("r2-0", 2)).toEqual(["r2-0", "r2-0-2"]);
  });

  it("starts from the preferred username, then the email, then the name", () => {
    expect(usernameSource({ preferredUsername: "ada", email: "x@y.z", name: "N" })).toBe("ada");
    expect(usernameSource({ preferredUsername: " ", email: "x@y.z", name: "N" })).toBe("x@y.z");
    expect(usernameSource({ name: "Ada Lovelace" })).toBe("Ada Lovelace");
    expect(usernameSource({})).toBe("");
  });
});

describe("isEmailShaped", () => {
  it("takes an address and refuses header injection", () => {
    expect(isEmailShaped("ada@example.com")).toBe(true);
    expect(isEmailShaped("ada@example.com\r\nRCPT TO:<x@y.z>")).toBe(false);
    expect(isEmailShaped("ada")).toBe(false);
  });
});
