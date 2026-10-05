import { describe, expect, it } from "vitest";
import { takenBeforeUpgrade } from "./manifest.js";

const taken = (stuga_version: string | null, runtime_version: string) => takenBeforeUpgrade({ stuga_version, runtime_version });

describe("takenBeforeUpgrade", () => {
  it("is a newer release's backup of an older release's data", () => {
    expect(taken("1.0.0", "1.1.0")).toBe(true);
    expect(taken("0.1.9", "0.1.10")).toBe(true);
  });

  it("is not an older release's backup of a newer one's data, nor one version's of its own", () => {
    expect(taken("1.1.0", "1.0.0")).toBe(false);
    expect(taken("1.0.0", "1.0.0")).toBe(false);
    expect(taken(null, "1.0.0")).toBe(false);
  });

  it("is any backup a build from source took of another build's data, or of its data by another build", () => {
    expect(taken("0.0.0-dev", "1.0.0")).toBe(true);
    expect(taken("1.0.0", "0.0.0-dev")).toBe(true);
  });
});
