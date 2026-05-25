/**
 * healthconnectreader-worker — WebView UI + R2 backend for ippoan/HealthConnectReader.
 *
 *   GET  /             → static HTML UI (Tailwind CDN)
 *   POST /api/upload   → Bearer ${UPLOAD_TOKEN} → PUT R2 hc/{yyyy}/{mm-dd}.json
 *   GET  /api/history  → Bearer ${UPLOAD_TOKEN} → { count, latest }
 *
 * Refs ippoan/HealthConnectReader#6
 */
import { Hono } from "hono";

import { bearerAuth } from "./auth";
import type { AppEnv } from "./env";
import { summarizeHistory, uploadKeyFor } from "./r2";
import { INDEX_HTML } from "./ui";

const app = new Hono<AppEnv>();

app.get("/health", (c) =>
  c.json({ ok: true, env: c.env.WORKER_ENV, version: "0.1.0" }),
);

app.get("/", (c) => c.html(INDEX_HTML));

app.post("/api/upload", bearerAuth, async (c) => {
  const raw = await c.req.raw.arrayBuffer();
  if (raw.byteLength === 0) return c.json({ error: "empty_body" }, 400);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (parsed === null || typeof parsed !== "object") {
    return c.json({ error: "invalid_json" }, 400);
  }
  const { key, yyyy, mmdd } = uploadKeyFor(new Date());
  await c.env.R2.put(key, raw, {
    httpMetadata: { contentType: "application/json" },
  });
  return c.json({ ok: true, key, date: `${yyyy}-${mmdd}` });
});

app.get("/api/history", bearerAuth, async (c) => {
  const summary = await summarizeHistory(c.env.R2);
  return c.json(summary);
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  console.error("[healthconnectreader-worker]", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

export default app;
