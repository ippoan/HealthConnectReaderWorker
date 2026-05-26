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

import { apiAuth, verifyAuthCookie } from "./auth";
import {
  groupAndMatch,
  hcPayloadToRows,
  listWorkoutsSinceDays,
  listZonesFromDb,
  upsertWorkout,
  zonesPayloadToRow,
} from "./db";
import { readUploadToken, type AppEnv } from "./env";
import { applySchema } from "./migrations";
import {
  summarizeHistory,
  uploadKeyFor,
  uploadKeyForDateString,
  zonesKeyFor,
} from "./r2";
import {
  FAVICON_ICO_BYTES,
  INDEX_HTML,
  MANIFEST_JSON,
  SERVICE_WORKER_JS,
  WORKOUT_DETAIL_HTML,
} from "./ui";

/**
 * auth-worker (`auth.ippoan.org`) のログイン画面に飛ばす URL を組む。
 * 戻り先は呼び元 URL の `${origin}/`、auth-worker が cookie を `.ippoan.org`
 * で発行するのでそのまま hcreader.ippoan.org にも送られる。
 */
function buildAuthLoginUrl(requestUrl: string): string {
  const u = new URL(requestUrl);
  const back = `${u.origin}/`;
  return `https://auth.ippoan.org/oauth/google/redirect?redirect_uri=${encodeURIComponent(back)}`;
}

const app = new Hono<AppEnv>();

app.get("/health", (c) =>
  c.json({ ok: true, env: c.env.WORKER_ENV, version: "0.1.0" }),
);

/**
 * `GET /` — UI を返す。auth 3 経路:
 *   (a) `Authorization: Bearer <UPLOAD_TOKEN>` 一致 → UI (Android WebView)
 *   (b) auth-worker JWT cookie が valid + email ∈ ALLOWED_EMAILS → UI (PWA/ブラウザ)
 *   (c) どちらも無し → auth-worker login へ 302 redirect
 *
 * Refs ippoan/HealthConnectReaderWorker#15
 */
app.get("/", async (c) => {
  // (a) Bearer
  const expected = await readUploadToken(c.env);
  if (expected) {
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m && constantTimeEqualStr(m[1], expected)) {
      return c.html(INDEX_HTML);
    }
  }
  // (b) JWT cookie
  if (await verifyAuthCookie(c.env, c.req.header("cookie") ?? "")) {
    return c.html(INDEX_HTML);
  }
  // (c) login redirect
  return c.redirect(buildAuthLoginUrl(c.req.url), 302);
});

function constantTimeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * `GET /workout` — 突合 detail ページ。Chart.js で速度推移 + HR zones を描画。
 * `?hc=<id>&zones=<id>` のいずれかは必須 (片方でも可)。auth は `/` と同じ。
 *
 * Refs ippoan/HealthConnectReaderWorker#18
 */
app.get("/workout", async (c) => {
  const expected = await readUploadToken(c.env);
  if (expected) {
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m && constantTimeEqualStr(m[1], expected)) {
      return c.html(WORKOUT_DETAIL_HTML);
    }
  }
  if (await verifyAuthCookie(c.env, c.req.header("cookie") ?? "")) {
    return c.html(WORKOUT_DETAIL_HTML);
  }
  return c.redirect(buildAuthLoginUrl(c.req.url), 302);
});

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

app.post("/api/upload", apiAuth, async (c) => {
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
  const date = `${yyyy}-${mmdd}`;
  await c.env.R2.put(key, raw, {
    httpMetadata: { contentType: "application/json" },
  });
  const indexed = await indexHcPayload(
    c.env.DB,
    parsed as Record<string, unknown>,
    key,
    date,
  );
  return c.json({ ok: true, key, date, indexed });
});

/**
 * existing R2 HC payload と incoming HC payload を merge する pure function。
 * sessions[] / distances[] / speeds[] を **id 同等性** で unique 化:
 *   - sessions: `startTime + "::" + exerciseType`
 *   - distances: `startTime + "::" + endTime`
 *   - speeds:    `startTime + "::" + endTime`
 *
 * 同 id があれば incoming を優先 (新しい source / title 更新が反映される)。
 * top-level field (date / collectedAt 等) は incoming を優先。
 *
 * Refs ippoan/HealthConnectReaderWorker#18
 */
interface MergedHcPayload extends Record<string, unknown> {
  sessions: unknown[];
  distances: unknown[];
  speeds: unknown[];
}

function mergeHcPayloads(
  existing: unknown,
  incoming: Record<string, unknown>,
): MergedHcPayload {
  const e = (existing && typeof existing === "object" && !Array.isArray(existing))
    ? existing as Record<string, unknown>
    : {};
  return {
    ...e,
    ...incoming,
    sessions: mergeByKey(e.sessions, incoming.sessions, (s) =>
      `${(s as { startTime?: unknown }).startTime}::${(s as { exerciseType?: unknown }).exerciseType}`),
    distances: mergeByKey(e.distances, incoming.distances, (d) =>
      `${(d as { startTime?: unknown }).startTime}::${(d as { endTime?: unknown }).endTime}`),
    speeds: mergeByKey(e.speeds, incoming.speeds, (s) =>
      `${(s as { startTime?: unknown }).startTime}::${(s as { endTime?: unknown }).endTime}`),
  };
}

function mergeByKey(
  existing: unknown,
  incoming: unknown,
  keyFn: (x: unknown) => string,
): unknown[] {
  const map = new Map<string, unknown>();
  if (Array.isArray(existing)) for (const x of existing) map.set(keyFn(x), x);
  if (Array.isArray(incoming)) for (const x of incoming) map.set(keyFn(x), x); // incoming 優先
  return [...map.values()];
}

/**
 * HC payload を D1 workouts に upsert する。R2 PUT 後に呼ぶ。
 * sessions[] を 1 row ずつ並列 upsert。0 件なら skip して 0 を返す。
 * 個別 upsert 失敗は throw → caller (Hono) で 500 化される。再 upload で
 * 同じ row が出来るので部分失敗の retry は不要。
 *
 * Refs ippoan/HealthConnectReaderWorker#18
 */
async function indexHcPayload(
  db: D1Database,
  payload: Record<string, unknown>,
  rawKey: string,
  date: string,
): Promise<number> {
  const rows = await hcPayloadToRows(
    payload,
    rawKey,
    date,
    new Date().toISOString(),
  );
  if (rows.length === 0) return 0;
  // D1 への並列 upsert は workerd 上で row が落ちる race があるため逐次。
  for (const row of rows) {
    await upsertWorkout(db, row);
  }
  return rows.length;
}

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
app.post("/api/upload-batch", apiAuth, async (c) => {
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

  // Phase 2: in incremental mode (= !force), MERGE incoming sessions/distances/
  // speeds into the existing R2 payload. これは「ファイル存在チェック」だけだと
  // Health Connect が後から sync した新しい session が R2 に届かない問題
  // (Refs #18 / R2: 5/26 朝 HC が hc/2026/05-25.json に反映されない) を解消する。
  //
  // 動作:
  //   - existing R2 payload を fetch → JSON parse
  //   - sessions[] / distances[] / speeds[] を id (startTime+...) で unique 化して
  //     incoming と merge
  //   - merge 結果が existing と同じなら skip (= no_change)
  //   - 異なれば merge 結果を新 body として書き戻す
  if (!force && plan.length > 0) {
    const heads = await Promise.all(plan.map((p) => c.env.R2.get(p.key)));
    const filtered: Plan[] = [];
    for (let i = 0; i < plan.length; i++) {
      const existing = heads[i];
      if (existing === null) {
        filtered.push(plan[i]);
        continue;
      }
      // existing が壊れた JSON なら incoming で overwrite (= 安全側)
      let existingPayload: unknown;
      try { existingPayload = JSON.parse(await existing.text()); }
      catch { filtered.push(plan[i]); continue; }
      const incomingPayload = JSON.parse(plan[i].body) as Record<string, unknown>;
      const merged = mergeHcPayloads(existingPayload, incomingPayload);
      // merge 前後で sessions/distances/speeds の **要素数** が変わらなければ
      // 新しい session/distance/speed は来ていないので skip (= no_change)。
      // top-level の date 等のメタ変化や同 id の内容差し替えは write しない
      // (= efficient だが title 等の trivial 更新は反映しない)。
      const eObj = (existingPayload && typeof existingPayload === "object" && !Array.isArray(existingPayload))
        ? existingPayload as Record<string, unknown> : {};
      const len = (v: unknown) => Array.isArray(v) ? v.length : 0;
      const sameCounts =
        merged.sessions.length === len(eObj.sessions) &&
        merged.distances.length === len(eObj.distances) &&
        merged.speeds.length === len(eObj.speeds);
      if (sameCounts) {
        skipped.push({ index: plan[i].index, reason: "no_change", key: plan[i].key });
        continue;
      }
      filtered.push({ ...plan[i], body: JSON.stringify(merged) });
    }
    plan.length = 0;
    plan.push(...filtered);
  }

  // Phase 3: write the remaining plan. We treat "0 to write" as success when
  // there were valid days (= 全 day が no_change で merge 不要) and 400 only when
  // nothing could be parsed in the first place.
  const anyValidInput = plan.length + skipped.filter(
    (s) => s.reason === "no_change" || s.reason === "already_exists",
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
  // D1 indexing: written 分だけ HC payload を sessions[] → workouts row へ展開。
  // 既に R2 に存在するため skip した day は新しい payload を受け取っていない
  // (= D1 行も既に入っている前提) ので再 index しない。
  // D1 への並列 upsert は workerd 上で race 起こすので逐次 await する。
  let indexed = 0;
  for (const p of plan) {
    const payload = JSON.parse(p.body) as Record<string, unknown>;
    const dateStr = (days[p.index] as { date: string }).date;
    indexed += await indexHcPayload(c.env.DB, payload, p.key, dateStr);
  }
  return c.json({ ok: true, written: plan.length, keys, skipped, force, indexed });
});

/**
 * `POST /api/upload-zones` — iOS Zones (Apple Watch) workout export を 1 件保存。
 * body: Zones JSON そのまま (top-level に `uuid` と `startDate` を含むこと)
 * R2 key は `zones/{yyyy}/{mm}-{dd}/{uuid}.json` (UTC `startDate` 由来)
 * uuid が重複したら overwrite (= 同一 workout の再 upload は idempotent)
 */
app.post("/api/upload-zones", apiAuth, async (c) => {
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

app.get("/api/history", apiAuth, async (c) => {
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
app.post("/_admin/migrate", apiAuth, async (c) => {
  const result = await applySchema(c.env.DB);
  return c.json({ ok: true, ...result });
});

/**
 * `POST /_admin/reindex` — R2 の hc/ と zones/ を全件 listing し、D1 workouts に
 * upsert する。HC indexing が後付けで入った (PR #21) ため、それ以前にアップロード
 * 済みの R2 raw payload を D1 に反映する用途。upsert は idempotent なので何度
 * 叩いても安全。
 *
 * 戻り値:
 *   { hc_files, hc_rows, zones_files, zones_rows, skipped }
 * `skipped` は parse 失敗や不正 layout の key リスト (debug 用)。
 *
 * 大量データを想定する場合は ?prefix=zones/2026/ のような prefix で範囲を絞る:
 *   POST /_admin/reindex?prefix=hc/2026/
 *   POST /_admin/reindex?prefix=zones/
 *
 * Refs ippoan/HealthConnectReaderWorker#18
 */
app.post("/_admin/reindex", apiAuth, async (c) => {
  const prefixFilter = c.req.query("prefix");
  const uploadedAt = new Date().toISOString();
  const skipped: Array<{ key: string; reason: string }> = [];
  let hcFiles = 0, hcRows = 0, zonesFiles = 0, zonesRows = 0;

  // HC
  if (!prefixFilter || prefixFilter.startsWith("hc/") || prefixFilter === "hc") {
    const prefix = prefixFilter ?? "hc/";
    let cursor: string | undefined;
    do {
      const page = await c.env.R2.list({ prefix, cursor, limit: 1000 });
      for (const obj of page.objects) {
        const m = /^hc\/(\d{4})\/(\d{2})-(\d{2})\.json$/.exec(obj.key);
        if (!m) { skipped.push({ key: obj.key, reason: "bad_hc_layout" }); continue; }
        const date = `${m[1]}-${m[2]}-${m[3]}`;
        const r = await c.env.R2.get(obj.key);
        if (!r) { skipped.push({ key: obj.key, reason: "r2_get_null" }); continue; }
        let payload: unknown;
        try { payload = JSON.parse(await r.text()); }
        catch { skipped.push({ key: obj.key, reason: "invalid_json" }); continue; }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          skipped.push({ key: obj.key, reason: "not_object" }); continue;
        }
        const rows = await hcPayloadToRows(payload as Record<string, unknown>, obj.key, date, uploadedAt);
        for (const row of rows) await upsertWorkout(c.env.DB, row);
        hcFiles++;
        hcRows += rows.length;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  // Zones
  if (!prefixFilter || prefixFilter.startsWith("zones/") || prefixFilter === "zones") {
    const prefix = prefixFilter ?? "zones/";
    let cursor: string | undefined;
    do {
      const page = await c.env.R2.list({ prefix, cursor, limit: 1000 });
      for (const obj of page.objects) {
        const m = /^zones\/(\d{4})\/(\d{2})-(\d{2})\/[^/]+\.json$/.exec(obj.key);
        if (!m) { skipped.push({ key: obj.key, reason: "bad_zones_layout" }); continue; }
        const date = `${m[1]}-${m[2]}-${m[3]}`;
        const r = await c.env.R2.get(obj.key);
        if (!r) { skipped.push({ key: obj.key, reason: "r2_get_null" }); continue; }
        let payload: unknown;
        try { payload = JSON.parse(await r.text()); }
        catch { skipped.push({ key: obj.key, reason: "invalid_json" }); continue; }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          skipped.push({ key: obj.key, reason: "not_object" }); continue;
        }
        const row = zonesPayloadToRow(payload as Record<string, unknown>, obj.key, date, uploadedAt);
        await upsertWorkout(c.env.DB, row);
        zonesFiles++;
        zonesRows++;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  return c.json({
    ok: true,
    hc_files: hcFiles, hc_rows: hcRows,
    zones_files: zonesFiles, zones_rows: zonesRows,
    skipped: skipped.slice(0, 50), // first 50 だけ返す (debug 用 cap)
    skipped_total: skipped.length,
  });
});

/**
 * `GET /api/zones` — Zones workout のアップロード履歴を返す。
 * D1 `workouts` テーブル (source='zones') から uploaded_at desc で取得。
 * shape は従来通り `{ count, items: [{date, uuid, key, uploaded}] }`。
 */
app.get("/api/zones", apiAuth, async (c) => {
  const items = await listZonesFromDb(c.env.DB);
  return c.json({ count: items.length, items });
});

/**
 * `GET /api/workouts?days=N` — 直近 N 日分の workouts を日付ごとに HC × Zones で
 * pairing して返す。`days` 既定 30、最大 366。各日 `items[]` は
 * `matched` / `hc_only` / `zones_only` のいずれか。
 *
 * Refs ippoan/HealthConnectReaderWorker#18
 */
/**
 * `GET /api/workout?hc=<id>&zones=<id>` — 突合 detail 用。D1 行 + R2 raw payload
 * を結合して返す。HC / Zones いずれかは省略可能 (片方だけでも返す)。
 *
 * raw payload を含めるのは UI 側で速度推移 (HC `speeds[].samples[]`) や HR zones
 * (Zones `zones.zone1..5`) を描画するため。
 *
 * Refs ippoan/HealthConnectReaderWorker#18
 */
app.get("/api/workout", apiAuth, async (c) => {
  const hcId = c.req.query("hc");
  const zonesId = c.req.query("zones");
  if (!hcId && !zonesId) {
    return c.json({ error: "missing_hc_or_zones" }, 400);
  }
  const fetchOne = async (source: "hc" | "zones", id: string) => {
    const row = await c.env.DB.prepare(
      "SELECT * FROM workouts WHERE source = ? AND id = ?",
    ).bind(source, id).first<Record<string, unknown>>();
    if (!row) return null;
    const rawKey = row.raw_key as string | undefined;
    let raw: unknown = null;
    if (rawKey) {
      const obj = await c.env.R2.get(rawKey);
      if (obj) {
        try { raw = await obj.json(); } catch { raw = null; }
      }
    }
    return { row, raw };
  };
  const hc = hcId ? await fetchOne("hc", hcId) : null;
  const zones = zonesId ? await fetchOne("zones", zonesId) : null;
  if (!hc && !zones) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ hc, zones });
});

app.get("/api/workouts", apiAuth, async (c) => {
  const raw = c.req.query("days");
  let days = 30;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 366) days = n;
    else return c.json({ error: "days_out_of_range" }, 400);
  }
  const rows = await listWorkoutsSinceDays(c.env.DB, days);
  const grouped = groupAndMatch(rows);
  return c.json({
    days_requested: days,
    day_count: grouped.length,
    total: rows.length,
    days: grouped,
  });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  console.error("[healthconnectreader-worker]", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

export default app;
