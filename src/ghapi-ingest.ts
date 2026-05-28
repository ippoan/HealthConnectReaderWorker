/**
 * Google Health API (ghapi) Exercise data point の取込ロジック。
 *
 * webhook 駆動 (`GhapiSubscriberDO.onWebhook`) と polling backfill
 * (`GhapiSubscriberDO.handleBackfill`) の両方から呼ばれる共通処理:
 *
 *   1. R2 PUT: `ghapi/{dataType}/{yyyy}/{mm-dd}.json` (intervals[0] の UTC 日付基準)
 *   2. D1 upsert: Exercise dataType のみ `ghapiExercisePointToRow` で正規化して upsert
 *
 * DO 状態に依存しない純関数として切り出すことで、R2/D1 binding だけ渡せば
 * 単体テストできる (DO / global fetch の mock 不要)。
 *
 * Refs ippoan/HealthConnectReaderWorker#60
 */

import type { GhapiDataPoint } from "./ghapi";
import { ghapiExercisePointToRow, upsertWorkout } from "./db";

export interface GhapiInterval {
  startTimeMillis: number;
  endTimeMillis: number;
}

export interface IngestResult {
  rawKey: string;
  fetched: number;
  indexed: number;
}

/**
 * 1 つの dataType + intervals の data points を R2/D1 に取り込む。
 * R2 key は `intervals[0]` の UTC 日付で決まるため、呼び出し側は **1 日分ずつ**
 * 渡すこと (日跨ぎ点が同一ファイルに混ざるのを避ける)。
 */
export async function ingestExercisePoints(
  r2: R2Bucket,
  db: D1Database,
  dataType: string,
  intervals: GhapiInterval[],
  points: GhapiDataPoint[],
): Promise<IngestResult> {
  if (intervals.length === 0) {
    return { rawKey: "", fetched: points.length, indexed: 0 };
  }

  const firstStart = new Date(intervals[0]!.startTimeMillis);
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
      } catch (e) {
        console.warn("ghapi_upsert_failed", { error: String(e), id: row.id });
      }
    }
  }

  return { rawKey, fetched: points.length, indexed };
}
