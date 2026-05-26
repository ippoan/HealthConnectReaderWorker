/**
 * D1 schema 定義 (= source of truth)。
 *
 * `wrangler d1 migrations apply` 経由ではなく、Worker 自身が DB binding で
 * `applySchema()` を呼ぶ運用 (token 不要)。`POST /_admin/migrate` から叩く。
 *
 * すべて `IF NOT EXISTS` で書いてあるので、何度叩いても idempotent。
 * スキーマ変更を入れる時は **後ろに ALTER TABLE 文を追記**する (= 既存テーブルは
 * 維持しつつ、新環境では CREATE → ALTER を順に実行)。後方互換が崩れる変更
 * (DROP / カラム RENAME) は別 endpoint で慎重に扱う。
 *
 * Refs ippoan/HealthConnectReaderWorker#11
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS workouts (
    id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('hc', 'zones')),
    date TEXT NOT NULL,
    start_at TEXT,
    end_at TEXT,
    activity_name TEXT,
    distance_m REAL,
    duration_sec INTEGER,
    active_calories REAL,
    steps INTEGER,
    avg_heart_rate INTEGER,
    raw_key TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    PRIMARY KEY (source, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(date)`,
  `CREATE INDEX IF NOT EXISTS idx_workouts_start_at ON workouts(start_at)`,
  `CREATE INDEX IF NOT EXISTS idx_workouts_source_date ON workouts(source, date)`,
  // 手動突合 (manual pair) テーブル。多対多 (1 HC ↔ N Zones, N HC ↔ 1 Zones,
  // N ↔ N) を許容するため UNIQUE は無し。pairHcZones が auto pair の edge と
  // 一緒に union-find して連結成分を「matched group」として返す。Refs #18
  `CREATE TABLE IF NOT EXISTS workout_pairs (
    hc_id TEXT NOT NULL,
    zones_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (hc_id, zones_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workout_pairs_zones ON workout_pairs(zones_id)`,
  // 自動突合 (時刻 overlap) を user が「これは別 workout」と否定した記録。
  // pairHcZones は auto edge を生やす前にここを参照し、該当ペアは除外する。
  // /api/pair/delete で INSERT, /api/pair (再リンク) で DELETE。Refs #18
  `CREATE TABLE IF NOT EXISTS workout_unpairs (
    hc_id TEXT NOT NULL,
    zones_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (hc_id, zones_id)
  )`,
];

/**
 * `SCHEMA_STATEMENTS` を D1 に順次適用する。`db.batch()` は 1 transaction で
 * まとめて走るが、CREATE TABLE / CREATE INDEX 系は逐次 prepare → run でも
 * 速度差が無視できるレベルなので素直に for ループにする (failure 時の
 * どの statement で死んだか判別しやすい)。
 */
export async function applySchema(
  db: D1Database,
): Promise<{ ran: number; statements: number }> {
  let ran = 0;
  for (const sql of SCHEMA_STATEMENTS) {
    await db.prepare(sql).run();
    ran++;
  }
  return { ran, statements: SCHEMA_STATEMENTS.length };
}
