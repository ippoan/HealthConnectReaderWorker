-- workouts: HC (Health Connect) と Zones (iOS) 双方の workout 要約を 1 テーブルで
-- 持つ。突合 (date 単位 / 時刻範囲) を SQL で書けるようにする。生 JSON は引き続き
-- R2 (raw_key) を pointer として保持。
--
-- source:
--   'hc'    = Android Health Connect 由来 (1 日分の集計、key=hc/yyyy/mm-dd.json)
--   'zones' = iOS Zones app 由来 (1 workout、key=zones/yyyy/mm-dd/{uuid}.json)
--
-- id:
--   Zones: workout uuid (大文字 UUID)
--   HC   : "hc-{yyyy-mm-dd}" (1 日 1 ファイル仕様のため日付を natural key にする)
-- ↑ 同じ id で再 upload した場合は overwrite (ON CONFLICT REPLACE)
CREATE TABLE IF NOT EXISTS workouts (
  id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('hc', 'zones')),
  date TEXT NOT NULL,              -- 'YYYY-MM-DD' (UTC)
  start_at TEXT,                   -- ISO 8601 UTC
  end_at TEXT,                     -- ISO 8601 UTC
  activity_name TEXT,              -- "ランニング" 等
  distance_m REAL,                 -- m
  duration_sec INTEGER,            -- 秒
  active_calories REAL,            -- kcal
  steps INTEGER,
  avg_heart_rate INTEGER,          -- bpm
  raw_key TEXT NOT NULL,           -- R2 key (生 JSON への pointer)
  uploaded_at TEXT NOT NULL,       -- ISO 8601 UTC (worker が INSERT した時刻)
  PRIMARY KEY (source, id)
);

CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(date);
CREATE INDEX IF NOT EXISTS idx_workouts_start_at ON workouts(start_at);
CREATE INDEX IF NOT EXISTS idx_workouts_source_date ON workouts(source, date);
