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
  // auth-worker と共有する HS256 JWT 署名鍵。CF Secrets Store binding 経由で
  // 受け取り、production では `{ get(): Promise<string> }` 形になる。vitest からは
  // plain string を inject するので union 型にしてある。未設定でも Bearer 認証は
  // 動く (= cookie 経路だけが無効化される)。
  JWT_SECRET?: SecretsStoreBinding | string;
  R2: R2Bucket;
  DB: D1Database;
  // auth-worker と共有する内部認証 token。auth-worker の Google Health OAuth
  // callback が `/api/ghapi/store-tokens` に refresh_token を POST 転送するとき
  // の Bearer。両 worker に同じ値を投入する。Refs #60
  INTERNAL_SHARED_SECRET?: SecretsStoreBinding | string;
  // Google から webhook (`POST /api/ghapi/webhook`) が来るとき、subscription
  // 作成時に endpointAuthorization として登録した値が `Authorization: Bearer`
  // で送られる。これと一致しなければ 401。Refs #60
  GHAPI_WEBHOOK_AUTH_TOKEN?: SecretsStoreBinding | string;
  // Google Health 用 OAuth Client。token refresh (refresh_token → access_token)
  // で使う。auth-worker と同じ値を持たせる (= 同じ Client を共有)。Refs #60
  GOOGLE_HEALTH_CLIENT_ID?: SecretsStoreBinding | string;
  GOOGLE_HEALTH_CLIENT_SECRET?: SecretsStoreBinding | string;
  // GhapiSubscriberDO の binding。idFromName("default") 固定 (= 1 user 運用)。
  // Refs #60
  GHAPI_SUBSCRIBER?: DurableObjectNamespace;
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

export async function readJwtSecret(env: Env): Promise<string> {
  const s = env.JWT_SECRET;
  if (!s) return "";
  return typeof s === "string" ? s : await s.get();
}

async function readOptionalSecret(
  v: SecretsStoreBinding | string | undefined,
): Promise<string> {
  if (!v) return "";
  return typeof v === "string" ? v : await v.get();
}

export const readInternalSharedSecret = (env: Env): Promise<string> =>
  readOptionalSecret(env.INTERNAL_SHARED_SECRET);

export const readGhapiWebhookAuthToken = (env: Env): Promise<string> =>
  readOptionalSecret(env.GHAPI_WEBHOOK_AUTH_TOKEN);

export const readGoogleHealthClientId = (env: Env): Promise<string> =>
  readOptionalSecret(env.GOOGLE_HEALTH_CLIENT_ID);

export const readGoogleHealthClientSecret = (env: Env): Promise<string> =>
  readOptionalSecret(env.GOOGLE_HEALTH_CLIENT_SECRET);

export type AppEnv = { Bindings: Env };
