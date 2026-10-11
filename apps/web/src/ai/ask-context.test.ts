import { describe, expect, it } from "vitest";
import { storedTurnNotice } from "./ask-context";

describe("storedTurnNotice", () => {
  it("says a turn left mid-answer stopped, and marks it to be asked again", () => {
    expect(storedTurnNotice("aborted")).toEqual({ notice: "Stopped.", stopped: true });
  });

  it("words the other early endings as the live answer does, without offering Try again", () => {
    expect(storedTurnNotice("budget")).toEqual({ notice: "The AI budget ran out part-way through the answer.", stopped: false });
    expect(storedTurnNotice("error").stopped).toBeUndefined();
    expect(storedTurnNotice("error").notice).toBeTruthy();
  });

  it("adds nothing to a finished turn", () => {
    expect(storedTurnNotice("complete")).toEqual({});
    expect(storedTurnNotice(undefined)).toEqual({});
  });
});
