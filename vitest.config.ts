import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    coverage: {
      provider: "istanbul",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/ui.ts", "src/index.ts"],
    },
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: "2024-12-01",
          compatibilityFlags: ["nodejs_compat"],
          r2Buckets: ["R2"],
          bindings: {
            WORKER_ENV: "test",
            UPLOAD_TOKEN: "test-upload-token",
          },
        },
      },
    },
  },
});
