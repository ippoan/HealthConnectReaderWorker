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
  refreshAccessToken,
  revokeToken,
  type GhapiDataPoint,
  type GhapiWebhookPayload,
} from "../ghapi";
import { ghapiExercisePointToRow, upsertWorkout } from "../db";

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

    // R2 PUT: ghapi/{dataType}/{yyyy}/{mm-dd}.json (intervals[0] の startTime 基準)
    const firstStart = new Date(intervals[0].startTimeMillis);
    const yyyy = String(firstStart.getUTCFullYear()).padStart(4, "0");
    const mm = String(firstStart.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(firstStart.getUTCDate()).padStart(2, "0");
    const rawKey = `ghapi/${dataType}/${yyyy}/${mm}-${dd}.json`;
    const body = JSON.stringify({
      dataType,
      receivedAt: new Date().toISOString(),
      intervals,
      points,
    });
    try {
      await this.env.R2.put(rawKey, body, {
        httpMetadata: { contentType: "application/json" },
      });
    } catch (e) {
      console.error("ghapi_r2_put_failed", { error: String(e), rawKey });
    }

    // D1 upsert (Exercise dataType のみ)
    let indexed = 0;
    if (dataType === "Exercise" && points.length > 0) {
      const uploadedAt = new Date().toISOString();
      for (const p of points) {
        const row = await ghapiExercisePointToRow(
          p as Record<string, unknown>,
          rawKey,
          uploadedAt,
        );
        if (row === null) continue;
        try {
          await upsertWorkout(this.env.DB, row);
          indexed++;
        } catch (e) {
          console.warn("ghapi_upsert_failed", { error: String(e), id: row.id });
        }
      }
    }

    await this.state.storage.put({
      [K_LAST_EVENT_AT]: Date.now(),
      [K_LAST_EVENT_SUMMARY]: `${dataType}:${points.length} points, ${indexed} indexed`,
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

