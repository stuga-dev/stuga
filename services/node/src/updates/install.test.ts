import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readInstallStatus, requestInstall } from "./install.js";

const dirs: string[] = [];
function helper() {
  const dir = mkdtempSync(join(tmpdir(), "stuga-helper-"));
  dirs.push(dir);
  return { requests: dir, status: join(dir, "upgrade.json") };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("asking the upgrade helper", () => {
  it("drops the version, whole, as the one request file", async () => {
    const h = helper();
    await requestInstall(h, "1.4.2");
    expect(readdirSync(h.requests)).toEqual(["upgrade"]);
    expect(readFileSync(join(h.requests, "upgrade"), "utf8")).toBe("1.4.2\n");
  });

  it("asks for nothing but a release version", async () => {
    await expect(requestInstall(helper(), "1.4.2; rm -rf /")).rejects.toThrow(/not a release version/);
  });

  it("reads what the helper reported, and nothing it cannot make sense of", async () => {
    const h = helper();
    expect(await readInstallStatus(h)).toBeNull();
    writeFileSync(h.status, JSON.stringify({ version: "1.4.2", state: "installing", message: "installing Stuga 1.4.2", at: "2026-09-23T06:00:00Z" }));
    expect(await readInstallStatus(h)).toEqual({ version: "1.4.2", state: "installing", message: "installing Stuga 1.4.2", at: "2026-09-23T06:00:00Z" });
    writeFileSync(h.status, JSON.stringify({ state: "exploded" }));
    expect(await readInstallStatus(h)).toBeNull();
    writeFileSync(h.status, "not json");
    expect(await readInstallStatus(h)).toBeNull();
  });
});
