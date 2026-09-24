import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The whole-document fixture tests take seconds and share the machine with every other package's suite.
    testTimeout: 30_000,
  },
});
