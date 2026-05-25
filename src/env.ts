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
  // auth-worker と共有する HS256 JWT 署名鍵。Workers secret (Secrets Store 移行は別 PR)
  // で投入する: `npx wrangler secret put JWT_SECRET` で auth-worker と同じ値を貼る。
  // 未設定でも Bearer 認証は動く (= 部分起動)、cookie 認証が無効化されるだけ。
  JWT_SECRET?: string;
  R2: R2Bucket;
  DB: D1Database;
}

/**
 * UI / API へのアクセスを許可する email 一覧。auth-worker が発行する JWT の
 * `email` claim と完全一致比較する。CLAUDE.md 個人ツール前提のため、ここで
 * 固定。将来増やすなら array literal を編集する (= source-controlled allow list)。
 */
export const ALLOWED_EMAILS = ["m.tama.ramu@gmail.com"] as const;

export async function readUploadToken(env: Env): Promise<string> {
  const t = env.UPLOAD_TOKEN;
  return typeof t === "string" ? t : await t.get();
}

export type AppEnv = { Bindings: Env };
