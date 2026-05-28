export interface UploadKey {
  yyyy: string;
  mmdd: string;
  key: string;
}

export function uploadKeyFor(date: Date): UploadKey {
  const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mmdd = `${mm}-${dd}`;
  return { yyyy, mmdd, key: `hc/${yyyy}/${mmdd}.json` };
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD` 形式の date 文字列を `hc/{yyyy}/{mm-dd}.json` key に変換する。
 * 不正な形式 (年/月/日 の範囲超過含む) は null。
 */
export function uploadKeyForDateString(date: string): UploadKey | null {
  const m = ISO_DATE.exec(date);
  if (!m) return null;
  const yyyy = m[1];
  const mm = m[2];
  const dd = m[3];
  const mmNum = Number(mm);
  const ddNum = Number(dd);
  if (mmNum < 1 || mmNum > 12 || ddNum < 1 || ddNum > 31) return null;
  return { yyyy, mmdd: `${mm}-${dd}`, key: `hc/${yyyy}/${mm}-${dd}.json` };
}

const ZONES_UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/**
 * Zones (iOS Apple Watch workout export) JSON 1 件を `zones/{yyyy}/{mm}-{dd}/{uuid}.json`
 * 配下に置く key を作る。`hc/` と違い 1 日複数 workout を保持するため uuid を file 名に。
 * - `startDate` は ISO 8601 文字列。UTC で yyyy/mm-dd に分割する
 * - `uuid` は Zones の workout uuid (`C79F6C0C-...` 形式)
 * 不正な startDate / uuid は null。
 */
export function zonesKeyFor(startDate: string, uuid: string): UploadKey | null {
  if (!ZONES_UUID.test(uuid)) return null;
  const ts = Date.parse(startDate);
  if (Number.isNaN(ts)) return null;
  const d = new Date(ts);
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return { yyyy, mmdd: `${mm}-${dd}`, key: `zones/${yyyy}/${mm}-${dd}/${uuid}.json` };
}

/**
 * 手動作成 HC データ 1 件を `manual/{yyyy}/{mm}-{dd}/{id}.json` 配下に置く key を作る。
 * `hc/{yyyy}/{mm-dd}.json` (1 日 1 ファイル、Android 自動 upload が上書きする) とは
 * **別 prefix** にすることで、自動 upload に絶対に上書きされない。1 日複数の手動
 * workout を保持するため zones と同じく id を file 名にする。
 *
 * - `startDate` は ISO 8601 文字列。UTC 由来の暦日で yyyy/mm-dd に分割する
 *   (= D1 `date` 列 / `hc` key と同じ UTC 規約に揃える)
 * - `id` は manualSessionId() が返す `manual_xxxxxxxxxxxxxxxx` 形式
 * 不正な startDate / id は null。
 *
 * Refs ippoan/HealthConnectReader#6
 */
export function manualKeyFor(startDate: string, id: string): UploadKey | null {
  if (!/^manual_[0-9a-f]{16}$/.test(id)) return null;
  const ts = Date.parse(startDate);
  if (Number.isNaN(ts)) return null;
  const d = new Date(ts);
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return { yyyy, mmdd: `${mm}-${dd}`, key: `manual/${yyyy}/${mm}-${dd}/${id}.json` };
}

export interface HistoryBreakdown {
  count: number;
  latest: string | null;
}

export interface HistorySummary {
  // 互換性のため top-level の `count` / `latest` は hc + zones 合算で返す。
  // 新規 caller は `hc` / `zones` の breakdown を見ること。
  count: number;
  latest: string | null;
  hc: HistoryBreakdown;
  zones: HistoryBreakdown;
}

/**
 * R2 全体から hc/ と zones/ 両 prefix を listing し、それぞれの件数と最新日付を
 * 集計する。`count` / `latest` (top-level) は両者合算で返すが、UI 側 breakdown
 * 用に `{ hc, zones }` を別途返す。
 *
 * Refs ippoan/HealthConnectReaderWorker#19
 */
export async function summarizeHistory(bucket: R2Bucket): Promise<HistorySummary> {
  const [hc, zones] = await Promise.all([
    listPrefix(bucket, "hc/", hcDateFromKey),
    listPrefix(bucket, "zones/", zonesDateFromKey),
  ]);
  return {
    count: hc.count + zones.count,
    latest: maxDate(hc.latest, zones.latest),
    hc,
    zones,
  };
}

async function listPrefix(
  bucket: R2Bucket,
  prefix: string,
  toDate: (key: string) => string | null,
): Promise<HistoryBreakdown> {
  let count = 0;
  let latest: string | null = null;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) {
      const date = toDate(obj.key);
      if (date === null) continue; // skip 想定外 layout のキー
      count++;
      if (latest === null || date > latest) latest = date;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { count, latest };
}

function maxDate(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

function hcDateFromKey(key: string): string | null {
  const m = /^hc\/(\d{4})\/(\d{2})-(\d{2})\.json$/.exec(key);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function zonesDateFromKey(key: string): string | null {
  const m = /^zones\/(\d{4})\/(\d{2})-(\d{2})\/[^/]+\.json$/.exec(key);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
