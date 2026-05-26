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

/**
 * HC ExerciseSession の D1 row id を組み立てる。
 * **Worker と Android で完全に同じ規約**: `hc:<startTime>:<exerciseType>` の
 * SHA-256 上位 16 hex を `hc_` prefix で囲む。
 * Android 側 (HCBridge.kt) で同じハッシュを計算して /api/known-hc-ids と
 * 突合することで「未知 session だけ upload」を実現する。Refs #18
 */
export async function hcSessionId(
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
 * 過去 [days] 日分の workouts を取得。**JST 日付基準**で N 日分欲しいが、
 * DB の `date` 列は UTC 由来なため、JST date と UTC date が最大 1 日ズレる
 * (= JST 00:00-09:00 の row は UTC で前日扱い)。安全側に 1 日 buffer を取って
 * UTC date >= today_utc - days の range で fetch し、グルーピング層で JST 日付
 * を再計算して N 日分に絞り込む。
 */
/**
 * 過去 [days] 日分の HC workouts の **id のみ** を取得する (= /api/known-hc-ids 用)。
 * Android が同じ規約で計算した session id 集合と比較して、未知のものだけ
 * upload する diff-upload を実現するため。
 *
 * Refs ippoan/HealthConnectReaderWorker#18
 */
export async function listKnownHcIds(
  db: D1Database,
  days: number,
): Promise<string[]> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = `${since.getUTCFullYear()}-${String(since.getUTCMonth() + 1).padStart(2, "0")}-${String(since.getUTCDate()).padStart(2, "0")}`;
  const result = await db
    .prepare(`SELECT id FROM workouts WHERE source = 'hc' AND date >= ? ORDER BY date DESC`)
    .bind(sinceStr)
    .all<{ id: string }>();
  return (result.results ?? []).map((r) => r.id);
}

export async function listWorkoutsSinceDays(
  db: D1Database,
  days: number,
): Promise<WorkoutRow[]> {
  const since = new Date();
  // (days - 1) で「今日含む N 日」、+1 日 buffer で JST ↔ UTC のズレ吸収
  since.setUTCDate(since.getUTCDate() - days);
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
/**
 * `/api/workouts` の 1 アイテム。3 種:
 * - `matched`: HC と Zones の連結成分グループ (1:1 / 1:N / N:1 / N:N)。
 *   - `hcs[]`, `zoneses[]`: グループに含まれる行
 *   - `edges[]`: グループ内のエッジ (hc_id, zones_id, overlap_sec, manual)
 *   - `has_manual`: 1 つでも手動 pair edge が含まれていれば true
 * - `hc_only`: どの Zones とも繋がらなかった HC 単独
 * - `zones_only`: どの HC とも繋がらなかった Zones 単独
 */
export interface MatchEdge {
  hc_id: string;
  zones_id: string;
  overlap_sec: number;
  manual: boolean;
}
export type WorkoutMatchItem =
  | {
      type: "matched";
      hcs: WorkoutRow[];
      zoneses: WorkoutRow[];
      edges: MatchEdge[];
      has_manual: boolean;
    }
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
 * 1 日分の rows を **連結成分** で matched / hc_only / zones_only に分類する。
 *
 * グラフモデル: nodes = HC rows ∪ Zones rows。edges:
 *   1. **manual pair** (workout_pairs): 必ず張る
 *   2. **auto pair** (時刻 overlap > 0 の HC↔Zones): unpair に登録されていない
 *      限り張る (= workout_unpairs で否定済みの自動マッチは無効化される)
 *
 * Union-Find で連結成分を抜き、各成分について:
 *   - HC ≥1 ∧ Zones ≥1 → matched (1:1 / 1:N / N:1 / N:N すべて含む)
 *   - HC のみ → 各 row が hc_only として分裂
 *   - Zones のみ → 各 row が zones_only として分裂
 *
 * 同日内で「午前ワークアウト」「午後ワークアウト」みたいに自然に分かれるのは、
 * 時刻 overlap が無いので別の連結成分になるため。長時間 workout が複数 record
 * に分かれた場合 (= 1 HC + N Zones) も連結成分 1 つにまとまる。
 *
 * 出力は最も早い start_at で昇順 sort。
 *
 * Refs ippoan/HealthConnectReaderWorker#18
 */
export function pairHcZones(
  rows: WorkoutRow[],
  manualPairs: ReadonlySet<string> = new Set(),
  unpairs: ReadonlySet<string> = new Set(),
): WorkoutMatchItem[] {
  // `<hc_id>::<zones_id>` 形式の string set で manual / unpair を渡す
  const hcs = rows.filter((r) => r.source === "hc");
  const zones = rows.filter((r) => r.source === "zones");
  const hcById = new Map(hcs.map((h) => [h.id, h]));
  const zoneById = new Map(zones.map((z) => [z.id, z]));

  // (a) edge 列挙
  const edges: MatchEdge[] = [];
  // manual edges (両側がこの day グループに居る場合のみ)
  for (const key of manualPairs) {
    const [hcId, zId] = key.split("::");
    if (!hcId || !zId) continue;
    const hc = hcById.get(hcId);
    const z = zoneById.get(zId);
    if (!hc || !z) continue;
    edges.push({
      hc_id: hcId,
      zones_id: zId,
      overlap_sec: overlapSec(hc, z),
      manual: true,
    });
  }
  // auto edges (時刻 overlap > 0、unpair に無いもの)
  for (const hc of hcs) {
    if (!hc.start_at || !hc.end_at) continue;
    for (const z of zones) {
      if (!z.start_at || !z.end_at) continue;
      const ov = overlapSec(hc, z);
      if (ov <= 0) continue;
      const key = `${hc.id}::${z.id}`;
      if (unpairs.has(key)) continue;
      // 既に manual edge があるならスキップ (重複しない)
      if (manualPairs.has(key)) continue;
      edges.push({ hc_id: hc.id, zones_id: z.id, overlap_sec: ov, manual: false });
    }
  }

  // (b) Union-Find
  const parent = new Map<string, string>();
  const nodeId = (source: "hc" | "zones", id: string) => `${source}:${id}`;
  function find(x: string): string {
    if (!parent.has(x)) { parent.set(x, x); return x; }
    let root = x;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    // path compression
    let cur = x;
    while (parent.get(cur)! !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: string, b: string): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const h of hcs) find(nodeId("hc", h.id));
  for (const z of zones) find(nodeId("zones", z.id));
  for (const e of edges) union(nodeId("hc", e.hc_id), nodeId("zones", e.zones_id));

  // (c) グループ化
  interface Group { hcs: WorkoutRow[]; zoneses: WorkoutRow[]; edges: MatchEdge[]; }
  const groups = new Map<string, Group>();
  const getGroup = (root: string): Group => {
    let g = groups.get(root);
    if (!g) { g = { hcs: [], zoneses: [], edges: [] }; groups.set(root, g); }
    return g;
  };
  for (const h of hcs) getGroup(find(nodeId("hc", h.id))).hcs.push(h);
  for (const z of zones) getGroup(find(nodeId("zones", z.id))).zoneses.push(z);
  for (const e of edges) getGroup(find(nodeId("hc", e.hc_id))).edges.push(e);

  // (d) WorkoutMatchItem に成型
  const items: WorkoutMatchItem[] = [];
  for (const g of groups.values()) {
    if (g.hcs.length > 0 && g.zoneses.length > 0) {
      items.push({
        type: "matched",
        hcs: g.hcs.sort(byStartAtAsc),
        zoneses: g.zoneses.sort(byStartAtAsc),
        edges: g.edges,
        has_manual: g.edges.some((e) => e.manual),
      });
    } else if (g.hcs.length > 0) {
      for (const h of g.hcs) items.push({ type: "hc_only", hc: h });
    } else {
      for (const z of g.zoneses) items.push({ type: "zones_only", zones: z });
    }
  }
  // earliest start_at で昇順 sort
  items.sort((a, b) => {
    const av = startAtOf(a), bv = startAtOf(b);
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  return items;
}

function overlapSec(a: WorkoutRow, b: WorkoutRow): number {
  if (!a.start_at || !a.end_at || !b.start_at || !b.end_at) return 0;
  const as = Date.parse(a.start_at), ae = Date.parse(a.end_at);
  const bs = Date.parse(b.start_at), be = Date.parse(b.end_at);
  if (Number.isNaN(as) || Number.isNaN(ae) || Number.isNaN(bs) || Number.isNaN(be)) return 0;
  return Math.max(0, Math.round((Math.min(ae, be) - Math.max(as, bs)) / 1000));
}

function startAtOf(it: WorkoutMatchItem): string {
  if (it.type === "matched") {
    const all = [...it.hcs, ...it.zoneses].map((r) => r.start_at ?? "").filter(Boolean).sort();
    return all[0] ?? "";
  }
  if (it.type === "hc_only") return it.hc.start_at ?? "";
  return it.zones.start_at ?? "";
}

function byStartAtAsc(a: WorkoutRow, b: WorkoutRow): number {
  const av = a.start_at ?? "";
  const bv = b.start_at ?? "";
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/**
 * `start_at` (UTC ISO) を JST (UTC+9) のカレンダー日付に変換する。
 * 朝の workout が UTC で前日扱いになる問題を解消するため、表示・マッチング時に
 * 使う。null / 不正値は null。
 *
 * 例: UTC 2026-05-24T20:00:00Z → JST 2026-05-25T05:00 → "2026-05-25"
 *
 * 注: TZ は現状 JST 固定。多 TZ 対応する場合は env / cookie / Accept-Language
 * 由来の offset を受け取るよう拡張する。
 */
function jstDateOf(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 9 * 3600 * 1000);
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 日付ごとにグルーピング + マッチング。date 降順で返す。
 *
 * グループキーは **start_at を JST に変換した日付** を使う。R2 の hc/{UTC日}.json
 * key 規約や D1 の `date` 列が UTC ベースなため、user の体感日付 (JST 朝の
 * workout が UTC で前日扱い) とのズレを表示・突合層で吸収する。
 *
 * start_at が無い row だけ DB の `date` 列にフォールバック。
 */
export function groupAndMatch(
  rows: WorkoutRow[],
  manualPairs: ReadonlySet<string> = new Set(),
  unpairs: ReadonlySet<string> = new Set(),
): WorkoutDay[] {
  // ----- 全 row に対する union-find (cross-day manual pair を許容するため) -----
  const hcs = rows.filter((r) => r.source === "hc");
  const zones = rows.filter((r) => r.source === "zones");
  const hcIds = new Set(hcs.map((h) => h.id));
  const zonesIds = new Set(zones.map((z) => z.id));
  const parent = new Map<string, string>();
  const nodeId = (src: "hc" | "zones", id: string) => `${src}:${id}`;
  function find(x: string): string {
    if (!parent.has(x)) { parent.set(x, x); return x; }
    let root = x;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur)! !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a: string, b: string): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const r of rows) find(nodeId(r.source, r.id));

  // Manual edges 先 (cross-day も含む全て)
  for (const key of manualPairs) {
    const [hcId, zId] = key.split("::");
    if (!hcId || !zId) continue;
    if (!hcIds.has(hcId) || !zonesIds.has(zId)) continue;
    union(nodeId("hc", hcId), nodeId("zones", zId));
  }
  // Auto edges (同 JST 日付内で時刻 overlap > 0、unpair に無いもの)
  const rowDate = (r: WorkoutRow) => jstDateOf(r.start_at) ?? r.date;
  const hcsByDate = new Map<string, WorkoutRow[]>();
  const zonesByDate = new Map<string, WorkoutRow[]>();
  for (const h of hcs) {
    const d = rowDate(h);
    const l = hcsByDate.get(d) ?? [];
    l.push(h); hcsByDate.set(d, l);
  }
  for (const z of zones) {
    const d = rowDate(z);
    const l = zonesByDate.get(d) ?? [];
    l.push(z); zonesByDate.set(d, l);
  }
  for (const [d, dayHcs] of hcsByDate) {
    const dayZones = zonesByDate.get(d) ?? [];
    for (const hc of dayHcs) {
      for (const z of dayZones) {
        const key = `${hc.id}::${z.id}`;
        if (manualPairs.has(key)) continue;  // 既に union 済み
        if (unpairs.has(key)) continue;
        if (overlapSec(hc, z) > 0) {
          union(nodeId("hc", hc.id), nodeId("zones", z.id));
        }
      }
    }
  }

  // ----- 連結成分ごとに集約 -----
  interface Group { hcs: WorkoutRow[]; zoneses: WorkoutRow[]; }
  const groups = new Map<string, Group>();
  const getGroup = (root: string): Group => {
    let g = groups.get(root);
    if (!g) { g = { hcs: [], zoneses: [] }; groups.set(root, g); }
    return g;
  };
  for (const h of hcs) getGroup(find(nodeId("hc", h.id))).hcs.push(h);
  for (const z of zones) getGroup(find(nodeId("zones", z.id))).zoneses.push(z);

  // ----- 各成分を 1 個の WorkoutMatchItem に成型し、所属 date を決める -----
  const itemsByDate = new Map<string, WorkoutMatchItem[]>();
  const pushTo = (date: string, item: WorkoutMatchItem) => {
    let list = itemsByDate.get(date);
    if (!list) { list = []; itemsByDate.set(date, list); }
    list.push(item);
  };

  for (const g of groups.values()) {
    if (g.hcs.length > 0 && g.zoneses.length > 0) {
      // matched group の edges を再構築
      const edges: MatchEdge[] = [];
      for (const hc of g.hcs) {
        for (const z of g.zoneses) {
          const key = `${hc.id}::${z.id}`;
          if (manualPairs.has(key)) {
            edges.push({ hc_id: hc.id, zones_id: z.id, overlap_sec: overlapSec(hc, z), manual: true });
          } else if (!unpairs.has(key)) {
            const ov = overlapSec(hc, z);
            if (ov > 0) edges.push({ hc_id: hc.id, zones_id: z.id, overlap_sec: ov, manual: false });
          }
        }
      }
      const item: WorkoutMatchItem = {
        type: "matched",
        hcs: [...g.hcs].sort(byStartAtAsc),
        zoneses: [...g.zoneses].sort(byStartAtAsc),
        edges,
        has_manual: edges.some((e) => e.manual),
      };
      // 所属 date = 最早 start_at の JST 日付 (= group 内で earliest)
      const allStarts = [...g.hcs, ...g.zoneses]
        .map((r) => r.start_at)
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .sort();
      const date = allStarts[0]
        ? jstDateOf(allStarts[0]) ?? rowDate(g.hcs[0] ?? g.zoneses[0])
        : rowDate(g.hcs[0] ?? g.zoneses[0]);
      pushTo(date, item);
    } else if (g.hcs.length > 0) {
      for (const hc of g.hcs) pushTo(rowDate(hc), { type: "hc_only", hc });
    } else {
      for (const z of g.zoneses) pushTo(rowDate(z), { type: "zones_only", zones: z });
    }
  }

  // ----- WorkoutDay 配列に成型 -----
  const days: WorkoutDay[] = [];
  for (const [date, items] of itemsByDate) {
    items.sort((a, b) => {
      const ea = startAtOf(a), eb = startAtOf(b);
      return ea < eb ? -1 : ea > eb ? 1 : 0;
    });
    let hc_count = 0, zones_count = 0, matched_count = 0;
    for (const it of items) {
      if (it.type === "matched") {
        hc_count += it.hcs.length;
        zones_count += it.zoneses.length;
        matched_count += 1;
      } else if (it.type === "hc_only") hc_count += 1;
      else zones_count += 1;
    }
    days.push({ date, hc_count, zones_count, matched_count, items });
  }
  days.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return days;
}

// =============================================================================
// 手動突合 (workout_pairs / workout_unpairs) helpers — Refs #18
// =============================================================================

export interface WorkoutPair {
  hc_id: string;
  zones_id: string;
}

/**
 * workout_pairs と workout_unpairs を一括取得して `<hc_id>::<zones_id>` 形式の
 * Set 2 つで返す。pairHcZones / groupAndMatch に渡しやすい形。
 */
export async function loadPairSets(
  db: D1Database,
): Promise<{ pairs: Set<string>; unpairs: Set<string> }> {
  const [p, u] = await Promise.all([
    db.prepare("SELECT hc_id, zones_id FROM workout_pairs").all<WorkoutPair>(),
    db.prepare("SELECT hc_id, zones_id FROM workout_unpairs").all<WorkoutPair>(),
  ]);
  const pairs = new Set((p.results ?? []).map((r) => `${r.hc_id}::${r.zones_id}`));
  const unpairs = new Set((u.results ?? []).map((r) => `${r.hc_id}::${r.zones_id}`));
  return { pairs, unpairs };
}

/**
 * 手動 pair edge を 1 本足す。同時に対応する unpair (= 同じ HC/Zones を
 * 「別 workout」とした記録) を解除する。idempotent (PK 衝突は ignore)。
 */
export async function addManualPair(
  db: D1Database,
  hcId: string,
  zonesId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      "INSERT OR IGNORE INTO workout_pairs (hc_id, zones_id, created_at) VALUES (?, ?, ?)",
    ).bind(hcId, zonesId, now),
    db.prepare(
      "DELETE FROM workout_unpairs WHERE hc_id = ? AND zones_id = ?",
    ).bind(hcId, zonesId),
  ]);
}

/**
 * 手動 pair edge を 1 本削除 + unpair に追加 (= 「別 workout」と user が宣言)。
 * auto pair も unpair で抑止されるので、時刻 overlap があっても再リンクされない。
 */
export async function removeManualPair(
  db: D1Database,
  hcId: string,
  zonesId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      "DELETE FROM workout_pairs WHERE hc_id = ? AND zones_id = ?",
    ).bind(hcId, zonesId),
    db.prepare(
      "INSERT OR IGNORE INTO workout_unpairs (hc_id, zones_id, created_at) VALUES (?, ?, ?)",
    ).bind(hcId, zonesId, now),
  ]);
}

/**
 * 1 つの matched group 内の全 edge を unpair に登録 (= グループまるごと解除)。
 * UI の「解除」ボタンが叩く。
 */
export async function unpairGroup(
  db: D1Database,
  hcIds: string[],
  zonesIds: string[],
): Promise<void> {
  if (hcIds.length === 0 || zonesIds.length === 0) return;
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const h of hcIds) {
    for (const z of zonesIds) {
      stmts.push(db.prepare(
        "DELETE FROM workout_pairs WHERE hc_id = ? AND zones_id = ?",
      ).bind(h, z));
      stmts.push(db.prepare(
        "INSERT OR IGNORE INTO workout_unpairs (hc_id, zones_id, created_at) VALUES (?, ?, ?)",
      ).bind(h, z, now));
    }
  }
  await db.batch(stmts);
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
