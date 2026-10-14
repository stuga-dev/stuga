import { describe, expect, it } from "vitest";
import { stripCitationMarkers } from "./citation-markers.js";

describe("stripCitationMarkers", () => {
  it("drops each marker with the space before it", () => {
    expect(stripCitationMarkers("Freestanding tubs need no tiling [^1]. Built-in ones do[^2].")).toBe(
      "Freestanding tubs need no tiling. Built-in ones do.",
    );
  });

  it("leaves no trailing space on a line that ended in a marker", () => {
    expect(stripCitationMarkers("One [^1]\nTwo")).toBe("One\nTwo");
  });
});
