import type { Context, MiddlewareHandler } from "hono";

import { timingSafeEqual } from "@ippoan/mcp-cf-workers/auth";

import {
  ALLOWED_EMAILS,
  readJwtSecret,
  readUploadToken,
  type AppEnv,
  type Env,
} from "./env";
import { getAuthCookieFromHeader, verifyJwt } from "./jwt";

/**
 * `apiAuth` — `/api/*` と `/_admin/*` の保護。
 *
 * 受理する 2 経路 (どちらかが通れば OK):
 *   (a) `Authorization: Bearer <UPLOAD_TOKEN>` — Android / iOS ショートカット / CI
 *   (b) auth-worker JWT cookie `logi_auth_token` + `email` ∈ ALLOWED_EMAILS — PWA / ブラウザ
 *
 * `UPLOAD_TOKEN` 未設定なら 500 (deploy 漏れを fail-loud にする)。
 * `JWT_SECRET` 未設定 (例: 初回 deploy 直後) は cookie 経路だけが無効化、
 * Bearer 経路は引き続き動く。
 *
 * 値は 1 request の中だけで使い回し、log にも response にも echo しない。
 *
 * Refs ippoan/HealthConnectReaderWorker#15
 */
export const apiAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = await readUploadToken(c.env);
  if (!expected) return c.json({ error: "server_misconfigured" }, 500);

  // (a) Bearer header — lib の timingSafeEqual は HMAC 固定長化で長さも秘匿する
  // (旧ローカル実装は長さ不一致の早期 return で微リークがあった)。
  const header = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (m && (await timingSafeEqual(m[1]!, expected))) {
    return next();
  }

  // (b) JWT cookie
  if (await verifyAuthCookie(c.env, c.req.header("cookie") ?? "")) {
    return next();
  }

  return c.json({ error: "unauthorized" }, 401);
};

/**
 * 旧名のエクスポート (後方互換用)。中身は apiAuth と同じ。
 */
export const bearerAuth = apiAuth;

/**
 * Cookie ヘッダから `logi_auth_token` を取り出して検証する。
 * payload.email が ALLOWED_EMAILS に含まれれば true。
 */
export async function verifyAuthCookie(
  env: Env,
  cookieHeader: string,
): Promise<boolean> {
  const jwt = getAuthCookieFromHeader(cookieHeader);
  if (!jwt) return false;
  const secret = await readJwtSecret(env);
  if (!secret) return false;
  const payload = await verifyJwt(jwt, secret);
  if (!payload) return false;
  const email = typeof payload.email === "string" ? payload.email : "";
  return (ALLOWED_EMAILS as readonly string[]).includes(email);
}

export type _Ctx = Context<AppEnv>;
