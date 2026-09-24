import { describe, expect, it } from "vitest";
import type { DocRow } from "@stuga/db";
import { resolveReviewMode } from "./review-mode.js";
import type { Ctx } from "../auth/context.js";

const doc = (mode: DocRow["agent_mode"]) => ({ agent_mode: mode }) as DocRow;
const ctx = (isAgent: boolean) => ({ isAgent }) as Ctx;

describe("resolveReviewMode", () => {
  it("parks an agent's proposal on a `review` document", () => {
    expect(resolveReviewMode(ctx(true), doc("review"))).toMatchObject({ mode: "review" });
  });

  it("lands it on an `auto` document", () => {
    const out = resolveReviewMode(ctx(true), doc("auto"));
    expect(out.mode).toBe("auto");
    expect(out.reason).toContain("apply agent changes at once");
  });

  it("a human session parks whatever the document says", () => {
    expect(resolveReviewMode(ctx(false), doc("auto"))).toMatchObject({ mode: "review", reason: "a human session" });
    expect(resolveReviewMode(ctx(false), doc("review"))).toMatchObject({ mode: "review" });
  });
});
