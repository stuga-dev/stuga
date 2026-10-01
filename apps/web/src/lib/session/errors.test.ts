import { describe, expect, it } from "vitest";
import { AuthError, describeError } from "./errors";

describe("the sign-in refusals a remote address and its limits bring", () => {
  it("says each in words, the node's own where it carries the detail", () => {
    expect(describeError(new AuthError(401, "remote_password_weak", { detail: "x" }))).toBe(
      "From outside this network, sign in with a passkey or a password of 15 characters or more that is hard to guess.",
    );
    expect(describeError(new AuthError(429, "sign_in_paused", { detail: "Too many wrong passwords. Try again in 5 minutes." }))).toBe(
      "Too many wrong passwords. Try again in 5 minutes.",
    );
    expect(describeError(new AuthError(503, "busy"))).toBe("Stuga is busy. Try again in a few seconds.");
    expect(describeError(new AuthError(503, "service unavailable"))).toBe("Stuga is busy. Try again in a few seconds.");
    // The serving gate's 503 says why, as it always did.
    expect(describeError(new AuthError(503, "unavailable", { detail: "Stuga is upgrading." }))).toBe("Stuga is upgrading.");
    expect(describeError(new AuthError(403, "invite_local_only", { detail: "x" }))).toBe("This invite link works only on this node's network.");
    const off = "Passwords work here only from this node's network. From anywhere else, use https://k7f3q2.mystuga.com.";
    expect(describeError(new AuthError(403, "password_off_network", { detail: off }))).toBe(off);
    expect(describeError(new AuthError(403, "wrong_account"))).toBe("That isn’t the account signed in here.");
    expect(describeError(new AuthError(401, "reauth_required"))).toBe("Confirm it’s you to continue.");
    expect(describeError(new AuthError(401, "passkey_invalid", { detail: "x" }))).toBe("That passkey didn’t sign in here. Choose another, or use your password.");
    // Adding one that fails is not a sign-in.
    expect(describeError(new AuthError(400, "passkey_not_added", { detail: "x" }))).toBe("That passkey wasn’t added. Try again.");
    expect(describeError(new AuthError(409, "passkey_exists"))).toBe("That passkey is added already.");
    expect(describeError(new AuthError(409, "remote_off"))).toBe("Remote access is off, so the link can only open on this network.");
  });
});
