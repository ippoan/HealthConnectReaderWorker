/**
 * healthconnectreader-worker — WebView UI + R2 backend for ippoan/HealthConnectReader.
 *
 *   GET  /                  → static HTML UI (Tailwind CDN)
 *   POST /api/upload        → Bearer → PUT R2 hc/{yyyy}/{mm-dd}.json (today)
 *   POST /api/upload-batch  → Bearer → split { days: [{date, payload}] } into N day files
 *   GET  /api/history       → Bearer → { count, latest }
 *
 * Refs ippoan/HealthConnectReader#6
 */
import { Hono } from "hono";

import { bearerAuth } from "./auth";
import type { AppEnv } from "./env";
import { summarizeHistory, uploadKeyFor, uploadKeyForDateString } from "./r2";
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

/**
 * `POST /api/upload-batch` — body: { days: [{ date: "YYYY-MM-DD", payload: <object> }] }
 * 過去 N 日分を 1 リクエストで投入する。各 day を hc/{yyyy}/{mm-dd}.json に分割保存。
 * date が不正 / payload が object でない要素は skip され、書き込み件数のみ counts に返す。
 * 全 day が不正なら 400 を返す (= partial-only でも 200 を返さないと client が判断できない)。
 */
app.post("/api/upload-batch", bearerAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (
    body === null ||
    typeof body !== "object" ||
    !Array.isArray((body as { days?: unknown }).days)
  ) {
    return c.json({ error: "expected_days_array" }, 400);
  }
  const days = (body as { days: unknown[] }).days;
  if (days.length === 0 || days.length > 366) {
    return c.json({ error: "days_length_out_of_range" }, 400);
  }
  const writes: Array<Promise<void>> = [];
  const keys: string[] = [];
  const skipped: Array<{ index: number; reason: string }> = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (d === null || typeof d !== "object") {
      skipped.push({ index: i, reason: "not_object" });
      continue;
    }
    const dateStr = (d as { date?: unknown }).date;
    const payload = (d as { payload?: unknown }).payload;
    if (typeof dateStr !== "string") {
      skipped.push({ index: i, reason: "date_not_string" });
      continue;
    }
    const k = uploadKeyForDateString(dateStr);
    if (!k) {
      skipped.push({ index: i, reason: "invalid_date" });
      continue;
    }
    if (payload === null || typeof payload !== "object") {
      skipped.push({ index: i, reason: "payload_not_object" });
      continue;
    }
    const body = JSON.stringify(payload);
    writes.push(
      c.env.R2.put(k.key, body, {
        httpMetadata: { contentType: "application/json" },
      }).then(() => undefined),
    );
    keys.push(k.key);
  }
  if (writes.length === 0) {
    return c.json({ error: "no_valid_days", skipped }, 400);
  }
  await Promise.all(writes);
  return c.json({ ok: true, written: writes.length, keys, skipped });
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
