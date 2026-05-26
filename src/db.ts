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
 * HC (Android Health Connect) payload を D1 workouts row[] に正規化する。
 *
 * HC payload shape (HealthReader.kt 生成):
 *   { date, collectedAt, sessions: [{startTime, endTime, exerciseType, title, source}],
 *     distances: [{startTime, endTime, km, source}],
 *     speeds: [{startTime, endTime, source, samples: [{time, kmh}]}] }
 *
 * 1 ExerciseSession を 1 workouts row に変換する。session 期間と overlap する
 * distance record を合算して `distance_m` に入れる (session 自体は距離を持たない)。
 *
 * id 規約: `hc:{startTime}:{exerciseType}` の SHA-256 先頭 16hex。
 *   → 同一 session の再 upload で安定 (= upsert が効く)。
 *   → exerciseType 違いの同時刻 session を別 row として保持できる。
 *
 * activity_name は HC `exerciseType` (Int) を簡易マッピング。未知 ID は
 * `exercise_${id}` の機械的文字列にしておく (後付で table 化可能)。
 *
 * Refs ippoan/HealthConnectReaderWorker#18
 */
export async function hcPayloadToRows(
  payload: Record<string, unknown>,
  rawKey: string,
  date: string,
  uploadedAt: string,
): Promise<WorkoutRow[]> {
  const sessions = Array.isArray(payload.sessions)
    ? (payload.sessions as unknown[])
    : [];
  const distances = Array.isArray(payload.distances)
    ? (payload.distances as unknown[])
    : [];

  const rows: WorkoutRow[] = [];
  for (const s of sessions) {
    if (!s || typeof s !== "object") continue;
    const startAt = (s as { startTime?: unknown }).startTime;
    const endAt = (s as { endTime?: unknown }).endTime;
    const exerciseType = (s as { exerciseType?: unknown }).exerciseType;
    const title = (s as { title?: unknown }).title;
    if (typeof startAt !== "string" || typeof endAt !== "string") continue;
    const sessionDate = sessionDateUtc(startAt) ?? date;
    const id = await hcSessionId(startAt, exerciseType);
    const distanceM = overlapDistanceMeters(distances, startAt, endAt);
    const durationSec = isoDurationSec(startAt, endAt);
    rows.push({
      id,
      source: "hc",
      date: sessionDate,
      start_at: startAt,
      end_at: endAt,
      activity_name:
        typeof title === "string" && title.length > 0
          ? title
          : hcExerciseName(exerciseType),
      distance_m: distanceM,
      duration_sec: durationSec,
      active_calories: null,
      steps: null,
      avg_heart_rate: null,
      raw_key: rawKey,
      uploaded_at: uploadedAt,
    });
  }
  return rows;
}

function sessionDateUtc(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isoDurationSec(startAt: string, endAt: string): number | null {
  const s = Date.parse(startAt);
  const e = Date.parse(endAt);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
  return Math.round((e - s) / 1000);
}

function overlapDistanceMeters(
  distances: unknown[],
  startAt: string,
  endAt: string,
): number | null {
  const s = Date.parse(startAt);
  const e = Date.parse(endAt);
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  let totalKm = 0;
  let matched = 0;
  for (const d of distances) {
    if (!d || typeof d !== "object") continue;
    const ds = Date.parse(
      String((d as { startTime?: unknown }).startTime ?? ""),
    );
    const de = Date.parse(String((d as { endTime?: unknown }).endTime ?? ""));
    const km = (d as { km?: unknown }).km;
    if (Number.isNaN(ds) || Number.isNaN(de) || typeof km !== "number") continue;
    // session 期間と overlap する distance record を合算 (区間切り出しはしない)。
    if (ds < e && de > s) {
      totalKm += km;
      matched++;
    }
  }
  return matched > 0 ? Math.round(totalKm * 1000) : null;
}

async function hcSessionId(
  startAt: string,
  exerciseType: unknown,
): Promise<string> {
  const seed = `hc:${startAt}:${typeof exerciseType === "number" ? exerciseType : "x"}`;
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(seed),
  );
  const hex: string[] = [];
  const view = new Uint8Array(buf);
  for (let i = 0; i < 8; i++) hex.push(view[i].toString(16).padStart(2, "0"));
  return `hc_${hex.join("")}`;
}

// HC `ExerciseSessionRecord.EXERCISE_TYPE_*` の主要値 → 表示名。
// 完全網羅は repo 外 (Android SDK の定数表) なので、未知は `exercise_${id}` で
// 落として後で table 化する。Refs ippoan/HealthConnectReader#6
const HC_EXERCISE_NAMES: Record<number, string> = {
  56: "ランニング",   // EXERCISE_TYPE_RUNNING
  79: "ウォーキング", // EXERCISE_TYPE_WALKING
  8: "サイクリング",  // EXERCISE_TYPE_BIKING
  37: "ハイキング",   // EXERCISE_TYPE_HIKING
  69: "水泳 (プール)",// EXERCISE_TYPE_SWIMMING_POOL
  70: "水泳 (オープン)",// EXERCISE_TYPE_SWIMMING_OPEN_WATER
};

function hcExerciseName(exerciseType: unknown): string | null {
  if (typeof exerciseType !== "number") return null;
  return HC_EXERCISE_NAMES[exerciseType] ?? `exercise_${exerciseType}`;
}

/**
 * D1 から HC + Zones の workouts を新しい順に取得。filter は呼び元で。
 */
export async function listWorkouts(
  db: D1Database,
  opts: { source?: "hc" | "zones"; limit?: number } = {},
): Promise<WorkoutRow[]> {
  const limit = opts.limit ?? 1000;
  const stmt = opts.source
    ? db.prepare(
        `SELECT * FROM workouts WHERE source = ? ORDER BY uploaded_at DESC LIMIT ?`,
      ).bind(opts.source, limit)
    : db.prepare(
        `SELECT * FROM workouts ORDER BY uploaded_at DESC LIMIT ?`,
      ).bind(limit);
  const result = await stmt.all<WorkoutRow>();
  return result.results ?? [];
}

/**
 * 過去 [days] 日分 (= 今日含む UTC) の workouts を date 降順 + start_at 降順で
 * 取得する。1 日 0 件の date は返さない (DB 上に行が無いため)。
 */
export async function listWorkoutsSinceDays(
  db: D1Database,
  days: number,
): Promise<WorkoutRow[]> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - (days - 1));
  const sinceStr = `${since.getUTCFullYear()}-${String(since.getUTCMonth() + 1).padStart(2, "0")}-${String(since.getUTCDate()).padStart(2, "0")}`;
  const stmt = db.prepare(
    `SELECT * FROM workouts WHERE date >= ? ORDER BY date DESC, start_at DESC`,
  );
  const result = await stmt.bind(sinceStr).all<WorkoutRow>();
  return result.results ?? [];
}

/**
 * `/api/workouts` の 1 アイテム。3 種:
 * - `matched`: HC と Zones が時刻 overlap で対応した
 * - `hc_only`: HC session のみ (= Apple Watch 未装着 or Zones 未 upload)
 * - `zones_only`: Zones workout のみ (= 端末未同期 / HC 未 upload)
 */
export type WorkoutMatchItem =
  | { type: "matched"; hc: WorkoutRow; zones: WorkoutRow; overlap_sec: number }
  | { type: "hc_only"; hc: WorkoutRow }
  | { type: "zones_only"; zones: WorkoutRow };

export interface WorkoutDay {
  date: string;
  hc_count: number;
  zones_count: number;
  matched_count: number;
  items: WorkoutMatchItem[];
}

/**
 * 1 日分の rows を HC × Zones で greedy ペアリング。
 *
 * - 同日でも start_at の Z (UTC) 時刻区間が overlap しない場合は別 workout 扱い
 * - HC を start_at 昇順で走査し、各 HC に対して overlap_sec が最大の未使用
 *   Zones を 1 つ割り当てる。残り Zones は zones_only として出す
 * - start_at / end_at が null の row は overlap 判定不能なので **常に _only** 扱い
 *
 * Refs ippoan/HealthConnectReaderWorker#18
 */
export function pairHcZones(rows: WorkoutRow[]): WorkoutMatchItem[] {
  const hcAll = rows.filter((r) => r.source === "hc");
  const zonesAll = rows.filter((r) => r.source === "zones");
  // start_at 昇順で安定 (DESC fetch を引っくり返す)
  const hcs = [...hcAll].sort(byStartAtAsc);
  const remainingZones = new Set(zonesAll);
  const items: WorkoutMatchItem[] = [];

  for (const hc of hcs) {
    if (hc.start_at === null || hc.end_at === null) {
      items.push({ type: "hc_only", hc });
      continue;
    }
    const hcStart = Date.parse(hc.start_at);
    const hcEnd = Date.parse(hc.end_at);
    if (Number.isNaN(hcStart) || Number.isNaN(hcEnd)) {
      items.push({ type: "hc_only", hc });
      continue;
    }
    let best: WorkoutRow | null = null;
    let bestOverlap = 0;
    for (const z of remainingZones) {
      if (z.start_at === null || z.end_at === null) continue;
      const zs = Date.parse(z.start_at);
      const ze = Date.parse(z.end_at);
      if (Number.isNaN(zs) || Number.isNaN(ze)) continue;
      const overlap = Math.max(0, Math.min(hcEnd, ze) - Math.max(hcStart, zs));
      if (overlap > bestOverlap) {
        best = z;
        bestOverlap = overlap;
      }
    }
    if (best) {
      items.push({
        type: "matched",
        hc,
        zones: best,
        overlap_sec: Math.round(bestOverlap / 1000),
      });
      remainingZones.delete(best);
    } else {
      items.push({ type: "hc_only", hc });
    }
  }
  for (const z of remainingZones) {
    items.push({ type: "zones_only", zones: z });
  }
  // 全アイテムを start_at 昇順で並び替え (1 日に複数 workout がある時、
  // matched / hc_only / zones_only を区別せず時系列で読めるようにする)。
  items.sort((a, b) => {
    const av = startAtOf(a);
    const bv = startAtOf(b);
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  return items;
}

function startAtOf(it: WorkoutMatchItem): string {
  if (it.type === "matched") return it.hc.start_at ?? "";
  if (it.type === "hc_only") return it.hc.start_at ?? "";
  return it.zones.start_at ?? "";
}

function byStartAtAsc(a: WorkoutRow, b: WorkoutRow): number {
  const av = a.start_at ?? "";
  const bv = b.start_at ?? "";
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/**
 * 日付ごとにグルーピング + マッチング。date 降順で返す。
 */
export function groupAndMatch(rows: WorkoutRow[]): WorkoutDay[] {
  const byDate = new Map<string, WorkoutRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  const days: WorkoutDay[] = [];
  for (const [date, dayRows] of byDate) {
    const items = pairHcZones(dayRows);
    days.push({
      date,
      hc_count: dayRows.filter((r) => r.source === "hc").length,
      zones_count: dayRows.filter((r) => r.source === "zones").length,
      matched_count: items.filter((it) => it.type === "matched").length,
      items,
    });
  }
  days.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return days;
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
