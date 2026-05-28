/**
 * Google Health API (ghapi) Exercise data point の取込ロジック。
 *
 * webhook 駆動 (`GhapiSubscriberDO.onWebhook`) と polling backfill
 * (`GhapiSubscriberDO.handleBackfill`) の両方から呼ばれる共通処理:
 *
 *   1. R2 PUT: `ghapi/{dataType}/{yyyy}/{mm-dd}.json` (intervals[0] の JST 日付基準)
 *   2. D1 upsert: Exercise dataType のみ `ghapiExercisePointToRow` で正規化して upsert
 *
 * DO 状態に依存しない純関数として切り出すことで、R2/D1 binding だけ渡せば
 * 単体テストできる (DO / global fetch の mock 不要)。
 *
 * Refs ippoan/HealthConnectReaderWorker#60
 */

import { JST_OFFSET_MS, type GhapiDataPoint } from "./ghapi";
import { ghapiExercisePointToRow, upsertWorkout, type WorkoutRow } from "./db";

export interface GhapiInterval {
  startTimeMillis: number;
  endTimeMillis: number;
}

export interface IngestResult {
  rawKey: string;
  fetched: number;
  indexed: number;
  /** upsert した行 (HR enrichment 等の後処理で id / 期間を使う)。 */
  rows: WorkoutRow[];
}

const DAY_MS = 86_400_000;

/** HC 経由の exercise session は時刻がずれることがあるため、HR 取得窓を前後に
 *  広げて Fitbit 等別デバイスの HR を取りこぼさないようにするマージン。 */
export const HR_PAD_MS = 5 * 60_000;

/** 心拍時系列 R2 key。backfill が書き、`/api/ghapi/workout?id=` が読む。 */
export function hrSeriesKey(id: string): string {
  return `ghapi/hr/${id}.json`;
}

/** epoch ms を JST 暦日の 00:00 (= JST midnight) の epoch ms に丸める。 */
function jstMidnight(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
}

/**
 * backfill で走査する JST 暦日 (各日の 00:00 JST の epoch ms) を新しい順に列挙する。
 *
 * Google Health の `civil_start_time` は端末ローカル時刻 (= JST) の暦日なので、
 * 走査境界も JST で揃える。UTC で丸めると JST と最大 1 日ズレ、JST 朝〜日中の
 * backfill で当日 (JST) 分が range から落ちる。Refs #85
 *
 * - `force` または `lastBackfillAt` 無し → 過去 `days` 日 (今日含む) 全件
 * - それ以外 (差分取込) → `lastBackfillAt` の暦日以降だけ。ただし N 日 window の
 *   下限を超えて遡らない (= 範囲は [max(today-N+1, lastBackfillDay) .. today])。
 *
 * 戻り値は今日 → 過去の順 (新しい順)。1 要素以上を必ず返す。
 */
export function backfillDayStarts(
  now: number,
  days: number,
  lastBackfillAt: number | null | undefined,
  force: boolean,
): { dayStarts: number[]; incremental: boolean } {
  const clampedDays = Math.max(1, Math.min(365, Math.floor(days)));
  const todayMidnight = jstMidnight(now);
  let oldestMidnight = todayMidnight - (clampedDays - 1) * DAY_MS;
  let incremental = false;
  if (
    !force &&
    typeof lastBackfillAt === "number" &&
    Number.isFinite(lastBackfillAt)
  ) {
    const lastMidnight = jstMidnight(lastBackfillAt);
    if (lastMidnight > oldestMidnight) {
      oldestMidnight = lastMidnight;
      incremental = true;
    }
  }
  const dayStarts: number[] = [];
  for (let d = todayMidnight; d >= oldestMidnight; d -= DAY_MS) {
    dayStarts.push(d);
  }
  return { dayStarts, incremental };
}

/**
 * 1 つの dataType + intervals の data points を R2/D1 に取り込む。
 * R2 key は `intervals[0]` の JST 日付で決まるため、呼び出し側は **1 日分ずつ**
 * 渡すこと (日跨ぎ点が同一ファイルに混ざるのを避ける)。civil_start_time filter /
 * 表示層の JST グルーピングと暦日を揃えるため UTC ではなく JST 基準。Refs #85
 */
export async function ingestExercisePoints(
  r2: R2Bucket,
  db: D1Database,
  dataType: string,
  intervals: GhapiInterval[],
  points: GhapiDataPoint[],
): Promise<IngestResult> {
  if (intervals.length === 0) {
    return { rawKey: "", fetched: points.length, indexed: 0, rows: [] };
  }

  const firstStart = new Date(intervals[0]!.startTimeMillis + JST_OFFSET_MS);
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
    await r2.put(rawKey, body, {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (e) {
    console.error("ghapi_r2_put_failed", { error: String(e), rawKey });
  }

  let indexed = 0;
  const rows: WorkoutRow[] = [];
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
        await upsertWorkout(db, row);
        indexed++;
        rows.push(row);
      } catch (e) {
        console.warn("ghapi_upsert_failed", { error: String(e), id: row.id });
      }
    }
  }

  return { rawKey, fetched: points.length, indexed, rows };
}
