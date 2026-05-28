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

/**
 * JST (Asia/Tokyo) の UTC offset (ms)。DST 無しの固定 +09:00。
 *
 * Google Health の `civil_start_time` は端末ローカル時刻 (= JST) の暦日なので、
 * backfill の暦日境界も civil 日付 filter も JST で揃える必要がある。UTC で
 * 計算すると JST と最大 1 日ズレ、JST 朝〜日中の backfill で当日 (JST) 分が
 * range から落ちて「昨日までしか取れない」状態になる。Refs #85
 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** epoch ms を JST 暦日 (`YYYY-MM-DD`) に変換する。 */
export function jstDateString(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export interface GhapiWebhookPayload {
  data?: {
    healthUserId?: string;
    dataType?: string;
    operation?: string;
    intervals?: Array<{ startTimeMillis: number; endTimeMillis: number }>;
  };
}

/**
 * Google Health API v4 `exercise` dataPoint。
 * `GET /v4/users/me/dataTypes/exercise/dataPoints` のレスポンス要素。
 *
 *   {
 *     "name": "users/me/dataTypes/exercise/dataPoints/<id>",
 *     "exercise": {
 *       "interval": { "startTime": "<RFC3339>", "endTime": "<RFC3339>", ... },
 *       "activeDuration": "1234s",
 *       "exerciseType": "RUNNING",
 *       "displayName": "...",
 *       "metricsSummary": {
 *         "caloriesKcal": 320,
 *         "distanceMillimeters": 5230500,
 *         "averageHeartRateBeatsPerMinute": "152",   // int64 は文字列で返る
 *         "steps": "5400"                            // int64 は文字列で返る
 *       }
 *     }
 *   }
 *
 * 注: Google Health API v4 は **int64 系フィールドを protobuf JSON 規約で文字列**
 * として返す (`steps`, `averageHeartRateBeatsPerMinute` 等)。double 系
 * (`caloriesKcal`, `distanceMillimeters`) は number。型は両形態を許容し、
 * 取り出し側 (`ghapiExercisePointToRow`) で tolerant parse する。
 * min/max 心拍は exercise summary に存在しない (平均 HR のみ)。Refs #65
 */
export interface GhapiDataPoint {
  name?: string;
  exercise?: {
    interval?: {
      startTime?: string;
      endTime?: string;
    };
    activeDuration?: string;
    exerciseType?: string;
    displayName?: string;
    metricsSummary?: {
      caloriesKcal?: number | string;
      distanceMillimeters?: number | string;
      averageHeartRateBeatsPerMinute?: number | string;
      steps?: number | string;
    };
  };
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
 * 指定 intervals[] 範囲の exercise data points を取得。
 *
 * Google Health API v4:
 *   `GET /v4/users/me/dataTypes/exercise/dataPoints?filter=<AIP-160>`
 * filter は civil 日付で範囲指定する (AIP-160):
 *   `exercise.interval.civil_start_time >= "2026-05-01" AND
 *    exercise.interval.civil_start_time < "2026-05-02"`
 * `civil_start_time` は端末ローカル時刻 (= JST) の暦日なので、各 interval の
 * startTimeMillis / endTimeMillis は **JST 暦日**に丸めて使う (backfill は JST
 * midnight 境界で 1 日ずつ渡す前提)。UTC で丸めると JST と最大 1 日ズレて当日分が
 * range から落ちる。nextPageToken を辿って全 page 取得する。Refs #85
 *
 * scope: `googlehealth.activity_and_fitness(.readonly)` が必要。
 */
export async function listExercisePoints(
  accessToken: string,
  intervals: Array<{ startTimeMillis: number; endTimeMillis: number }>,
  fetchImpl: typeof fetch = fetch,
): Promise<GhapiDataPoint[]> {
  const out: GhapiDataPoint[] = [];
  for (const iv of intervals) {
    const startDate = jstDateString(iv.startTimeMillis);
    const endDate = jstDateString(iv.endTimeMillis);
    const filter =
      `exercise.interval.civil_start_time >= "${startDate}" AND ` +
      `exercise.interval.civil_start_time < "${endDate}"`;
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ pageSize: "1000", filter });
      if (pageToken) params.set("pageToken", pageToken);
      const url = `${GHAPI_DATA_BASE}/users/me/dataTypes/exercise/dataPoints?${params.toString()}`;
      const resp = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`ghapi_list_failed:${resp.status}:${text.slice(0, 200)}`);
      }
      const j = (await resp.json()) as {
        dataPoints?: GhapiDataPoint[];
        nextPageToken?: string;
      };
      if (Array.isArray(j.dataPoints)) out.push(...j.dataPoints);
      pageToken = j.nextPageToken;
    } while (pageToken);
  }
  return out;
}

export interface HrSample {
  /** epoch ms (sampleTime.physicalTime) */
  t: number;
  bpm: number;
}

/**
 * 指定 interval の心拍サンプルを取得 (`heart-rate` dataType)。
 *
 * Google Health API v4:
 *   `GET /v4/users/me/dataTypes/heart-rate/dataPoints?filter=<AIP-160>`
 * sample 型なので physical_time で範囲指定:
 *   `heart_rate.sample_time.physical_time >= "<RFC3339>" AND
 *    heart_rate.sample_time.physical_time < "<RFC3339>"`
 * レスポンス要素: `{ heartRate: { sampleTime: { physicalTime }, beatsPerMinute } }`。
 *
 * exercise session が HC (treadmill) 由来で HR を持たなくても、同じ時間帯に
 * 別デバイス (Fitbit 等) が記録した HR がこの dataType から時間 overlap で拾える。
 * bpm は int64 として文字列で返りうるので number / 数値文字列両対応。
 * scope は exercise と同じ `googlehealth.activity_and_fitness(.readonly)`。
 */
export async function listHeartRateSamples(
  accessToken: string,
  interval: { startTimeMillis: number; endTimeMillis: number },
  fetchImpl: typeof fetch = fetch,
): Promise<HrSample[]> {
  const startIso = new Date(interval.startTimeMillis).toISOString();
  const endIso = new Date(interval.endTimeMillis).toISOString();
  const filter =
    `heart_rate.sample_time.physical_time >= "${startIso}" AND ` +
    `heart_rate.sample_time.physical_time < "${endIso}"`;
  const out: HrSample[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: "10000", filter });
    if (pageToken) params.set("pageToken", pageToken);
    const url = `${GHAPI_DATA_BASE}/users/me/dataTypes/heart-rate/dataPoints?${params.toString()}`;
    const resp = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`ghapi_hr_list_failed:${resp.status}:${text.slice(0, 200)}`);
    }
    const j = (await resp.json()) as {
      dataPoints?: Array<{
        heartRate?: {
          sampleTime?: { physicalTime?: string };
          beatsPerMinute?: number | string;
        };
      }>;
      nextPageToken?: string;
    };
    for (const dp of j.dataPoints ?? []) {
      const ts = dp.heartRate?.sampleTime?.physicalTime;
      const rawBpm = dp.heartRate?.beatsPerMinute;
      const t = ts ? Date.parse(ts) : NaN;
      const bpm =
        typeof rawBpm === "number"
          ? rawBpm
          : typeof rawBpm === "string" && rawBpm.trim() !== ""
            ? Number(rawBpm)
            : NaN;
      if (Number.isFinite(t) && Number.isFinite(bpm)) out.push({ t, bpm });
    }
    pageToken = j.nextPageToken;
  } while (pageToken);
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** HR サンプル列から min / max / avg (整数) を計算。空なら null。 */
export function summarizeHr(
  samples: HrSample[],
): { min: number; max: number; avg: number; count: number } | null {
  if (samples.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const s of samples) {
    if (s.bpm < min) min = s.bpm;
    if (s.bpm > max) max = s.bpm;
    sum += s.bpm;
  }
  return {
    min: Math.round(min),
    max: Math.round(max),
    avg: Math.round(sum / samples.length),
    count: samples.length,
  };
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
