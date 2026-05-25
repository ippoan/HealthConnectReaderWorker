/**
 * `/api/zones` レスポンスの 1 件分。historical shape を維持 (UI 互換)。
 */
export interface ZonesListItem {
  date: string;       // YYYY-MM-DD (UTC)
  uuid: string;       // Zones の workout uuid
  key: string;        // R2 raw blob への pointer
  uploaded: string;   // ISO 8601 UTC
}

/**
 * D1 workouts テーブル row。HC / Zones 双方の workout 要約を 1 テーブルで保持。
 * 突合 (時刻 overlap での JOIN) を可能にするため、source ごとに start_at/end_at を
 * 取れるだけ取って入れる方針。
 */
export interface WorkoutRow {
  id: string;
  source: "hc" | "zones";
  date: string;                     // YYYY-MM-DD (UTC)
  start_at: string | null;          // ISO 8601 UTC
  end_at: string | null;            // ISO 8601 UTC
  activity_name: string | null;     // "ランニング" 等
  distance_m: number | null;        // m
  duration_sec: number | null;
  active_calories: number | null;   // kcal
  steps: number | null;
  avg_heart_rate: number | null;    // bpm
  raw_key: string;                  // R2 key
  uploaded_at: string;              // ISO 8601 UTC
}

/**
 * Zones (iOS) JSON から D1 workouts row を組み立てる。
 *
 * Zones の単位系:
 *   - `distance.unit`: "km" | "m"  → m に正規化
 *   - `duration.unit`: "sec"        → 秒のまま
 *   - `activeCalories.unit`: "kcal" → そのまま
 *   - `step.unit`: "歩" | "steps"   → 整数
 *   - heart rate: bpm
 *
 * 未知 unit の場合は null を入れる (= 後で集計から落ちる)。
 */
export function zonesPayloadToRow(
  payload: Record<string, unknown>,
  rawKey: string,
  date: string,
  uploadedAt: string,
): WorkoutRow {
  const uuid = String(payload.uuid);
  const startAt = typeof payload.startDate === "string" ? payload.startDate : null;
  const endAt = typeof payload.endDate === "string" ? payload.endDate : null;
  const activityName = typeof payload.name === "string" ? payload.name : null;

  return {
    id: uuid,
    source: "zones",
    date,
    start_at: startAt,
    end_at: endAt,
    activity_name: activityName,
    distance_m: pickMeters(payload.distance),
    duration_sec: pickSeconds(payload.duration),
    active_calories: pickKcal(payload.activeCalories),
    steps: pickInt(payload.step),
    avg_heart_rate: pickInt(payload.averageHeartRate),
    raw_key: rawKey,
    uploaded_at: uploadedAt,
  };
}

function pickMeters(v: unknown): number | null {
  if (!v || typeof v !== "object") return null;
  const value = (v as { value?: unknown }).value;
  const unit = (v as { unit?: unknown }).unit;
  if (typeof value !== "number") return null;
  if (unit === "km") return value * 1000;
  if (unit === "m") return value;
  return null;
}

function pickSeconds(v: unknown): number | null {
  if (!v || typeof v !== "object") return null;
  const value = (v as { value?: unknown }).value;
  const unit = (v as { unit?: unknown }).unit;
  if (typeof value !== "number") return null;
  if (unit === "sec" || unit === "s") return Math.round(value);
  if (unit === "min") return Math.round(value * 60);
  if (unit === "hr" || unit === "hour") return Math.round(value * 3600);
  return null;
}

function pickKcal(v: unknown): number | null {
  if (!v || typeof v !== "object") return null;
  const value = (v as { value?: unknown }).value;
  const unit = (v as { unit?: unknown }).unit;
  if (typeof value !== "number") return null;
  if (unit === "kcal" || unit === "Cal") return value;
  return null;
}

function pickInt(v: unknown): number | null {
  if (typeof v === "number") return Math.round(v);
  if (!v || typeof v !== "object") return null;
  const value = (v as { value?: unknown }).value;
  return typeof value === "number" ? Math.round(value) : null;
}

const COLUMNS = [
  "id",
  "source",
  "date",
  "start_at",
  "end_at",
  "activity_name",
  "distance_m",
  "duration_sec",
  "active_calories",
  "steps",
  "avg_heart_rate",
  "raw_key",
  "uploaded_at",
] as const;

const PLACEHOLDERS = COLUMNS.map(() => "?").join(", ");
const UPSERT_SQL = `INSERT INTO workouts (${COLUMNS.join(", ")}) VALUES (${PLACEHOLDERS})
  ON CONFLICT (source, id) DO UPDATE SET
    date=excluded.date,
    start_at=excluded.start_at,
    end_at=excluded.end_at,
    activity_name=excluded.activity_name,
    distance_m=excluded.distance_m,
    duration_sec=excluded.duration_sec,
    active_calories=excluded.active_calories,
    steps=excluded.steps,
    avg_heart_rate=excluded.avg_heart_rate,
    raw_key=excluded.raw_key,
    uploaded_at=excluded.uploaded_at`;

/**
 * workouts に upsert。同 (source, id) があれば全カラム更新 (= 再 upload は idempotent)。
 */
export async function upsertWorkout(db: D1Database, row: WorkoutRow): Promise<void> {
  await db
    .prepare(UPSERT_SQL)
    .bind(
      row.id,
      row.source,
      row.date,
      row.start_at,
      row.end_at,
      row.activity_name,
      row.distance_m,
      row.duration_sec,
      row.active_calories,
      row.steps,
      row.avg_heart_rate,
      row.raw_key,
      row.uploaded_at,
    )
    .run();
}

/**
 * D1 から Zones (source='zones') 一覧を新しい順に取得。
 * `/api/zones` の表示は引き続き `{date, uuid, key, uploaded}` shape を返すので、
 * 既存の `ZonesListItem` 型を使い回す。
 */
export async function listZonesFromDb(
  db: D1Database,
  limit = 1000,
): Promise<ZonesListItem[]> {
  const stmt = db.prepare(
    `SELECT id, date, raw_key, uploaded_at
       FROM workouts
      WHERE source = 'zones'
      ORDER BY uploaded_at DESC
      LIMIT ?`,
  );
  const result = await stmt.bind(limit).all<{
    id: string;
    date: string;
    raw_key: string;
    uploaded_at: string;
  }>();
  return (result.results ?? []).map((r) => ({
    date: r.date,
    uuid: r.id,
    key: r.raw_key,
    uploaded: r.uploaded_at,
  }));
}
