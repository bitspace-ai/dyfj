import { defineConfig } from "vitest/config";

// Exclude pi-ai-dependent tests pending retirement per ADR-0002 (skip pi-ai
// port). router.test.ts depends on src/router.ts which imports from
// @mariozechner/pi-ai; both are scheduled for in-place retirement when the
// own-provider-abstraction lands. They remain in the tree as historical
// reference until then.
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/router.test.ts",
    ],
  },
});
