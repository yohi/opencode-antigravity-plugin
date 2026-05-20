import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "tests/ts/backend.test.ts",
      "tests/ts/integration.test.ts",
    ],
  },
});
