import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      coverage: {
        provider: "istanbul" as const,
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
            d1Databases: ["DB"],
            bindings: {
              WORKER_ENV: "test",
              UPLOAD_TOKEN: "test-upload-token",
              // applyD1Migrations が読む。schema を JSON 化して binding 経由で渡す
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});
