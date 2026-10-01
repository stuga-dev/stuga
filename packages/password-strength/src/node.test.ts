/** The rule in Node: the table jsdom.test.ts holds a browser to, and the cheap test first. */
import { describe, expect, it, vi } from "vitest";

const check = vi.fn();
vi.mock("@zxcvbn-ts/core", async (orig) => {
  const real = await orig<typeof import("@zxcvbn-ts/core")>();
  return {
    ...real,
    ZxcvbnFactory: class extends real.ZxcvbnFactory {
      override check(...args: Parameters<InstanceType<typeof real.ZxcvbnFactory>["check"]>) {
        check(...args);
        return super.check(...args);
      }
    },
  };
});
const { remotePasswordOk, strengthInputs } = await import("./index.js");
const { PARITY, PARITY_INPUTS } = await import("./parity.fixture.js");

describe("in Node", () => {
  it("scores the table jsdom.test.ts checks in a browser", () => {
    const inputs = strengthInputs(PARITY_INPUTS);
    for (const [pw, ok, score] of PARITY) expect(remotePasswordOk(pw, inputs), pw).toMatchObject({ ok, score });
  });

  it("never asks zxcvbn about a password short of the length, the cheap test first", () => {
    check.mockClear();
    remotePasswordOk("fourteen chars", []);
    expect(check).not.toHaveBeenCalled();
    remotePasswordOk("fifteen chars!!", []);
    expect(check).toHaveBeenCalledOnce();
  });
});
