import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageDirOf, thirdPartyLicenses } from "../third-party-licenses.mjs";

function tree() {
  const root = mkdtempSync(join(tmpdir(), "stuga-licenses-"));
  const pkg = (dir, json, files = {}) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(json));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, dir, name), text);
    return join(root, dir);
  };
  return { root, pkg };
}

test("finds the package a bundled file belongs to, scoped or not, through pnpm's store", () => {
  assert.equal(packageDirOf("/r/node_modules/.pnpm/a@1/node_modules/a/lib/x.js"), "/r/node_modules/.pnpm/a@1/node_modules/a");
  assert.equal(packageDirOf("/r/node_modules/@s/b/dist/y.mjs?commonjs-proxy"), "/r/node_modules/@s/b");
  assert.equal(packageDirOf("\0/r/node_modules/c/index.js"), "/r/node_modules/c");
  assert.equal(packageDirOf("/r/packages/protocol/src/x.ts"), null);
  assert.equal(packageDirOf("/r/node_modules/@s"), null);
});

test("lists each package once, sorted, with its license files in full", () => {
  const { root, pkg } = tree();
  try {
    const a = pkg("node_modules/zed", { name: "zed", version: "2.0.0", license: "MIT" }, { LICENSE: "MIT text for zed\n" });
    const b = pkg("node_modules/@s/alpha", { name: "@s/alpha", version: "1.0.0", license: "Apache-2.0" }, {
      "LICENSE.txt": "Apache text",
      NOTICE: "alpha notice",
      "README.md": "not a license",
    });
    const nested = pkg("node_modules/zed/esm", { type: "module" });
    const out = thirdPartyLicenses(
      [join(a, "index.js"), join(nested, "index.js"), join(b, "a.js"), join(b, "b.js"), join(root, "src/own.ts")],
      "Third-party software in a test bundle.",
    );
    assert.ok(out.startsWith("Third-party software in a test bundle.\n\n  @s/alpha 1.0.0: Apache-2.0\n  zed 2.0.0: MIT\n"));
    assert.equal(out.match(/zed 2\.0\.0: MIT/g).length, 2);
    assert.ok(out.includes("Apache text\n\nalpha notice"));
    assert.ok(out.includes("MIT text for zed"));
    assert.ok(!out.includes("not a license"));
    assert.ok(!out.includes("own.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("says so when a package ships no license file", () => {
  const { root, pkg } = tree();
  try {
    const dir = pkg("node_modules/bare", { name: "bare", version: "0.1.0", license: { type: "ISC" } });
    const out = thirdPartyLicenses([join(dir, "i.js")], "Heading");
    assert.ok(out.includes("bare 0.1.0: ISC"));
    assert.ok(out.includes("The package carries no license file; its package.json declares ISC."));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
