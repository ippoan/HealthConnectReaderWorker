// CF Secrets Store binding (`secrets_store_secrets`) is exposed in production
// as an **object with async `.get()`**, not a plain string. The earlier
// `string` type silently coerced to "[object Object]" and broke
// `timingSafeEqual` (every Bearer check returned 401). See:
//   https://developers.cloudflare.com/secrets-store/integrations/workers/
//
// In vitest (miniflare doesn't yet have a Secrets Store provider) we still
// inject a plain string via `bindings: { UPLOAD_TOKEN: "test-..." }`, so the
// type accepts both shapes and the consumer side normalises via
// `readUploadToken()` below.
export type SecretsStoreBinding = { get(): Promise<string> };

export interface Env {
  WORKER_ENV: string;
  UPLOAD_TOKEN: SecretsStoreBinding | string;
  R2: R2Bucket;
  DB: D1Database;
}

export async function readUploadToken(env: Env): Promise<string> {
  const t = env.UPLOAD_TOKEN;
  return typeof t === "string" ? t : await t.get();
}

export type AppEnv = { Bindings: Env };
