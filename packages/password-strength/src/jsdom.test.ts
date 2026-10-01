// @vitest-environment jsdom
/** The web app runs the rule in a browser: the same input scores the same there as on the node. */
import { describe, expect, it } from "vitest";
import { remotePasswordOk, strengthInputs } from "./index.js";
import { PARITY, PARITY_INPUTS } from "./parity.fixture.js";

describe("in a browser", () => {
  it("scores as the node does", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("object");
    const inputs = strengthInputs(PARITY_INPUTS);
    for (const [pw, ok, score] of PARITY) expect(remotePasswordOk(pw, inputs), pw).toMatchObject({ ok, score });
  });
});
