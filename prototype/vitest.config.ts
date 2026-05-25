import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    fs: {
      allow: ["."],
    },
  },
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
    ],
  },
});
