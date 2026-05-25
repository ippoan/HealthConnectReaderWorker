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
