/**
 * healthconnectreader-worker — WebView UI + R2 backend for ippoan/HealthConnectReader.
 *
 *   GET  /                  → static HTML UI (Tailwind CDN) — PWA shell
 *   GET  /manifest.json     → Web App Manifest (install 可能化)
 *   GET  /sw.js             → minimal service worker (install 条件を満たすため)
 *   POST /api/upload        → Bearer → PUT R2 hc/{yyyy}/{mm-dd}.json (today)
 *   POST /api/upload-batch  → Bearer → split { days: [{date, payload}] } into N day files
 *   POST /api/upload-zones  → Bearer → iOS Zones (Apple Watch) workout JSON 1 件を
 *                              zones/{yyyy}/{mm}-{dd}/{uuid}.json に保存
 *   GET  /api/history       → Bearer → { count, latest } (hc/ のみ)
 *   GET  /api/zones         → Bearer → { count, items[] } Zones アップロード履歴
 *   POST /_admin/migrate    → Bearer → applySchema() で D1 schema を idempotent に適用
 *
 * Refs ippoan/HealthConnectReader#6
 * Refs ippoan/HealthConnectReaderWorker#9
 */
import { Hono } from "hono";

import { bearerAuth } from "./auth";
import { listZonesFromDb, upsertWorkout, zonesPayloadToRow } from "./db";
import type { AppEnv } from "./env";
import { applySchema } from "./migrations";
import {
  summarizeHistory,
  uploadKeyFor,
  uploadKeyForDateString,
  zonesKeyFor,
} from "./r2";
import { FAVICON_ICO_BYTES, INDEX_HTML, MANIFEST_JSON, SERVICE_WORKER_JS } from "./ui";

const app = new Hono<AppEnv>();

app.get("/health", (c) =>
  c.json({ ok: true, env: c.env.WORKER_ENV, version: "0.1.0" }),
);

app.get("/", (c) => c.html(INDEX_HTML));

app.get("/manifest.json", () =>
  new Response(MANIFEST_JSON, {
    headers: { "content-type": "application/manifest+json; charset=utf-8" },
  }),
);

app.get("/sw.js", () =>
  new Response(SERVICE_WORKER_JS, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      // SW は常に最新を取りに行く: cache 効くと更新が刺さらない
      "cache-control": "no-cache",
    },
  }),
);

app.get("/favicon.ico", () =>
  new Response(FAVICON_ICO_BYTES, {
    headers: {
      "content-type": "image/x-icon",
      "cache-control": "public, max-age=86400",
    },
  }),
);

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
 *
 * Default は **incremental backfill**: R2 に同 key が既に存在する day は skip し、
 * 未存在の day だけ R2.put する。client が毎日 30-day batch を投げても R2 書込量は
 * 増えない (Refs ippoan/HealthConnectReaderWorker#7)。
 *
 * `?force=true` を付けると旧来通り全部 overwrite (full backfill)。
 *
 * date が不正 / payload が object でない要素は skipped[] に積み、`written` 0 + 全要素
 * 無効なら 400。skip 理由は `invalid_date` / `payload_not_object` / `not_object` /
 * `date_not_string` / `already_exists` (新規)。
 */
app.post("/api/upload-batch", bearerAuth, async (c) => {
  const force = c.req.query("force") === "true";
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

  // Phase 1: validate / build write plan (without hitting R2 yet)
  type Plan = { index: number; key: string; body: string };
  const plan: Plan[] = [];
  const skipped: Array<{ index: number; reason: string; key?: string }> = [];
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
    plan.push({ index: i, key: k.key, body: JSON.stringify(payload) });
  }

  // Phase 2: in incremental mode (= !force), drop entries whose key already
  // exists in R2. We `head()` in parallel; non-existent returns null.
  if (!force && plan.length > 0) {
    const heads = await Promise.all(plan.map((p) => c.env.R2.head(p.key)));
    const filtered: Plan[] = [];
    for (let i = 0; i < plan.length; i++) {
      if (heads[i] === null) {
        filtered.push(plan[i]);
      } else {
        skipped.push({ index: plan[i].index, reason: "already_exists", key: plan[i].key });
      }
    }
    plan.length = 0;
    plan.push(...filtered);
  }

  // Phase 3: write the remaining plan. We treat "0 to write" as success when
  // there were valid days (= all already existed) and 400 only when nothing
  // could be parsed in the first place.
  const anyValidInput = plan.length + skipped.filter(
    (s) => s.reason === "already_exists",
  ).length > 0;
  if (!anyValidInput) {
    return c.json({ error: "no_valid_days", skipped }, 400);
  }

  const keys = plan.map((p) => p.key);
  await Promise.all(
    plan.map((p) =>
      c.env.R2.put(p.key, p.body, {
        httpMetadata: { contentType: "application/json" },
      }),
    ),
  );
  return c.json({ ok: true, written: plan.length, keys, skipped, force });
});

/**
 * `POST /api/upload-zones` — iOS Zones (Apple Watch) workout export を 1 件保存。
 * body: Zones JSON そのまま (top-level に `uuid` と `startDate` を含むこと)
 * R2 key は `zones/{yyyy}/{mm}-{dd}/{uuid}.json` (UTC `startDate` 由来)
 * uuid が重複したら overwrite (= 同一 workout の再 upload は idempotent)
 */
app.post("/api/upload-zones", bearerAuth, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "expected_object" }, 400);
  }
  const uuid = (body as { uuid?: unknown }).uuid;
  const startDate = (body as { startDate?: unknown }).startDate;
  if (typeof uuid !== "string") {
    return c.json({ error: "missing_uuid" }, 400);
  }
  if (typeof startDate !== "string") {
    return c.json({ error: "missing_startDate" }, 400);
  }
  const k = zonesKeyFor(startDate, uuid);
  if (!k) {
    return c.json({ error: "invalid_uuid_or_startDate" }, 400);
  }
  const date = `${k.yyyy}-${k.mmdd}`;
  const uploadedAt = new Date().toISOString();
  // R2 への raw 保存と D1 への metadata upsert を並列実行。どちらかが失敗しても
  // partial state を残しうるが、再 upload で再現可能 (upsert は idempotent) なので
  // 個別 retry はしない。Throw は Hono の onError で 500 化される。
  await Promise.all([
    c.env.R2.put(k.key, JSON.stringify(body), {
      httpMetadata: { contentType: "application/json" },
    }),
    upsertWorkout(
      c.env.DB,
      zonesPayloadToRow(body as Record<string, unknown>, k.key, date, uploadedAt),
    ),
  ]);
  return c.json({
    ok: true,
    key: k.key,
    date,
    uuid,
  });
});

app.get("/api/history", bearerAuth, async (c) => {
  const summary = await summarizeHistory(c.env.R2);
  return c.json(summary);
});

/**
 * `POST /_admin/migrate` — D1 schema を applySchema() で適用する。
 *
 * Worker 内から DB binding 経由で実行するので CF API token に D1:Edit 権限
 * が不要 (= deploy 用 token のままで OK)。schema は `src/migrations.ts` の
 * `SCHEMA_STATEMENTS` が source of truth、すべて `IF NOT EXISTS` なので
 * 何度叩いても idempotent。
 *
 * 運用フロー (Refs ippoan/HealthConnectReaderWorker#11):
 *   1. `wrangler deploy` で新 schema を持つコードを上げる
 *   2. 1 回だけ `curl -X POST .../_admin/migrate -H "Authorization: Bearer $TOKEN"`
 *   3. schema 変更が無い回は 200 が返るだけ (no-op)
 */
app.post("/_admin/migrate", bearerAuth, async (c) => {
  const result = await applySchema(c.env.DB);
  return c.json({ ok: true, ...result });
});

/**
 * `GET /api/zones` — Zones workout のアップロード履歴を返す。
 * D1 `workouts` テーブル (source='zones') から uploaded_at desc で取得。
 * shape は従来通り `{ count, items: [{date, uuid, key, uploaded}] }`。
 */
app.get("/api/zones", bearerAuth, async (c) => {
  const items = await listZonesFromDb(c.env.DB);
  return c.json({ count: items.length, items });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  console.error("[healthconnectreader-worker]", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

export default app;
