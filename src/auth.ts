import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";

export const bearerAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const expected = c.env.UPLOAD_TOKEN;
  if (!expected) return c.json({ error: "server_misconfigured" }, 500);
  const header = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || !timingSafeEqual(m[1], expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type _Ctx = Context<AppEnv>;
