import { describe, expect, it } from "vitest";
import { AGENT_NOTICES_PER_HOUR, NoticeBudget, agentBudgetKey } from "./budget.js";

const HOUR = 3_600_000;

function budget() {
  const clock = { now: 1_000_000 };
  return { clock, b: new NoticeBudget(AGENT_NOTICES_PER_HOUR, () => clock.now) };
}

describe("NoticeBudget", () => {
  it("grants up to the hour's allowance, then part of a request, then none", () => {
    const { b } = budget();
    expect(b.reserve("ws1\nu_liv", 58)).toBe(58);
    expect(b.reserve("ws1\nu_liv", 5)).toBe(2);
    expect(b.reserve("ws1\nu_liv", 1)).toBe(0);
  });

  it("gives each notice back an hour after it was granted", () => {
    const { b, clock } = budget();
    expect(b.reserve("ws1\nu_liv", 40)).toBe(40);
    clock.now += HOUR / 2;
    expect(b.reserve("ws1\nu_liv", 40)).toBe(20);
    clock.now += HOUR / 2;
    // The first 40 are an hour old now; the last 20 are not.
    expect(b.reserve("ws1\nu_liv", 60)).toBe(40);
  });

  it("keeps each person's allowance in each workspace apart", () => {
    const { b } = budget();
    expect(b.reserve(agentBudgetKey("ws1", "u_liv"), 60)).toBe(60);
    expect(b.reserve(agentBudgetKey("ws1", "u_bob"), 1)).toBe(1);
    expect(b.reserve(agentBudgetKey("ws2", "u_liv"), 1)).toBe(1);
  });

  it("spends nothing on a request for none", () => {
    const { b } = budget();
    expect(b.reserve("ws1\nu_liv", 0)).toBe(0);
    expect(b.reserve("ws1\nu_liv", 60)).toBe(60);
  });
});
