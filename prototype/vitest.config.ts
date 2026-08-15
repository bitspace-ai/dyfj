import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  server: {
    fs: {
      strict: true,
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
