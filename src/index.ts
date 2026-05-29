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
  addManualPair,
  buildManualPayload,
  deleteHcRowsForDate,
  deleteWorkout,
  groupAndMatch,
  hcPayloadToRows,
  hcSessionId,
  listGhapiFromDb,
  listKnownHcIds,
  listManualFromDb,
  listWorkoutsSinceDays,
  listZonesFromDb,
  loadPairSets,
  manualInputToRow,
  manualSessionId,
  removeManualPair,
  unpairGroup,
  upsertWorkout,
  zonesPayloadToRow,
  type ManualWorkoutInput,
} from "./db";
import {
  readGhapiWebhookAuthToken,
  readInternalSharedSecret,
  readUploadToken,
  type AppEnv,
  type Env,
} from "./env";
import { applySchema } from "./migrations";
import {
  manualKeyFor,
  summarizeHistory,
  uploadKeyFor,
  uploadKeyForDateString,
  zonesKeyFor,
} from "./r2";
import { hrSeriesKey } from "./ghapi-ingest";
import {
  FAVICON_ICO_BYTES,
  GHAPI_DETAIL_HTML,
  INDEX_HTML,
  MANIFEST_JSON,
  MANUAL_CREATE_HTML,
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

/**
 * `GET /manual` — 手動 HC データ作成ページ。心拍 (ghapi) を背景に描画しながら
 * 開始/終了/距離/速度で workout を組み立て、`source='manual'` で保存する。
 * auth は `/` と同じ 3 経路。Refs ippoan/HealthConnectReader#6
 */
app.get("/manual", async (c) => {
  const expected = await readUploadToken(c.env);
  if (expected) {
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m && constantTimeEqualStr(m[1], expected)) {
      return c.html(MANUAL_CREATE_HTML);
    }
  }
  if (await verifyAuthCookie(c.env, c.req.header("cookie") ?? "")) {
    return c.html(MANUAL_CREATE_HTML);
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
  // payload に含まれる `date` (Android が JST `LocalDate.now()` で生成) を
  // 優先して key を決める。Worker 側で `new Date()` を使うと UTC 基準になるため、
  // JST 朝 (= UTC 前日 15:00-23:59) に「今すぐ Upload」を押すと当日 data が
  // 前日 key に merge され、UI 上「今日のがアップロードできない」状態になる。
  // 欠落 / 不正時は従来通り UTC `new Date()` に fallback。
  // Refs ippoan/HealthConnectReaderWorker#48
  const dateFromPayload = (parsed as { date?: unknown }).date;
  const keyInfo =
    (typeof dateFromPayload === "string" ? uploadKeyForDateString(dateFromPayload) : null)
    ?? uploadKeyFor(new Date());
  const { key, yyyy, mmdd } = keyInfo;
  const date = `${yyyy}-${mmdd}`;
  // 「今すぐ Upload」は HC の "today" snapshot を投げてくる。同 key に既に
  // (= upload-batch でマージ済みの) sessions が入っている場合に丸ごと
  // 上書きすると既存セッションを消してしまうので、upload-batch と同じ
  // merge セマンティクスで既存と incoming を id 単位で union する。
  // Refs ippoan/HealthConnectReaderWorker#18
  // `?force=true` = snapshot replace: merge せず incoming で R2 を丸ごと上書きし、
  // その日の hc 行を削除してから再 index する。Android app は full-day snapshot を
  // 送るため、フィルタ前の旧 upload が残した別 source (Fitbit / Google Fit) の
  // レコードが merge で復活し距離集計 (source 間 max) を汚す問題を、再 upload で
  // self-heal できるようにする。既定 (force 無し) は従来の id 単位 union merge
  // (Refs #18 / #97)。
  const force = c.req.query("force") === "true";
  let toStore: ArrayBuffer | string = raw;
  let storedPayload: Record<string, unknown> = parsed as Record<string, unknown>;
  // force 時は既存を読まず incoming で丸ごと上書き (= snapshot replace)。
  // 既定は既存と id 単位 union merge。
  if (!force) {
    const existing = await c.env.R2.get(key);
    if (existing !== null) {
      let existingPayload: unknown = null;
      try { existingPayload = JSON.parse(await existing.text()); } catch { /* corrupt → overwrite */ }
      if (existingPayload !== null) {
        const merged = mergeHcPayloads(existingPayload, parsed as Record<string, unknown>);
        storedPayload = merged;
        toStore = JSON.stringify(merged);
      }
    }
  }
  await c.env.R2.put(key, toStore, {
    httpMetadata: { contentType: "application/json" },
  });
  // force 時は、payload から消えた session (別 source) の stale 行を消すため、
  // 再 index の前にその日の hc 行を一掃する。
  if (force) await deleteHcRowsForDate(c.env.DB, date);
  const indexed = await indexHcPayload(c.env.DB, storedPayload, key, date);
  return c.json({ ok: true, key, date, indexed, force });
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
    // Parallel R2 GET の Response をそのまま放置すると Worker runtime が
    // "stalled HTTP response" として cancel する (concurrent fetch limit)。
    // map の中で **GET + body 読み + parse まで完了させる** 形にして、配列に
    // 入る時点で R2 Response は既に消費済みにしておく。
    type Fetched =
      | { kind: "missing" }
      | { kind: "corrupt" }
      | { kind: "ok"; payload: unknown };
    const fetched: Fetched[] = await Promise.all(
      plan.map(async (p): Promise<Fetched> => {
        const obj = await c.env.R2.get(p.key);
        if (obj === null) return { kind: "missing" };
        try {
          return { kind: "ok", payload: JSON.parse(await obj.text()) };
        } catch {
          return { kind: "corrupt" };
        }
      }),
    );
    const filtered: Plan[] = [];
    for (let i = 0; i < plan.length; i++) {
      const f = fetched[i];
      if (f.kind === "missing") {
        filtered.push(plan[i]);
        continue;
      }
      if (f.kind === "corrupt") {
        // 壊れた existing は incoming で overwrite (= 安全側)
        filtered.push(plan[i]);
        continue;
      }
      const existingPayload = f.payload;
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
  let hcFiles = 0, hcRows = 0, zonesFiles = 0, zonesRows = 0, manualFiles = 0, manualRows = 0;

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

  // Manual (手動作成) — `manual/{yyyy}/{mm-dd}/{id}.json` を HC payload 構造から
  // 復元して source='manual' で upsert する。D1 が飛んでも R2 raw から再生できる。
  if (!prefixFilter || prefixFilter.startsWith("manual/") || prefixFilter === "manual") {
    const prefix = prefixFilter ?? "manual/";
    let cursor: string | undefined;
    do {
      const page = await c.env.R2.list({ prefix, cursor, limit: 1000 });
      for (const obj of page.objects) {
        const m = /^manual\/(\d{4})\/(\d{2})-(\d{2})\/(manual_[0-9a-f]{16})\.json$/.exec(obj.key);
        if (!m) { skipped.push({ key: obj.key, reason: "bad_manual_layout" }); continue; }
        const id = m[4];
        const r = await c.env.R2.get(obj.key);
        if (!r) { skipped.push({ key: obj.key, reason: "r2_get_null" }); continue; }
        let payload: unknown;
        try { payload = JSON.parse(await r.text()); }
        catch { skipped.push({ key: obj.key, reason: "invalid_json" }); continue; }
        const sessions = (payload as { sessions?: unknown }).sessions;
        const s = Array.isArray(sessions) ? sessions[0] : null;
        if (!s || typeof s !== "object") { skipped.push({ key: obj.key, reason: "no_session" }); continue; }
        const sess = s as Record<string, unknown>;
        const distances = (payload as { distances?: unknown }).distances;
        const d0 = Array.isArray(distances) && distances[0] && typeof distances[0] === "object"
          ? (distances[0] as { km?: unknown }).km : null;
        if (typeof sess.startTime !== "string" || typeof sess.endTime !== "string" ||
            typeof sess.exerciseType !== "number") {
          skipped.push({ key: obj.key, reason: "bad_session_fields" }); continue;
        }
        const row = manualInputToRow(
          {
            startTime: sess.startTime,
            endTime: sess.endTime,
            exerciseType: sess.exerciseType,
            title: typeof sess.title === "string" ? sess.title : null,
            distanceKm: typeof d0 === "number" ? d0 : null,
          },
          id,
          obj.key,
          uploadedAt,
        );
        await upsertWorkout(c.env.DB, row);
        manualFiles++;
        manualRows++;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  return c.json({
    ok: true,
    hc_files: hcFiles, hc_rows: hcRows,
    zones_files: zonesFiles, zones_rows: zonesRows,
    manual_files: manualFiles, manual_rows: manualRows,
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
  // hc / zones は comma-separated 可。同一 index が 1 セッション (片方空文字 = 欠落)。
  // 例: hc=a,b,c&zones=x,,y → セッション 0={hc:a, zones:x}, 1={hc:b}, 2={hc:c, zones:y}
  // backward compat: 単一 id (comma 無) は 1 セッション扱い。
  const hcParam = c.req.query("hc") ?? "";
  const zonesParam = c.req.query("zones") ?? "";
  if (!hcParam && !zonesParam) {
    return c.json({ error: "missing_hc_or_zones" }, 400);
  }
  const hcIds = hcParam.split(",").map((s) => s.trim());
  const zonesIds = zonesParam.split(",").map((s) => s.trim());
  const n = Math.max(hcIds.length, zonesIds.length);
  if (n > 20) return c.json({ error: "too_many_sessions" }, 400);

  const fetchOne = async (source: "hc" | "zones", id: string) => {
    if (!id) return null;
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

  const sessions: Array<{ hc: unknown; zones: unknown }> = [];
  for (let i = 0; i < n; i++) {
    const hc = await fetchOne("hc", hcIds[i] ?? "");
    const zones = await fetchOne("zones", zonesIds[i] ?? "");
    if (hc || zones) sessions.push({ hc, zones });
  }
  if (sessions.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }
  // backward compat: 単一セッションの場合は legacy shape (hc / zones) も併載。
  const first = sessions[0];
  return c.json({ sessions, hc: first.hc, zones: first.zones });
});

/**
 * `GET /api/known-hc-ids?days=N` — D1 に既に入っている HC session id 一覧を返す。
 * Android アプリは readPastDays で得た各 session から同じ規約
 * (\`hc:<startTime>:<exerciseType>\` の SHA-256 上位 16 hex) で id を計算し、
 * このリストに含まれないものだけ upload-batch に乗せる「diff upload」用。
 *
 * 利点: 「過去 30 日 Upload」を何度押してもネットワーク通信は **新規 session
 * 分だけ** で完結する。R2 merge 経路と併用すれば二重防御で安全。
 *
 * shape: `{ days, count, ids: ["hc_xxxxxxxxxxxxxxxx", ...] }`
 *
 * Refs ippoan/HealthConnectReaderWorker#18
 */
app.get("/api/known-hc-ids", apiAuth, async (c) => {
  const raw = c.req.query("days");
  let days = 30;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 366) days = n;
    else return c.json({ error: "days_out_of_range" }, 400);
  }
  const ids = await listKnownHcIds(c.env.DB, days);
  return c.json({ days, count: ids.length, ids });
});

/**
 * `POST /api/hc-session-id` — Android 側で id 計算をローカル実装するまでの
 * 暫定 helper。`{ startTime, exerciseType }` を投げると Worker と同じ規約で
 * 計算した id を返す。Android が SHA-256 を計算できれば不要。
 *
 * Refs ippoan/HealthConnectReaderWorker#18
 */
app.post("/api/hc-session-id", apiAuth, async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body || typeof body !== "object") {
    return c.json({ error: "expected_object" }, 400);
  }
  const startTime = (body as { startTime?: unknown }).startTime;
  const exerciseType = (body as { exerciseType?: unknown }).exerciseType;
  if (typeof startTime !== "string") {
    return c.json({ error: "missing_startTime" }, 400);
  }
  const id = await hcSessionId(startTime, exerciseType);
  return c.json({ id });
});

app.get("/api/workouts", apiAuth, async (c) => {
  const raw = c.req.query("days");
  let days = 30;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 366) days = n;
    else return c.json({ error: "days_out_of_range" }, 400);
  }
  const [rows, pairSets] = await Promise.all([
    listWorkoutsSinceDays(c.env.DB, days),
    loadPairSets(c.env.DB),
  ]);
  const grouped = groupAndMatch(rows, pairSets.pairs, pairSets.unpairs);
  return c.json({
    days_requested: days,
    day_count: grouped.length,
    total: rows.length,
    days: grouped,
  });
});

/**
 * `POST /api/pair` — `{ hc_id, zones_id }` を手動突合に追加。
 * 同時に unpair を解除するので、誤って解除した auto-pair の復活にも使える。
 * idempotent (PK 衝突は無視)。
 * Refs ippoan/HealthConnectReaderWorker#18
 */
app.post("/api/pair", apiAuth, async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body || typeof body !== "object") return c.json({ error: "expected_object" }, 400);
  const hcId = (body as { hc_id?: unknown }).hc_id;
  const zonesId = (body as { zones_id?: unknown }).zones_id;
  if (typeof hcId !== "string" || !hcId) return c.json({ error: "missing_hc_id" }, 400);
  if (typeof zonesId !== "string" || !zonesId) return c.json({ error: "missing_zones_id" }, 400);
  await addManualPair(c.env.DB, hcId, zonesId);
  return c.json({ ok: true, hc_id: hcId, zones_id: zonesId });
});

/**
 * `POST /api/pair/delete` — 1 つの pair edge を削除 + unpair に登録。
 * body: `{ hc_id, zones_id }`、または matched group まるごと解除する場合
 * `{ hc_ids: [...], zones_ids: [...] }` を送ると全ペア組合せを unpair 化する。
 */
app.post("/api/pair/delete", apiAuth, async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body || typeof body !== "object") return c.json({ error: "expected_object" }, 400);
  const single = (body as { hc_id?: unknown; zones_id?: unknown });
  const group = (body as { hc_ids?: unknown; zones_ids?: unknown });
  if (Array.isArray(group.hc_ids) && Array.isArray(group.zones_ids)) {
    const hcIds = group.hc_ids.filter((x): x is string => typeof x === "string" && x.length > 0);
    const zonesIds = group.zones_ids.filter((x): x is string => typeof x === "string" && x.length > 0);
    if (hcIds.length === 0 || zonesIds.length === 0) {
      return c.json({ error: "empty_group" }, 400);
    }
    await unpairGroup(c.env.DB, hcIds, zonesIds);
    return c.json({ ok: true, hc_ids: hcIds, zones_ids: zonesIds });
  }
  if (typeof single.hc_id === "string" && typeof single.zones_id === "string") {
    await removeManualPair(c.env.DB, single.hc_id, single.zones_id);
    return c.json({ ok: true, hc_id: single.hc_id, zones_id: single.zones_id });
  }
  return c.json({ error: "missing_ids" }, 400);
});

// =============================================================================
// 手動作成 HC データ (source='manual') routes
// Refs ippoan/HealthConnectReader#6
// =============================================================================

/**
 * `POST /api/manual` — 手動 workout を 1 件作成 / 更新する。
 *
 * body: `{ startTime, endTime, exerciseType, title?, distanceKm? }`
 *   - startTime / endTime: ISO 8601 (end > start)
 *   - exerciseType: HC `EXERCISE_TYPE_*` の Int (例 56=ランニング)
 *   - title: 表示名 (省略時は exerciseType 名)
 *   - distanceKm: 距離 (km、省略 / 0 なら距離 null)
 *
 * `hc/` とは別 prefix (`manual/{yyyy}/{mm-dd}/{id}.json`) + `source='manual'` で
 * 保存するので、Android の自動 upload に上書きされない。同じ入力での再 POST は
 * 同 id = upsert で上書き (= 微修正の反映)。
 */
app.post("/api/manual", apiAuth, async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "expected_object" }, 400);
  }
  const b = body as Record<string, unknown>;
  const startTime = b.startTime;
  const endTime = b.endTime;
  const exerciseType = b.exerciseType;
  if (typeof startTime !== "string" || Number.isNaN(Date.parse(startTime))) {
    return c.json({ error: "invalid_startTime" }, 400);
  }
  if (typeof endTime !== "string" || Number.isNaN(Date.parse(endTime))) {
    return c.json({ error: "invalid_endTime" }, 400);
  }
  if (Date.parse(endTime) <= Date.parse(startTime)) {
    return c.json({ error: "end_not_after_start" }, 400);
  }
  if (typeof exerciseType !== "number" || !Number.isFinite(exerciseType)) {
    return c.json({ error: "invalid_exerciseType" }, 400);
  }
  const title = typeof b.title === "string" ? b.title : null;
  let distanceKm: number | null = null;
  if (b.distanceKm !== undefined && b.distanceKm !== null) {
    if (typeof b.distanceKm !== "number" || !Number.isFinite(b.distanceKm) || b.distanceKm < 0) {
      return c.json({ error: "invalid_distanceKm" }, 400);
    }
    distanceKm = b.distanceKm;
  }

  const input: ManualWorkoutInput = { startTime, endTime, exerciseType, title, distanceKm };
  const id = await manualSessionId(startTime, exerciseType, title);
  const k = manualKeyFor(startTime, id);
  if (!k) return c.json({ error: "key_build_failed" }, 400);

  const now = new Date().toISOString();
  const payload = buildManualPayload(input, now);
  const row = manualInputToRow(input, id, k.key, now);
  await Promise.all([
    c.env.R2.put(k.key, JSON.stringify(payload), {
      httpMetadata: { contentType: "application/json" },
    }),
    upsertWorkout(c.env.DB, row),
  ]);
  return c.json({ ok: true, id, key: k.key, date: row.date, row });
});

/**
 * `GET /api/manual` — 手動作成 workout の一覧 (新しい順)。`{ count, items }`。
 */
app.get("/api/manual", apiAuth, async (c) => {
  const items = await listManualFromDb(c.env.DB);
  return c.json({ count: items.length, items });
});

/**
 * `POST /api/manual/delete` — 手動 workout を 1 件削除する (= 作成の取り消し)。
 * body: `{ id }`。R2 raw blob と D1 row の両方を消す。idempotent。
 */
app.post("/api/manual/delete", apiAuth, async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body || typeof body !== "object") return c.json({ error: "expected_object" }, 400);
  const id = (body as { id?: unknown }).id;
  if (typeof id !== "string" || !id) return c.json({ error: "missing_id" }, 400);
  // R2 key は row の raw_key を正とする (無ければ start_at から再計算)。
  const row = await c.env.DB.prepare(
    "SELECT raw_key, start_at FROM workouts WHERE source = 'manual' AND id = ?",
  ).bind(id).first<{ raw_key?: string; start_at?: string }>();
  let rawKey = row?.raw_key;
  if (!rawKey && typeof row?.start_at === "string") {
    rawKey = manualKeyFor(row.start_at, id)?.key;
  }
  await Promise.all([
    rawKey ? c.env.R2.delete(rawKey) : Promise.resolve(),
    deleteWorkout(c.env.DB, "manual", id),
  ]);
  return c.json({ ok: true, id, deleted_key: rawKey ?? null });
});

// =============================================================================
// Google Health API (ghapi) routes
// Refs ippoan/HealthConnectReaderWorker#60
// =============================================================================

/**
 * auth-worker (`auth-staging.ippoan.org`) の Google Health 専用 OAuth redirect
 * URL を組む。redirect_uri は post-OAuth で auth-worker → 302 で戻る先 (PWA UI)。
 *
 * 注: 既存ログイン用 (`buildAuthLoginUrl`) は `auth.ippoan.org` (prod) を使うが、
 * Google Health 用 OAuth Client は Google Cloud Console で
 * `https://auth-staging.ippoan.org/oauth/ghapi/callback` を redirect URI として
 * 登録した経緯があり、staging 側に固定する。Refs #60
 */
function buildGhapiConnectUrl(requestUrl: string): string {
  const u = new URL(requestUrl);
  const back = `${u.origin}/api/ghapi/connected`;
  return `https://auth-staging.ippoan.org/oauth/ghapi/redirect?redirect_uri=${encodeURIComponent(back)}`;
}

function getGhapiStub(env: Env) {
  if (!env.GHAPI_SUBSCRIBER) return null;
  const id = env.GHAPI_SUBSCRIBER.idFromName("default");
  return env.GHAPI_SUBSCRIBER.get(id);
}

/**
 * `GET /ghapi/connect` — auth-worker の Google Health OAuth redirect へ 302 飛ばす。
 * cookie auth (= PWA / browser からの利用) 必須。
 */
app.get("/ghapi/connect", async (c) => {
  if (!(await verifyAuthCookie(c.env, c.req.header("cookie") ?? ""))) {
    return c.redirect(buildAuthLoginUrl(c.req.url), 302);
  }
  return c.redirect(buildGhapiConnectUrl(c.req.url), 302);
});

/**
 * `GET /api/ghapi/connected` — auth-worker からの post-OAuth landing。
 * tokens は別経路 (`POST /api/ghapi/store-tokens`) で先に届いている前提で、
 * ここでは「接続完了」HTML を返すだけ。
 */
app.get("/api/ghapi/connected", async (c) => {
  if (!(await verifyAuthCookie(c.env, c.req.header("cookie") ?? ""))) {
    return c.redirect(buildAuthLoginUrl(c.req.url), 302);
  }
  return c.html(
    `<!doctype html><meta charset="utf-8"><title>Google Health 接続完了</title>
<body style="font-family:system-ui;padding:2rem;text-align:center">
<h1>✓ Google Health 接続完了</h1>
<p><a href="/">← トップへ戻る</a></p></body>`,
  );
});

/**
 * `POST /api/ghapi/store-tokens` — auth-worker が code→tokens 交換後にここへ
 * `{ refresh_token, healthUserId }` を POST してくる。
 *
 * 認証: `Authorization: Bearer ${INTERNAL_SHARED_SECRET}`。auth-worker と
 * hcreader-worker に同じ値を投入する。
 *
 * DO `GhapiSubscriberDO/default` の `/store-tokens` に丸ごと forward する。
 */
app.post("/api/ghapi/store-tokens", async (c) => {
  const expected = await readInternalSharedSecret(c.env);
  if (!expected) return c.json({ error: "server_misconfigured" }, 500);
  const header = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || !constantTimeEqualStr(m[1], expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const stub = getGhapiStub(c.env);
  if (!stub) return c.json({ error: "ghapi_do_not_bound" }, 500);

  const url = new URL(c.req.url);
  const webhookUrl = `${url.origin}/api/ghapi/webhook`;
  const webhookAuth = await readGhapiWebhookAuthToken(c.env);

  // body は touch せず DO に raw forward (refresh_token / healthUserId 検証は DO 側)
  const rawBody = await c.req.raw.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!parsed || typeof parsed !== "object") {
    return c.json({ error: "expected_object" }, 400);
  }
  const enriched = JSON.stringify({
    ...(parsed as Record<string, unknown>),
    webhookUrl,
    webhookAuth,
  });
  const resp = await stub.fetch(
    new Request("https://ghapi-do/store-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: enriched,
    }),
  );
  return new Response(await resp.text(), {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
});

/**
 * `POST /api/ghapi/webhook` — Google から data 変更通知が飛んでくる endpoint。
 *
 * 認証: subscription 作成時に endpointAuthorization として登録した値が
 * `Authorization: Bearer` で送られてくる前提 (= `GHAPI_WEBHOOK_AUTH_TOKEN`)。
 *
 * 受信したら **即 204 を返す** + ctx.waitUntil で DO に投げる
 * (= Google 側のリトライストームを避ける)。
 */
app.post("/api/ghapi/webhook", async (c) => {
  const expected = await readGhapiWebhookAuthToken(c.env);
  if (!expected) return c.json({ error: "server_misconfigured" }, 500);
  const header = c.req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || !constantTimeEqualStr(m[1], expected)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const stub = getGhapiStub(c.env);
  if (!stub) return c.json({ error: "ghapi_do_not_bound" }, 500);

  const rawBody = await c.req.raw.text();
  c.executionCtx.waitUntil(
    stub
      .fetch(
        new Request("https://ghapi-do/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: rawBody,
        }),
      )
      .then(() => undefined)
      .catch((e) => console.error("ghapi_webhook_do_fetch_failed", e)),
  );
  return new Response(null, { status: 204 });
});

/**
 * `GET /api/ghapi/status` — UI 用接続状態 + 直近イベント + 取込済 workout 件数。
 */
app.get("/api/ghapi/status", apiAuth, async (c) => {
  const stub = getGhapiStub(c.env);
  if (!stub) {
    return c.json({ enabled: false, connected: false });
  }
  const resp = await stub.fetch(new Request("https://ghapi-do/status"));
  const status = (await resp.json()) as Record<string, unknown>;
  const recent = await listGhapiFromDb(c.env.DB, 20);
  return c.json({ enabled: true, ...status, recent_count: recent.length, recent });
});

/**
 * `POST /api/ghapi/backfill` — webhook を待たず過去 N 日分の Exercise を取込む。
 *
 * body: `{ days?: number, force?: boolean }` (default 3、force 無しは差分取込)。
 * cookie / Bearer auth (`apiAuth`)。DO の `/backfill` に forward して結果を返す。
 */
app.post("/api/ghapi/backfill", apiAuth, async (c) => {
  const stub = getGhapiStub(c.env);
  if (!stub) return c.json({ error: "ghapi_do_not_bound" }, 500);

  let days = 3;
  let force = false;
  try {
    const body = (await c.req.json()) as { days?: unknown; force?: unknown };
    if (typeof body.days === "number" && Number.isFinite(body.days)) {
      days = Math.floor(body.days);
    }
    if (body.force === true) force = true;
  } catch {
    // body 無し → default
  }

  const resp = await stub.fetch(
    new Request("https://ghapi-do/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days, force }),
    }),
  );
  return new Response(await resp.text(), {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
});

/**
 * `GET /api/ghapi/workout?id=<id>` — ghapi workout 詳細 (HR 時系列 + 速度ステップ用)。
 *
 * 返り値:
 *   - `row`: 対象 ghapi 行 (D1)
 *   - `samples`: HR 時系列 `[{t,bpm}]` (R2 `ghapi/hr/<id>.json`、無ければ [])
 *   - `overlapping`: HR 窓と時間 overlap する全 ghapi 行 (速度ステップ描画用。
 *     「結合された長い session」配下の複数 treadmill 速度区間を重ねて見せる)
 */
app.get("/api/ghapi/workout", apiAuth, async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "missing_id" }, 400);

  const row = await c.env.DB.prepare(
    "SELECT * FROM workouts WHERE id = ? AND source = 'ghapi'",
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return c.json({ error: "not_found" }, 404);

  let samples: Array<{ t: number; bpm: number }> = [];
  let padMs = 0;
  const obj = await c.env.R2.get(hrSeriesKey(id));
  if (obj) {
    try {
      const parsed = JSON.parse(await obj.text()) as {
        samples?: Array<{ t: number; bpm: number }>;
        pad_ms?: number;
      };
      if (Array.isArray(parsed.samples)) samples = parsed.samples;
      if (typeof parsed.pad_ms === "number") padMs = parsed.pad_ms;
    } catch {
      /* corrupt → samples 空のまま */
    }
  }

  // HR 窓 (= row 期間 ± pad)
  const startMs = typeof row.start_at === "string" ? Date.parse(row.start_at) : NaN;
  const endMs = typeof row.end_at === "string" ? Date.parse(row.end_at) : NaN;
  let overlapping: Record<string, unknown>[] = [];
  let hcSessions: Record<string, unknown>[] = [];
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    const winStart = new Date(startMs - padMs).toISOString();
    const winEnd = new Date(endMs + padMs).toISOString();
    const res = await c.env.DB.prepare(
      "SELECT * FROM workouts WHERE source = 'ghapi' AND start_at < ? AND end_at > ? ORDER BY start_at ASC",
    )
      .bind(winEnd, winStart)
      .all<Record<string, unknown>>();
    overlapping = res.results ?? [];

    // 速度は /workout 合成チャートと同じく「session 別の平均速度の平坦線」で出す。
    // raw の細かいサンプルは平均/点が混在して線が荒れる (= 間違った速度に見える)
    // ため使わない。時間 overlap する HC session (de-doubled 済の distance) を返し、
    // チャート側で各 session の avg km/h を平坦線で描く。Refs #60
    // 手動作成 (source='manual') もこの心拍を基準に作るので速度帯に含める
    // (= 作成直後に同じ HR ページで重ねて確認できる)。Refs HealthConnectReader#6
    const hcRes = await c.env.DB.prepare(
      "SELECT id, activity_name, start_at, end_at, distance_m, duration_sec FROM workouts WHERE source IN ('hc', 'manual') AND start_at < ? AND end_at > ? ORDER BY start_at ASC",
    )
      .bind(winEnd, winStart)
      .all<Record<string, unknown>>();
    hcSessions = hcRes.results ?? [];
  }

  return c.json({ row, samples, overlapping, hc_sessions: hcSessions });
});

/**
 * `GET /ghapi/workout?id=<id>` — ghapi workout 詳細 HTML (Chart.js)。auth は `/` と同じ。
 */
app.get("/ghapi/workout", async (c) => {
  const expected = await readUploadToken(c.env);
  if (expected) {
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m && constantTimeEqualStr(m[1], expected)) {
      return c.html(GHAPI_DETAIL_HTML);
    }
  }
  if (await verifyAuthCookie(c.env, c.req.header("cookie") ?? "")) {
    return c.html(GHAPI_DETAIL_HTML);
  }
  return c.redirect(buildAuthLoginUrl(c.req.url), 302);
});

/**
 * `POST /api/ghapi/disconnect` — revoke + subscription 削除 + DO storage clear。
 */
app.post("/api/ghapi/disconnect", apiAuth, async (c) => {
  const stub = getGhapiStub(c.env);
  if (!stub) return c.json({ ok: true, noop: "ghapi_do_not_bound" });
  const resp = await stub.fetch(
    new Request("https://ghapi-do/disconnect", { method: "POST" }),
  );
  return new Response(await resp.text(), {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((err, c) => {
  console.error("[healthconnectreader-worker]", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

export default app;

export { GhapiSubscriberDO } from "./durable_objects/ghapi-subscriber-do";
