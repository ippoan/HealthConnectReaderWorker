/**
 * GhapiSubscriberDO — Google Health API 連携の per-user 状態保持 DO。
 *
 * idFromName("default") 固定 (1 user 運用前提)。将来複数 user 化するなら
 * `idFromName(email)` に変えて email ↔ healthUserId の逆引きを KV で持つ。
 *
 * Storage layout:
 *   refresh_token   : string  (Google OAuth refresh_token、access_token は都度 refresh)
 *   health_user_id  : string  (auth-worker の getIdentity 結果。webhook 識別用)
 *   subscription_id : string  (Google Health webhook subscription の ID)
 *   created_at      : number  (epoch ms、storeTokens 時)
 *   last_event_at   : number  (epoch ms、webhook 受信時)
 *   last_event_summary : string  (直近 webhook の dataType / count メモ。debug 用)
 *
 * 責務:
 *   - storeTokens(): auth-worker から refresh_token を受け取り subscription を作成
 *   - onWebhook():   refresh_token → access_token → dataPoints fetch → R2/D1 反映
 *   - disconnect(): revoke + subscription 削除 + clear
 *   - status(): UI 用 (connected / health_user_id / last_event_at)
 *
 * fetch ルート (Worker から `stub.fetch(new Request(...))` で叩く):
 *   POST /store-tokens   body: { refresh_token, healthUserId, webhookUrl, webhookAuth }
 *   POST /webhook        body: GhapiWebhookPayload
 *   POST /disconnect
 *   GET  /status
 *
 * Refs ippoan/HealthConnectReaderWorker#60
 */
import {
  createSubscription,
  deleteSubscription,
  listExercisePoints,
  listHeartRateSamples,
  summarizeHr,
  refreshAccessToken,
  revokeToken,
  type GhapiDataPoint,
  type GhapiWebhookPayload,
} from "../ghapi";
import {
  ingestExercisePoints,
  backfillDayStarts,
  hrSeriesKey,
  HR_PAD_MS,
} from "../ghapi-ingest";
import { updateWorkoutHeartRate, type WorkoutRow } from "../db";

interface DOEnv {
  R2: R2Bucket;
  DB: D1Database;
  GOOGLE_HEALTH_CLIENT_ID?: { get(): Promise<string> } | string;
  GOOGLE_HEALTH_CLIENT_SECRET?: { get(): Promise<string> } | string;
}

const K_REFRESH = "refresh_token";
const K_HEALTH_USER = "health_user_id";
const K_SUBSCRIPTION = "subscription_id";
const K_CREATED_AT = "created_at";
const K_LAST_EVENT_AT = "last_event_at";
const K_LAST_EVENT_SUMMARY = "last_event_summary";
const K_LAST_BACKFILL_AT = "last_backfill_at";

export class GhapiSubscriberDO {
  state: DurableObjectState;
  env: DOEnv;

  constructor(state: DurableObjectState, env: DOEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/store-tokens") {
      return this.handleStoreTokens(req);
    }
    if (req.method === "POST" && url.pathname === "/webhook") {
      return this.handleWebhook(req);
    }
    if (req.method === "POST" && url.pathname === "/backfill") {
      return this.handleBackfill(req);
    }
    if (req.method === "POST" && url.pathname === "/disconnect") {
      return this.handleDisconnect();
    }
    if (req.method === "GET" && url.pathname === "/status") {
      return this.handleStatus();
    }
    return json(404, { error: "not_found" });
  }

  // ---------- /store-tokens ----------

  private async handleStoreTokens(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid_json" });
    }
    if (!body || typeof body !== "object") {
      return json(400, { error: "expected_object" });
    }
    const refresh = (body as { refresh_token?: unknown }).refresh_token;
    const healthUserId = (body as { healthUserId?: unknown }).healthUserId;
    const webhookUrl = (body as { webhookUrl?: unknown }).webhookUrl;
    const webhookAuth = (body as { webhookAuth?: unknown }).webhookAuth;
    if (typeof refresh !== "string" || !refresh) {
      return json(400, { error: "missing_refresh_token" });
    }
    if (typeof healthUserId !== "string" || !healthUserId) {
      return json(400, { error: "missing_healthUserId" });
    }

    await this.state.storage.put({
      [K_REFRESH]: refresh,
      [K_HEALTH_USER]: healthUserId,
      [K_CREATED_AT]: Date.now(),
    });

    // Subscription 作成 (stub: 値返すだけ。GA 後に real fetch に差し替え)
    let subscriptionId = "";
    if (typeof webhookUrl === "string" && typeof webhookAuth === "string") {
      try {
        const tokens = await this.refresh();
        const sub = await createSubscription({
          accessToken: tokens.access_token,
          webhookUrl,
          endpointAuthorization: webhookAuth,
        });
        subscriptionId = sub.subscriptionId;
        await this.state.storage.put(K_SUBSCRIPTION, subscriptionId);
      } catch (e) {
        console.warn("ghapi_subscription_create_failed", { error: String(e) });
        // subscription 作成失敗は致命傷ではない (webhook が来なくても poll で代替可能)
      }
    }

    return json(200, { ok: true, subscriptionId });
  }

  // ---------- /webhook ----------

  private async handleWebhook(req: Request): Promise<Response> {
    let payload: GhapiWebhookPayload;
    try {
      payload = (await req.json()) as GhapiWebhookPayload;
    } catch {
      return json(400, { error: "invalid_json" });
    }
    await this.onWebhook(payload);
    return json(200, { ok: true });
  }

  /**
   * webhook payload を処理: refresh_token → access_token → dataPoints fetch
   * → R2 PUT + D1 upsert。Exercise dataType 以外は R2 に保存するのみで
   * D1 への index は skip する (= UI 表示は Exercise を主とする)。
   */
  async onWebhook(payload: GhapiWebhookPayload): Promise<void> {
    const data = payload.data;
    if (!data || !data.dataType || !Array.isArray(data.intervals)) return;
    const dataType = data.dataType;
    const intervals = data.intervals;
    if (intervals.length === 0) return;

    let tokens: { access_token: string };
    try {
      tokens = await this.refresh();
    } catch (e) {
      console.error("ghapi_refresh_failed_on_webhook", { error: String(e) });
      return;
    }

    let points: GhapiDataPoint[] = [];
    if (dataType === "Exercise") {
      try {
        points = await listExercisePoints(tokens.access_token, intervals);
      } catch (e) {
        console.error("ghapi_list_failed_on_webhook", { error: String(e) });
        return;
      }
    }

    const { indexed } = await ingestExercisePoints(
      this.env.R2,
      this.env.DB,
      dataType,
      intervals,
      points,
    );

    await this.state.storage.put({
      [K_LAST_EVENT_AT]: Date.now(),
      [K_LAST_EVENT_SUMMARY]: `${dataType}:${points.length} points, ${indexed} indexed`,
    });
  }

  // ---------- /backfill ----------

  /**
   * polling backfill: webhook を待たず、過去 `days` 日分の Exercise data point
   * を 1 日ずつ `dataPoints:list` で取得して R2/D1 に取り込む。
   *
   * Google Health の webhook subscription endpoint が "coming soon" のため
   * (= `createSubscription` が stub)、当面はこの手動 backfill が唯一の取込経路。
   *
   * body: `{ days?: number, force?: boolean }` (days は default 30、1〜365 に clamp)。
   * UTC の暦日ごとに interval を切る (R2 key の `{mm-dd}` が 1 日 1 ファイルに
   * なるよう `ingestExercisePoints` に 1 日分ずつ渡す)。
   *
   * 差分取込: `force` でなく `last_backfill_at` がある場合、その暦日以降だけを
   * 走査する (= 毎回 N 日全件叩き直す無駄を避ける。最後の取込日は再取込されるが
   * stable id upsert なので冪等)。`force: true` で N 日全件を強制再取込。
   */
  private async handleBackfill(req: Request): Promise<Response> {
    let days = 30;
    let force = false;
    try {
      const body = (await req.json()) as { days?: unknown; force?: unknown };
      if (typeof body.days === "number" && Number.isFinite(body.days)) {
        days = Math.floor(body.days);
      }
      if (body.force === true) force = true;
    } catch {
      // body 無し / 不正 → default
    }
    days = Math.max(1, Math.min(365, days));

    const refresh = await this.state.storage.get<string>(K_REFRESH);
    if (!refresh) return json(409, { error: "not_connected" });

    let accessToken: string;
    try {
      accessToken = (await this.refresh()).access_token;
    } catch (e) {
      console.error("ghapi_refresh_failed_on_backfill", { error: String(e) });
      return json(502, { error: "refresh_failed" });
    }

    const DAY_MS = 86_400_000;
    const lastBackfillAt =
      await this.state.storage.get<number>(K_LAST_BACKFILL_AT);
    // 走査対象の UTC 暦日 (各日 00:00 UTC) を新しい順に列挙。差分取込なら
    // last_backfill_at の暦日以降だけ。Health API の civil_start_time filter は
    // 暦日単位なので interval は [00:00 UTC, 翌 00:00 UTC) に揃える。
    const { dayStarts, incremental } = backfillDayStarts(
      Date.now(),
      days,
      lastBackfillAt,
      force,
    );

    let totalFetched = 0;
    let totalIndexed = 0;
    let daysScanned = 0;
    const errors: string[] = [];

    for (const dayStart of dayStarts) {
      daysScanned++;
      const interval = { startTimeMillis: dayStart, endTimeMillis: dayStart + DAY_MS };
      let points: GhapiDataPoint[];
      try {
        points = await listExercisePoints(accessToken, [interval]);
      } catch (e) {
        const msg = String(e);
        if (errors.length === 0) {
          console.error("ghapi_backfill_day_failed", { error: msg });
        }
        errors.push(msg);
        continue;
      }
      if (points.length === 0) continue;
      const { indexed, rows } = await ingestExercisePoints(
        this.env.R2,
        this.env.DB,
        "Exercise",
        [interval],
        points,
      );
      totalFetched += points.length;
      totalIndexed += indexed;
      // 各 session の HR 時系列を heart-rate dataType から取得して R2 保存 +
      // D1 の min/max/avg を埋める (exercise summary が HR を持たない HC session
      // でも Fitbit 等の HR を時間 overlap で拾える)。失敗は致命傷にしない。
      for (const row of rows) {
        try {
          await this.enrichHeartRate(accessToken, row);
        } catch (e) {
          const msg = String(e);
          if (errors.length === 0) {
            console.error("ghapi_hr_enrich_failed", { id: row.id, error: msg });
          }
          errors.push(msg);
        }
      }
    }

    const now = Date.now();
    const mode = force ? "force" : incremental ? "incr" : "full";
    await this.state.storage.put({
      [K_LAST_EVENT_AT]: now,
      [K_LAST_EVENT_SUMMARY]: `backfill ${mode} ${daysScanned}d: ${totalFetched} points, ${totalIndexed} indexed`,
      // 1 日でも失敗が無かったときだけ last_backfill_at を進める
      // (全失敗で進めると未取込の穴が残るため)。
      ...(errors.length === 0 ? { [K_LAST_BACKFILL_AT]: now } : {}),
    });

    return json(200, {
      ok: true,
      days,
      days_scanned: daysScanned,
      incremental,
      force,
      fetched: totalFetched,
      indexed: totalIndexed,
      errors: errors.length,
      first_error: errors[0] ? errors[0].slice(0, 300) : null,
    });
  }

  /**
   * 1 session の HR 時系列を取得して R2 保存 + D1 の min/max/avg を埋める。
   * HC session は時刻がずれることがあるので取得窓を ±HR_PAD_MS 広げる。
   * exercise summary が avg HR を持つ (= row.avg_heart_rate 非 null) ならそれを
   * 残し、無ければ series の avg を使う。min/max は summary に無いので常に series。
   */
  private async enrichHeartRate(
    accessToken: string,
    row: WorkoutRow,
  ): Promise<void> {
    const startMs = row.start_at ? Date.parse(row.start_at) : NaN;
    const endMs = row.end_at ? Date.parse(row.end_at) : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    const samples = await listHeartRateSamples(accessToken, {
      startTimeMillis: startMs - HR_PAD_MS,
      endTimeMillis: endMs + HR_PAD_MS,
    });
    if (samples.length === 0) return;

    await this.env.R2.put(
      hrSeriesKey(row.id),
      JSON.stringify({
        id: row.id,
        start_at: row.start_at,
        end_at: row.end_at,
        pad_ms: HR_PAD_MS,
        samples,
      }),
      { httpMetadata: { contentType: "application/json" } },
    );

    const sum = summarizeHr(samples);
    if (!sum) return;
    await updateWorkoutHeartRate(this.env.DB, row.id, {
      avg: row.avg_heart_rate ?? sum.avg,
      min: sum.min,
      max: sum.max,
    });
  }

  // ---------- /disconnect ----------

  private async handleDisconnect(): Promise<Response> {
    await this.disconnect();
    return json(200, { ok: true });
  }

  async disconnect(): Promise<void> {
    const refresh = await this.state.storage.get<string>(K_REFRESH);
    const subscriptionId =
      await this.state.storage.get<string>(K_SUBSCRIPTION);

    if (refresh && subscriptionId) {
      try {
        const tokens = await this.refresh();
        await deleteSubscription({
          accessToken: tokens.access_token,
          subscriptionId,
        });
      } catch (e) {
        console.warn("ghapi_subscription_delete_failed", { error: String(e) });
      }
    }
    if (refresh) {
      await revokeToken(refresh);
    }
    await this.state.storage.deleteAll();
  }

  // ---------- /status ----------

  private async handleStatus(): Promise<Response> {
    const map = await this.state.storage.get<unknown>([
      K_REFRESH,
      K_HEALTH_USER,
      K_SUBSCRIPTION,
      K_CREATED_AT,
      K_LAST_EVENT_AT,
      K_LAST_EVENT_SUMMARY,
      K_LAST_BACKFILL_AT,
    ]);
    const m = map as Map<string, unknown>;
    const connected = typeof m.get(K_REFRESH) === "string";
    return json(200, {
      connected,
      health_user_id:
        typeof m.get(K_HEALTH_USER) === "string" ? m.get(K_HEALTH_USER) : null,
      subscription_id:
        typeof m.get(K_SUBSCRIPTION) === "string"
          ? m.get(K_SUBSCRIPTION)
          : null,
      created_at:
        typeof m.get(K_CREATED_AT) === "number" ? m.get(K_CREATED_AT) : null,
      last_event_at:
        typeof m.get(K_LAST_EVENT_AT) === "number"
          ? m.get(K_LAST_EVENT_AT)
          : null,
      last_event_summary:
        typeof m.get(K_LAST_EVENT_SUMMARY) === "string"
          ? m.get(K_LAST_EVENT_SUMMARY)
          : null,
      last_backfill_at:
        typeof m.get(K_LAST_BACKFILL_AT) === "number"
          ? m.get(K_LAST_BACKFILL_AT)
          : null,
    });
  }

  // ---------- helpers ----------

  private async refresh(): Promise<{ access_token: string }> {
    const refresh = await this.state.storage.get<string>(K_REFRESH);
    if (!refresh) throw new Error("no_refresh_token");
    const clientId = await resolve(this.env.GOOGLE_HEALTH_CLIENT_ID);
    const clientSecret = await resolve(this.env.GOOGLE_HEALTH_CLIENT_SECRET);
    if (!clientId || !clientSecret) {
      throw new Error("ghapi_oauth_client_unconfigured");
    }
    return await refreshAccessToken(refresh, clientId, clientSecret);
  }
}

async function resolve(
  v: { get(): Promise<string> } | string | undefined,
): Promise<string> {
  if (!v) return "";
  return typeof v === "string" ? v : await v.get();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

