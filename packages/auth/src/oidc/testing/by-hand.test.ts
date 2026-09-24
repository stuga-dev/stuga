/**
 * CONTRIBUTING's way to try the sign-in flow by hand,
 * `pnpm --filter @stuga/auth exec tsx src/oidc/testing/mock-provider.ts --port <p>`,
 * runs on a tsx this package declares, not on one another package happens to install.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
  devDependencies?: Record<string, string>;
};

describe("the mock provider by hand", () => {
  it("has its runner declared by this package, and resolvable from it", () => {
    expect(pkg.devDependencies?.tsx).toMatch(/^\^4\./);
    const tsx = createRequire(import.meta.url).resolve("tsx/package.json");
    expect(tsx).toMatch(/[\\/]tsx[\\/]package\.json$/);
  });

  it("names a file that exists", () => {
    expect(existsSync(new URL("./mock-provider.ts", import.meta.url))).toBe(true);
  });
});
