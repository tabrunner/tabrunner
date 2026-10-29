import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.tsx"],
    setupFiles: ["src/test-setup.ts"],
    // Schedules are wall-clock local, so "9am stays 9am across DST" is only a
    // real assertion in a zone that HAS a DST shift — pinned here so the check
    // means the same thing on a laptop in São Paulo and in CI on UTC.
    env: { TZ: "America/New_York" },
  },
});
