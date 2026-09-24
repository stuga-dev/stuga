import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The integration suites share one database and truncate its tables, so files run one at a time.
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
  },
});
