/**
 * auth-worker (auth.ippoan.org) が発行する HS256 JWT を検証する。
 * 検証本体は `@ippoan/mcp-cf-workers` の `./auth` export (`verifyHs256Jwt`) を
 * 消費する — 旧来の「auth-worker/src/lib/jwt.ts と等価 (sync で維持する)」
 * 手動コピーを解消 (Refs ippoan/mcp-cf-workers#46)。
 * `JWT_SECRET` は auth-worker と物理的に同じ値を Workers secret で持つ。
 *
 * 本 repo の契約 (null-on-fail / exp 必須 / skew なし) は wrapper で維持する。
 *
 * Refs ippoan/HealthConnectReaderWorker#15
 */
// barrel (./auth) は jose 依存の cf-access / mcp-jwt を re-export するため、
// jose を持たない本 repo は subpath export を直接 import する。
import {
  verifyHs256Jwt,
  type Hs256BaseClaims,
} from "@ippoan/mcp-cf-workers/auth/hs256-jwt";

export interface JwtPayload {
  exp?: number;
  email?: string;
  [key: string]: unknown;
}

/**
 * HS256 JWT を検証して payload を返す。失敗時は null。
 * - malformed / wrong alg / wrong sig / 期限切れ / exp 未設定 は null
 */
export async function verifyJwt(
  token: string,
  secret: string,
): Promise<JwtPayload | null> {
  try {
    // clockToleranceSec: 0 — 旧ローカル実装は skew なしで exp を判定していた
    // ため、認可 window を広げない (lib default は 30s)。
    return await verifyHs256Jwt<Hs256BaseClaims>(token, secret, {
      clockToleranceSec: 0,
    });
  } catch {
    return null;
  }
}

/**
 * Cookie ヘッダから `logi_auth_token` を抽出する。
 * auth-worker の `setAuthCookie` は `Domain=.ippoan.org` で発行するので、
 * `hcreader.ippoan.org` への request にも自動で乗ってくる。
 */
export function getAuthCookieFromHeader(cookieHeader: string): string | null {
  const m = /logi_auth_token=([^;]+)/.exec(cookieHeader);
  return m?.[1] ?? null;
}
