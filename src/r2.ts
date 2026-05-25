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

export interface HistorySummary {
  count: number;
  latest: string | null;
}

export async function summarizeHistory(bucket: R2Bucket): Promise<HistorySummary> {
  let count = 0;
  let latest: string | null = null;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "hc/", cursor, limit: 1000 });
    count += page.objects.length;
    for (const obj of page.objects) {
      const date = dateFromKey(obj.key);
      if (date && (latest === null || date > latest)) latest = date;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { count, latest };
}

function dateFromKey(key: string): string | null {
  const m = /^hc\/(\d{4})\/(\d{2})-(\d{2})\.json$/.exec(key);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
