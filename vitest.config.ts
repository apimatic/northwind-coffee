import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Test-only value; real secrets live in .dev.vars / `wrangler secret put`.
            CSRF_SECRET: "test-only-csrf-secret-0123456789abcdef",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
      // Request logs are expected; show console output only for failing tests.
      silent: "passed-only" as const,
    },
  };
});
