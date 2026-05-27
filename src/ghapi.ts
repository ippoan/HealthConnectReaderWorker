/**
 * Google Health API client。
 *
 * GhapiSubscriberDO から呼ばれる薄い fetch helper。
 *
 *   - refreshAccessToken: refresh_token → access_token (oauth2.googleapis.com)
 *   - revokeToken:        OAuth token revoke (google logout 相当)
 *   - listExercisePoints: dataPoints:list で intervals[] 範囲を取る
 *   - createSubscription / deleteSubscription: webhook subscription 管理 (stub)
 *
 * 注: webhook subscription endpoint は 2026/5 時点で "coming soon" のため
 * createSubscription / deleteSubscription は **stub** (ID を返すだけ、real
 * API は叩かない)。GA タイミングで `fetch()` 実装に差し替える。Refs #60
 */

export const GHAPI_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GHAPI_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GHAPI_DATA_BASE = "https://health.googleapis.com/v4";

export interface GhapiWebhookPayload {
  data?: {
    healthUserId?: string;
    dataType?: string;
    operation?: string;
    intervals?: Array<{ startTimeMillis: number; endTimeMillis: number }>;
  };
}

export interface GhapiDataPoint {
  id?: string;
  startTimeMillis?: number;
  endTimeMillis?: number;
  dataType?: string;
  value?: Record<string, unknown>;
}

export interface RefreshedToken {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshedToken> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const resp = await fetchImpl(GHAPI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`ghapi_refresh_failed:${resp.status}:${text.slice(0, 200)}`);
  }
  return (await resp.json()) as RefreshedToken;
}

export async function revokeToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // revoke は best-effort (失敗しても DO の clear は進める)
  try {
    await fetchImpl(`${GHAPI_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
      method: "POST",
    });
  } catch {
    /* ignore */
  }
}

/**
 * 指定 intervals[] 範囲の Exercise data points を全て取得。
 * Google Health の `dataPoints:list` は paginated でも実用上 1 webhook 通知
 * は分割されないことを想定して 1 page 取得のみ (将来 nextPageToken 対応)。
 */
export async function listExercisePoints(
  accessToken: string,
  intervals: Array<{ startTimeMillis: number; endTimeMillis: number }>,
  fetchImpl: typeof fetch = fetch,
): Promise<GhapiDataPoint[]> {
  const out: GhapiDataPoint[] = [];
  for (const iv of intervals) {
    const url =
      `${GHAPI_DATA_BASE}/users/me/dataSources/Exercise/dataPoints:list` +
      `?startTime=${encodeURIComponent(new Date(iv.startTimeMillis).toISOString())}` +
      `&endTime=${encodeURIComponent(new Date(iv.endTimeMillis).toISOString())}`;
    const resp = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `ghapi_list_failed:${resp.status}:${text.slice(0, 200)}`,
      );
    }
    const j = (await resp.json()) as { dataPoints?: GhapiDataPoint[] };
    if (Array.isArray(j.dataPoints)) out.push(...j.dataPoints);
  }
  return out;
}

/**
 * Webhook subscription 作成 stub。
 *
 * Google Health API の subscription endpoint は 2026/5 時点 "coming soon"
 * のため、ここでは UUID を返すのみ。real API が GA されたら fetch() に
 * 差し替える。subscription_id は DO storage に保存される。
 *
 * 戻り値: { subscriptionId } — DO は revoke / 切断時にこれを使う。
 */
export async function createSubscription(_args: {
  accessToken: string;
  webhookUrl: string;
  endpointAuthorization: string;
}): Promise<{ subscriptionId: string }> {
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(rand)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { subscriptionId: `stub-${hex}` };
}

export async function deleteSubscription(_args: {
  accessToken: string;
  subscriptionId: string;
}): Promise<void> {
  /* stub */
}
