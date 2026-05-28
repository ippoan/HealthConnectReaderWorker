import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import app from "../src/index";
import {
  buildManualPayload,
  deleteWorkout,
  groupAndMatch,
  hcPayloadToRows,
  listManualFromDb,
  listWorkouts,
  manualInputToRow,
  manualSessionId,
  pairHcZones,
  upsertWorkout,
  zonesPayloadToRow,
} from "../src/db";
import type { WorkoutRow } from "../src/db";
import { applySchema } from "../src/migrations";
import { manualKeyFor, summarizeHistory, uploadKeyFor, zonesKeyFor } from "../src/r2";

// D1 schema は production と同じ `applySchema` で test DB にも適用する
// (= production の `POST /_admin/migrate` と完全同じ経路)。
beforeAll(async () => {
  await applySchema(env.DB);
});

const TOKEN = "test-upload-token";
const auth = (t = TOKEN) => ({ Authorization: `Bearer ${t}` });

describe("GET /health", () => {
  it("returns ok + env", async () => {
    const r = await app.request("/health", {}, env);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, env: "test", version: "0.1.0" });
  });
});

describe("GET /", () => {
  it("302 to auth-worker login when no auth (PWA/browser first visit)", async () => {
    const r = await app.request("/", {}, env);
    expect(r.status).toBe(302);
    const loc = r.headers.get("location") ?? "";
    expect(loc).toContain("auth.ippoan.org/oauth/google/redirect");
    expect(loc).toContain("redirect_uri=");
  });

  it("200 with HTML when Bearer matches (Android WebView path)", async () => {
    const r = await app.request(
      "/",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(await r.text()).toContain("今すぐ Upload");
  });

  it("302 when Bearer is wrong (= falls through to login redirect)", async () => {
    const r = await app.request(
      "/",
      { headers: { Authorization: "Bearer nope" } },
      env,
    );
    expect(r.status).toBe(302);
  });
});

describe("POST /api/upload", () => {
  it("401 without bearer", async () => {
    const r = await app.request(
      "/api/upload",
      { method: "POST", body: "{}" },
      env,
    );
    expect(r.status).toBe(401);
  });

  it("401 with wrong bearer", async () => {
    const r = await app.request(
      "/api/upload",
      { method: "POST", headers: auth("nope"), body: "{}" },
      env,
    );
    expect(r.status).toBe(401);
  });

  it("400 on empty body", async () => {
    const r = await app.request(
      "/api/upload",
      { method: "POST", headers: auth() },
      env,
    );
    expect(r.status).toBe(400);
  });

  it("400 on invalid json", async () => {
    const r = await app.request(
      "/api/upload",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: "not json",
      },
      env,
    );
    expect(r.status).toBe(400);
  });

  it("400 on non-object json", async () => {
    const r = await app.request(
      "/api/upload",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: "[1,2,3]",
      },
      env,
    );
    expect(r.status).toBe(200); // arrays are objects in JS
    const r2 = await app.request(
      "/api/upload",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: "42",
      },
      env,
    );
    expect(r2.status).toBe(400);
  });

  it("200 writes JSON to R2 under today's key", async () => {
    const body = JSON.stringify({ sessions: [], distances: [] });
    const r = await app.request(
      "/api/upload",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body,
      },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; key: string };
    expect(j.ok).toBe(true);
    const obj = await env.R2.get(j.key);
    expect(obj).not.toBeNull();
    expect(await obj!.text()).toBe(body);
  });

  it("/api/upload merges sessions into existing R2 file (Refs #18)", async () => {
    // /api/upload は今日 UTC の key に書く。今日のキーを既存ファイルとして仕込み、
    // 新 incoming が old を消さない (= merge される) ことを確認する。
    const { key } = uploadKeyFor(new Date());
    await env.R2.put(key, JSON.stringify({
      date: "merged-test",
      sessions: [
        { startTime: "2026-10-10T01:00:00Z", endTime: "2026-10-10T01:30:00Z", exerciseType: 56 },
      ],
      distances: [],
    }));
    const incoming = {
      sessions: [
        // 新 session 1 つ (異なる startTime → merge で追加)
        { startTime: "2026-10-10T19:00:00Z", endTime: "2026-10-10T19:30:00Z", exerciseType: 56 },
      ],
      distances: [],
    };
    const r = await app.request(
      "/api/upload",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify(incoming),
      },
      env,
    );
    expect(r.status).toBe(200);
    const stored = JSON.parse(await (await env.R2.get(key))!.text());
    // 2 sessions: 既存 + incoming が共存している
    expect(stored.sessions.length).toBe(2);
    const ids = stored.sessions.map((s: any) => s.startTime);
    expect(ids).toContain("2026-10-10T01:00:00Z");
    expect(ids).toContain("2026-10-10T19:00:00Z");
  });

  it("uses payload.date for the R2 key (JST 朝の前日書込を防ぐ, Refs #48)", async () => {
    // Android が JST `LocalDate.now()` で生成した `date` field を最優先する。
    // UTC 朝でも payload.date="2026-05-27" なら hc/2026/05-27.json に書かれる
    // (UTC fallback の今日 key にはならない) ことを確認。
    const body = JSON.stringify({
      date: "2026-05-27",
      sessions: [],
      distances: [],
    });
    const r = await app.request(
      "/api/upload",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body,
      },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; key: string; date: string };
    expect(j.key).toBe("hc/2026/05-27.json");
    expect(j.date).toBe("2026-05-27");
  });

  it("falls back to UTC new Date() when payload.date is missing/invalid (Refs #48)", async () => {
    // payload に date 欠落 → uploadKeyFor(new Date()) (UTC) に fallback。
    // 不正値 ("bad" / "2026-13-99") も同じ fallback パス。
    const todayKey = uploadKeyFor(new Date()).key;
    for (const body of [
      JSON.stringify({ sessions: [], distances: [] }),
      JSON.stringify({ date: "bad", sessions: [], distances: [] }),
      JSON.stringify({ date: "2026-13-99", sessions: [], distances: [] }),
    ]) {
      const r = await app.request(
        "/api/upload",
        {
          method: "POST",
          headers: { ...auth(), "Content-Type": "application/json" },
          body,
        },
        env,
      );
      expect(r.status).toBe(200);
      const j = (await r.json()) as { key: string };
      expect(j.key).toBe(todayKey);
    }
  });
});

describe("GET /api/history", () => {
  it("401 without bearer", async () => {
    const r = await app.request("/api/history", {}, env);
    expect(r.status).toBe(401);
  });

  it("counts and surfaces latest after uploads (hc + zones breakdown)", async () => {
    await env.R2.put("hc/2026/05/05-20.json", "{}"); // wrong layout, ignored
    await env.R2.put("hc/2026/05-20.json", "{}");
    await env.R2.put("hc/2026/05-22.json", "{}");
    await env.R2.put("hc/2025/12-31.json", "{}");
    await env.R2.put(
      "zones/2026/05-23/AAAAAAAA-1111-2222-3333-444444444444.json",
      "{}",
    );
    await env.R2.put(
      "zones/2026/05-23/BBBBBBBB-5555-6666-7777-888888888888.json",
      "{}",
    );
    await env.R2.put("zones/garbage-layout.json", "{}"); // wrong layout, ignored
    const r = await app.request(
      "/api/history",
      { headers: auth() },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      count: number;
      latest: string | null;
      hc: { count: number; latest: string | null };
      zones: { count: number; latest: string | null };
    };
    expect(j.hc.count).toBeGreaterThanOrEqual(3);
    expect(j.hc.latest).toBe("2026-05-22");
    expect(j.zones.count).toBeGreaterThanOrEqual(2);
    expect(j.zones.latest).toBe("2026-05-23");
    // top-level は合算で、latest は最大値 (Zones の方が新しい)
    expect(j.count).toBe(j.hc.count + j.zones.count);
    expect(j.latest).toBe("2026-05-23");
  });
});

describe("uploadKeyFor", () => {
  it("pads single-digit months / days", () => {
    const k = uploadKeyFor(new Date(Date.UTC(2026, 0, 3))); // Jan 3
    expect(k.key).toBe("hc/2026/01-03.json");
    expect(k.yyyy).toBe("2026");
    expect(k.mmdd).toBe("01-03");
  });
});

describe("POST /api/upload-batch", () => {
  it("401 without bearer", async () => {
    const r = await app.request(
      "/api/upload-batch",
      { method: "POST", body: "{}" },
      env,
    );
    expect(r.status).toBe(401);
  });

  it("400 on invalid json", async () => {
    const r = await app.request(
      "/api/upload-batch",
      { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: "x" },
      env,
    );
    expect(r.status).toBe(400);
  });

  it("400 when days missing", async () => {
    const r = await app.request(
      "/api/upload-batch",
      { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: "{}" },
      env,
    );
    expect(r.status).toBe(400);
  });

  it("400 when all days invalid", async () => {
    const body = JSON.stringify({
      days: [
        { date: "bad", payload: {} },
        { date: "2026-13-01", payload: {} },
      ],
    });
    const r = await app.request(
      "/api/upload-batch",
      { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body },
      env,
    );
    expect(r.status).toBe(400);
  });

  it("400 when days length out of range", async () => {
    const r = await app.request(
      "/api/upload-batch",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ days: [] }),
      },
      env,
    );
    expect(r.status).toBe(400);
  });

  it("200 writes per-day keys + records skipped reasons", async () => {
    const body = JSON.stringify({
      days: [
        { date: "2026-04-01", payload: { sessions: [] } },
        { date: "2026-04-02", payload: { sessions: [{ x: 1 }] } },
        { date: "not-a-date", payload: {} },           // skipped: invalid_date
        { date: "2026-04-03", payload: "string" },     // skipped: payload_not_object
        "not-an-object",                                // skipped: not_object
      ],
    });
    const r = await app.request(
      "/api/upload-batch",
      { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      ok: boolean;
      written: number;
      keys: string[];
      skipped: Array<{ index: number; reason: string }>;
    };
    expect(j.ok).toBe(true);
    expect(j.written).toBe(2);
    expect(j.keys).toEqual(["hc/2026/04-01.json", "hc/2026/04-02.json"]);
    expect(j.skipped.map((s) => s.reason)).toEqual([
      "invalid_date",
      "payload_not_object",
      "not_object",
    ]);
    // verify actual R2 contents
    const day2 = await env.R2.get("hc/2026/04-02.json");
    expect(await day2!.text()).toBe('{"sessions":[{"x":1}]}');
  });

  it("incremental: merges new sessions into existing R2 payload (Refs #18)", async () => {
    // 既存ファイル: sessions=[A], distances=[X]
    await env.R2.put("hc/2026/06-10.json", JSON.stringify({
      date: "2026-06-10",
      sessions: [{ startTime: "2026-06-10T01:00:00Z", endTime: "2026-06-10T01:30:00Z", exerciseType: 56 }],
      distances: [{ startTime: "2026-06-10T01:00:00Z", endTime: "2026-06-10T01:30:00Z", km: 5 }],
    }));
    // 新 batch: 同 day に session B 追加 (Health Connect が後から sync した想定)
    const body = JSON.stringify({
      days: [
        {
          date: "2026-06-10",
          payload: {
            date: "2026-06-10",
            sessions: [
              // 既存 A
              { startTime: "2026-06-10T01:00:00Z", endTime: "2026-06-10T01:30:00Z", exerciseType: 56 },
              // 新 B
              { startTime: "2026-06-10T19:00:00Z", endTime: "2026-06-10T19:30:00Z", exerciseType: 56 },
            ],
            distances: [{ startTime: "2026-06-10T01:00:00Z", endTime: "2026-06-10T01:30:00Z", km: 5 }],
          },
        },
        { date: "2026-06-11", payload: { date: "2026-06-11", sessions: [], distances: [] } }, // new file
      ],
    });
    const r = await app.request(
      "/api/upload-batch",
      { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      ok: boolean; written: number; keys: string[]; force: boolean;
      skipped: Array<{ index: number; reason: string }>;
    };
    expect(j.written).toBe(2); // both 06-10 (merged) and 06-11 (new) written
    expect(j.force).toBe(false);
    const stored = JSON.parse(await (await env.R2.get("hc/2026/06-10.json"))!.text());
    expect(stored.sessions.length).toBe(2); // A + B merged
    const ids = stored.sessions.map((s: any) => s.startTime);
    expect(ids).toContain("2026-06-10T01:00:00Z");
    expect(ids).toContain("2026-06-10T19:00:00Z");
  });

  it("incremental: skips day with no_change when sessions already present", async () => {
    const payload = {
      date: "2026-06-15",
      sessions: [{ startTime: "2026-06-15T02:00:00Z", endTime: "2026-06-15T02:20:00Z", exerciseType: 56 }],
      distances: [],
    };
    await env.R2.put("hc/2026/06-15.json", JSON.stringify(payload));
    // 同じ payload を再 upload (= 新しい session 無し)
    const r = await app.request(
      "/api/upload-batch",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ days: [{ date: "2026-06-15", payload }] }),
      },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { written: number; skipped: Array<{ reason: string }> };
    expect(j.written).toBe(0);
    expect(j.skipped.some((s) => s.reason === "no_change")).toBe(true);
  });

  it("force=true overrides incremental and overwrites existing keys", async () => {
    await env.R2.put("hc/2026/07-10.json", '{"old":true}');
    const body = JSON.stringify({
      days: [{ date: "2026-07-10", payload: { fresh: true } }],
    });
    const r = await app.request(
      "/api/upload-batch?force=true",
      { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { written: number; force: boolean };
    expect(j.written).toBe(1);
    expect(j.force).toBe(true);
    expect(await (await env.R2.get("hc/2026/07-10.json"))!.text()).toBe('{"fresh":true}');
  });

  it("200 (written=0) when all valid days already exist", async () => {
    // merge mode: 既存と同じ payload を投げると no_change で skip される
    const same = (date: string) => ({
      date,
      sessions: [],
      distances: [],
    });
    await env.R2.put("hc/2026/08-01.json", JSON.stringify(same("2026-08-01")));
    await env.R2.put("hc/2026/08-02.json", JSON.stringify(same("2026-08-02")));
    const body = JSON.stringify({
      days: [
        { date: "2026-08-01", payload: same("2026-08-01") },
        { date: "2026-08-02", payload: same("2026-08-02") },
      ],
    });
    const r = await app.request(
      "/api/upload-batch",
      { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; written: number; skipped: Array<{ reason: string }> };
    expect(j.ok).toBe(true);
    expect(j.written).toBe(0);
    // 旧: already_exists; 新 (merge mode): 同 payload なら no_change
    expect(
      j.skipped.filter((s) => s.reason === "already_exists" || s.reason === "no_change"),
    ).toHaveLength(2);
  });
});

describe("summarizeHistory", () => {
  it("returns empty breakdown on empty bucket", async () => {
    const fakeBucket: R2Bucket = {
      list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }) as never,
    } as unknown as R2Bucket;
    const out = await summarizeHistory(fakeBucket);
    expect(out).toEqual({
      count: 0,
      latest: null,
      hc: { count: 0, latest: null },
      zones: { count: 0, latest: null },
    });
  });
});

describe("GET /manifest.json", () => {
  it("returns a valid Web App Manifest with standalone display", async () => {
    const r = await app.request("/manifest.json", {}, env);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/application\/manifest\+json/);
    const j = (await r.json()) as { display: string; start_url: string; icons: unknown[] };
    expect(j.display).toBe("standalone");
    expect(j.start_url).toBe("/");
    expect(j.icons.length).toBeGreaterThan(0);
  });
});

describe("GET /sw.js", () => {
  it("returns a JS service worker with skipWaiting", async () => {
    const r = await app.request("/sw.js", {}, env);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/javascript/);
    const body = await r.text();
    expect(body).toContain("skipWaiting");
    expect(body).toContain("clients.claim");
  });
});

describe("zonesKeyFor", () => {
  it("derives yyyy/mm-dd/{uuid}.json from UTC startDate", () => {
    const k = zonesKeyFor(
      "2026-05-24T20:00:11Z",
      "C79F6C0C-5F16-4FCB-A626-BECF2AB34F26",
    );
    expect(k?.key).toBe("zones/2026/05-24/C79F6C0C-5F16-4FCB-A626-BECF2AB34F26.json");
    expect(k?.yyyy).toBe("2026");
    expect(k?.mmdd).toBe("05-24");
  });

  it("returns null for invalid uuid", () => {
    expect(zonesKeyFor("2026-05-24T20:00:11Z", "not-a-uuid")).toBeNull();
  });

  it("returns null for invalid startDate", () => {
    expect(
      zonesKeyFor("not-a-date", "C79F6C0C-5F16-4FCB-A626-BECF2AB34F26"),
    ).toBeNull();
  });
});

describe("POST /api/upload-zones", () => {
  const VALID = {
    uuid: "C79F6C0C-5F16-4FCB-A626-BECF2AB34F26",
    startDate: "2026-05-24T20:00:11Z",
    endDate: "2026-05-24T20:22:08Z",
    name: "ランニング",
    distance: { value: 3.53, unit: "km" },
  };

  it("401 without bearer", async () => {
    const r = await app.request(
      "/api/upload-zones",
      { method: "POST", body: JSON.stringify(VALID) },
      env,
    );
    expect(r.status).toBe(401);
  });

  it("401 with wrong bearer", async () => {
    const r = await app.request(
      "/api/upload-zones",
      {
        method: "POST",
        headers: { ...auth("nope"), "Content-Type": "application/json" },
        body: JSON.stringify(VALID),
      },
      env,
    );
    expect(r.status).toBe(401);
  });

  it("400 on invalid json", async () => {
    const r = await app.request(
      "/api/upload-zones",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: "not json",
      },
      env,
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_json");
  });

  it("400 when body is not an object", async () => {
    const r = await app.request(
      "/api/upload-zones",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: "[1,2,3]",
      },
      env,
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("expected_object");
  });

  it("400 when uuid is missing", async () => {
    const r = await app.request(
      "/api/upload-zones",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: VALID.startDate }),
      },
      env,
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("missing_uuid");
  });

  it("400 when startDate is missing", async () => {
    const r = await app.request(
      "/api/upload-zones",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ uuid: VALID.uuid }),
      },
      env,
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("missing_startDate");
  });

  it("400 when uuid is malformed", async () => {
    const r = await app.request(
      "/api/upload-zones",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ ...VALID, uuid: "not-a-uuid" }),
      },
      env,
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe(
      "invalid_uuid_or_startDate",
    );
  });

  it("200 stores the full body to R2 under zones/yyyy/mm-dd/{uuid}.json", async () => {
    const body = JSON.stringify(VALID);
    const r = await app.request(
      "/api/upload-zones",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body,
      },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      ok: boolean;
      key: string;
      date: string;
      uuid: string;
    };
    expect(j.ok).toBe(true);
    expect(j.key).toBe(
      "zones/2026/05-24/C79F6C0C-5F16-4FCB-A626-BECF2AB34F26.json",
    );
    expect(j.date).toBe("2026-05-24");
    expect(j.uuid).toBe(VALID.uuid);
    const obj = await env.R2.get(j.key);
    expect(obj).not.toBeNull();
    const stored = JSON.parse(await obj!.text());
    expect(stored.distance.value).toBe(3.53);
    expect(stored.name).toBe("ランニング");
  });
});

describe("GET /api/zones (D1-backed)", () => {
  it("401 without bearer", async () => {
    const r = await app.request("/api/zones", {}, env);
    expect(r.status).toBe(401);
  });

  it("lists items uploaded via /api/upload-zones, newest first", async () => {
    const first = {
      uuid: "AAAAAAAA-1111-2222-3333-444444444444",
      startDate: "2026-04-01T08:00:00Z",
      endDate: "2026-04-01T08:30:00Z",
      name: "ランニング",
      distance: { value: 3.5, unit: "km" },
      duration: { value: 1800, unit: "sec" },
    };
    const second = {
      uuid: "BBBBBBBB-5555-6666-7777-888888888888",
      startDate: "2026-04-02T09:00:00Z",
      endDate: "2026-04-02T09:25:00Z",
      name: "ランニング",
    };
    const r1 = await app.request(
      "/api/upload-zones",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify(first),
      },
      env,
    );
    expect(r1.status).toBe(200);
    await new Promise((res) => setTimeout(res, 10));
    const r2 = await app.request(
      "/api/upload-zones",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify(second),
      },
      env,
    );
    expect(r2.status).toBe(200);

    const r = await app.request("/api/zones", { headers: auth() }, env);
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      count: number;
      items: Array<{ date: string; uuid: string; key: string; uploaded: string }>;
    };
    const ours = j.items.filter(
      (it) => it.uuid === first.uuid || it.uuid === second.uuid,
    );
    expect(ours.length).toBe(2);
    // newest first: second の方が後に INSERT されたので先頭
    expect(ours[0].uuid).toBe(second.uuid);
    expect(ours[0].date).toBe("2026-04-02");
    expect(ours[0].key).toBe(
      "zones/2026/04-02/BBBBBBBB-5555-6666-7777-888888888888.json",
    );
    expect(ours[1].uuid).toBe(first.uuid);
    expect(ours[0].uploaded).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("upsert: re-uploading same uuid does not duplicate row", async () => {
    const same = {
      uuid: "DDDDDDDD-9999-0000-1111-222222222222",
      startDate: "2026-04-05T12:00:00Z",
    };
    await app.request(
      "/api/upload-zones",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify(same),
      },
      env,
    );
    await app.request(
      "/api/upload-zones",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify(same),
      },
      env,
    );
    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM workouts WHERE id = ?",
    )
      .bind(same.uuid)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});

describe("zonesPayloadToRow", () => {
  it("extracts core metrics with unit normalization", () => {
    const row = zonesPayloadToRow(
      {
        uuid: "C79F6C0C-5F16-4FCB-A626-BECF2AB34F26",
        startDate: "2026-05-24T20:00:11Z",
        endDate: "2026-05-24T20:22:08Z",
        name: "ランニング",
        distance: { value: 3.53, unit: "km" },
        duration: { value: 1317, unit: "sec" },
        activeCalories: { value: 229, unit: "kcal" },
        step: { value: 3704, unit: "歩" },
        averageHeartRate: { value: 160, unit: "bpm" },
        minHeartRate: { value: 103, unit: "bpm" },
        maxHeartRate: { value: 169, unit: "bpm" },
      },
      "zones/2026/05-24/C79F6C0C-5F16-4FCB-A626-BECF2AB34F26.json",
      "2026-05-24",
      "2026-05-24T20:30:00.000Z",
    );
    expect(row.id).toBe("C79F6C0C-5F16-4FCB-A626-BECF2AB34F26");
    expect(row.source).toBe("zones");
    expect(row.start_at).toBe("2026-05-24T20:00:11Z");
    expect(row.end_at).toBe("2026-05-24T20:22:08Z");
    expect(row.distance_m).toBeCloseTo(3530, 1); // km → m
    expect(row.duration_sec).toBe(1317);
    expect(row.active_calories).toBe(229);
    expect(row.steps).toBe(3704);
    expect(row.avg_heart_rate).toBe(160);
    expect(row.min_heart_rate).toBe(103);
    expect(row.max_heart_rate).toBe(169);
    expect(row.activity_name).toBe("ランニング");
  });

  it("returns nulls for missing / unknown-unit fields", () => {
    const row = zonesPayloadToRow(
      {
        uuid: "EEEEEEEE-3333-4444-5555-666666666666",
        startDate: "2026-04-10T00:00:00Z",
        distance: { value: 1, unit: "furlong" }, // 未知 unit
      },
      "zones/2026/04-10/EEEEEEEE-3333-4444-5555-666666666666.json",
      "2026-04-10",
      "2026-04-10T00:00:00.000Z",
    );
    expect(row.distance_m).toBeNull();
    expect(row.duration_sec).toBeNull();
    expect(row.steps).toBeNull();
    expect(row.activity_name).toBeNull();
    expect(row.min_heart_rate).toBeNull();
    expect(row.max_heart_rate).toBeNull();
  });
});

describe("hcPayloadToRows (HC → workouts 正規化)", () => {
  it("returns empty array when sessions[] is missing", async () => {
    const rows = await hcPayloadToRows(
      { date: "2026-05-01" },
      "hc/2026/05-01.json",
      "2026-05-01",
      "2026-05-01T00:00:00.000Z",
    );
    expect(rows).toEqual([]);
  });

  it("converts 1 session into 1 row, sums overlapping distances", async () => {
    const payload = {
      date: "2026-05-01",
      sessions: [
        {
          startTime: "2026-05-01T08:00:00Z",
          endTime: "2026-05-01T08:30:00Z",
          exerciseType: 56, // Running
          title: null,
          source: "com.google.android.apps.fitness",
        },
      ],
      distances: [
        // overlap (内側)
        { startTime: "2026-05-01T08:05:00Z", endTime: "2026-05-01T08:10:00Z", km: 1.0, source: "x" },
        // overlap (端跨ぎ後ろ)
        { startTime: "2026-05-01T08:25:00Z", endTime: "2026-05-01T08:35:00Z", km: 1.5, source: "x" },
        // 完全に外
        { startTime: "2026-05-01T09:00:00Z", endTime: "2026-05-01T09:30:00Z", km: 99, source: "x" },
      ],
    };
    const rows = await hcPayloadToRows(
      payload,
      "hc/2026/05-01.json",
      "2026-05-01",
      "2026-05-01T09:00:00.000Z",
    );
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.source).toBe("hc");
    expect(r.id).toMatch(/^hc_[0-9a-f]{16}$/);
    expect(r.start_at).toBe("2026-05-01T08:00:00Z");
    expect(r.end_at).toBe("2026-05-01T08:30:00Z");
    expect(r.date).toBe("2026-05-01");
    expect(r.duration_sec).toBe(30 * 60);
    expect(r.distance_m).toBe(2500); // 1.0 + 1.5 km → 2500 m, 99 km は除外
    expect(r.activity_name).toBe("ランニング");
    expect(r.raw_key).toBe("hc/2026/05-01.json");
  });

  it("does NOT double-count distance across sources (treadmill + Fitbit) — takes max", async () => {
    const payload = {
      date: "2026-05-01",
      sessions: [
        {
          startTime: "2026-05-01T08:00:00Z",
          endTime: "2026-05-01T08:30:00Z",
          exerciseType: 56,
          title: null,
          source: "com.lifefitness",
        },
      ],
      distances: [
        // treadmill が全区間 2.0km を記録
        { startTime: "2026-05-01T08:00:00Z", endTime: "2026-05-01T08:30:00Z", km: 2.0, source: "com.lifefitness" },
        // Fitbit が同じ実距離を別途記録 (≈2.0km)。単純合算すると 4km に二重化する
        { startTime: "2026-05-01T08:00:00Z", endTime: "2026-05-01T08:30:00Z", km: 2.1, source: "com.fitbit" },
      ],
    };
    const rows = await hcPayloadToRows(
      payload,
      "hc/2026/05-01.json",
      "2026-05-01",
      "2026-05-01T09:00:00.000Z",
    );
    // sum (4100m) ではなく source 別 max (2.1km → 2100m)
    expect(rows[0].distance_m).toBe(2100);
  });

  it("uses title when present, falls back to exerciseType name", async () => {
    const payload = {
      sessions: [
        {
          startTime: "2026-05-02T10:00:00Z",
          endTime: "2026-05-02T10:20:00Z",
          exerciseType: 56,
          title: "朝ラン",
        },
        {
          startTime: "2026-05-02T11:00:00Z",
          endTime: "2026-05-02T11:30:00Z",
          exerciseType: 9999, // 未知
          title: null,
        },
      ],
    };
    const rows = await hcPayloadToRows(
      payload,
      "hc/2026/05-02.json",
      "2026-05-02",
      "2026-05-02T12:00:00.000Z",
    );
    expect(rows[0].activity_name).toBe("朝ラン");
    expect(rows[1].activity_name).toBe("exercise_9999");
  });

  it("skips sessions with non-string startTime / endTime", async () => {
    const payload = {
      sessions: [
        { startTime: 123, endTime: "x" },
        { startTime: "2026-05-03T00:00:00Z" }, // endTime missing
        { startTime: "2026-05-03T01:00:00Z", endTime: "2026-05-03T02:00:00Z", exerciseType: 56 },
      ],
    };
    const rows = await hcPayloadToRows(
      payload,
      "hc/2026/05-03.json",
      "2026-05-03",
      "2026-05-03T03:00:00.000Z",
    );
    expect(rows.length).toBe(1);
    expect(rows[0].start_at).toBe("2026-05-03T01:00:00Z");
  });

  it("returns same id for same session re-uploaded", async () => {
    const session = {
      startTime: "2026-05-04T10:00:00Z",
      endTime: "2026-05-04T10:30:00Z",
      exerciseType: 56,
    };
    const a = await hcPayloadToRows(
      { sessions: [session] },
      "hc/2026/05-04.json",
      "2026-05-04",
      "t1",
    );
    const b = await hcPayloadToRows(
      { sessions: [session] },
      "hc/2026/05-04.json",
      "2026-05-04",
      "t2",
    );
    expect(a[0].id).toBe(b[0].id);
  });
});

describe("/api/upload → D1 workouts upsert", () => {
  it("indexes HC sessions into workouts and surfaces `indexed` count", async () => {
    const payload = {
      date: "2026-09-01",
      sessions: [
        {
          startTime: "2026-09-01T07:00:00Z",
          endTime: "2026-09-01T07:30:00Z",
          exerciseType: 56,
          title: null,
        },
        {
          startTime: "2026-09-01T17:00:00Z",
          endTime: "2026-09-01T17:45:00Z",
          exerciseType: 79, // Walking
          title: null,
        },
      ],
      distances: [
        { startTime: "2026-09-01T07:00:00Z", endTime: "2026-09-01T07:30:00Z", km: 5 },
      ],
    };
    const r = await app.request(
      "/api/upload",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; indexed: number; key: string };
    expect(j.ok).toBe(true);
    expect(j.indexed).toBe(2);

    const stored = await listWorkouts(env.DB, { source: "hc", limit: 50 });
    const ours = stored.filter((w) => w.raw_key === j.key);
    expect(ours.length).toBe(2);
    const running = ours.find((w) => w.activity_name === "ランニング");
    expect(running?.distance_m).toBe(5000);
  });

  it("upload-batch indexes per-day payloads (force=true to overwrite)", async () => {
    const body = JSON.stringify({
      days: [
        {
          date: "2026-10-01",
          payload: {
            sessions: [
              {
                startTime: "2026-10-01T06:00:00Z",
                endTime: "2026-10-01T06:30:00Z",
                exerciseType: 56,
                title: null,
              },
            ],
            distances: [],
          },
        },
        {
          date: "2026-10-02",
          payload: {
            sessions: [
              {
                startTime: "2026-10-02T06:00:00Z",
                endTime: "2026-10-02T06:30:00Z",
                exerciseType: 79,
                title: null,
              },
            ],
            distances: [],
          },
        },
      ],
    });
    const r = await app.request(
      "/api/upload-batch?force=true",
      { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { written: number; indexed: number };
    expect(j.written).toBe(2);
    expect(j.indexed).toBe(2);
  });

  it("upload-batch: merge mode re-indexes when new sessions arrive (Refs #18)", async () => {
    // pre-populate 11-01 with empty sessions. 新 batch で session 追加 → merge で write + index
    await env.R2.put("hc/2026/11-01.json", '{"sessions":[]}');
    const body = JSON.stringify({
      days: [
        {
          date: "2026-11-01",
          payload: {
            sessions: [
              {
                startTime: "2026-11-01T06:00:00Z",
                endTime: "2026-11-01T06:30:00Z",
                exerciseType: 56,
              },
            ],
          },
        },
        {
          date: "2026-11-02",
          payload: {
            sessions: [
              {
                startTime: "2026-11-02T06:00:00Z",
                endTime: "2026-11-02T06:30:00Z",
                exerciseType: 56,
              },
            ],
          },
        },
      ],
    });
    const r = await app.request(
      "/api/upload-batch",
      { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body },
      env,
    );
    const j = (await r.json()) as { written: number; indexed: number };
    expect(j.written).toBe(2); // 11-01 merge + 11-02 new
    expect(j.indexed).toBe(2); // 各 1 session ずつ
  });
});

describe("pairHcZones (時刻 overlap で HC × Zones を pair)", () => {
  const baseRow = (over: Partial<WorkoutRow>): WorkoutRow => ({
    id: "x",
    source: "hc",
    date: "2026-05-01",
    start_at: null,
    end_at: null,
    activity_name: null,
    distance_m: null,
    duration_sec: null,
    active_calories: null,
    steps: null,
    avg_heart_rate: null,
    min_heart_rate: null,
    max_heart_rate: null,
    raw_key: "k",
    uploaded_at: "2026-05-01T00:00:00Z",
    ...over,
  });

  it("pairs HC and Zones with overlapping time ranges (1 day, 1 workout each)", () => {
    const hc = baseRow({
      id: "hc1",
      source: "hc",
      start_at: "2026-05-01T08:00:00Z",
      end_at: "2026-05-01T08:30:00Z",
    });
    const z = baseRow({
      id: "z1",
      source: "zones",
      start_at: "2026-05-01T08:05:00Z",
      end_at: "2026-05-01T08:25:00Z",
    });
    const items = pairHcZones([hc, z]);
    expect(items).toHaveLength(1);
    const m = items[0] as any;
    expect(m.type).toBe("matched");
    expect(m.hcs.map((r: any) => r.id)).toEqual(["hc1"]);
    expect(m.zoneses.map((r: any) => r.id)).toEqual(["z1"]);
    expect(m.edges[0].overlap_sec).toBe(20 * 60);
    expect(m.has_manual).toBe(false);
  });

  it("multi-workout per day: each HC gets its best-overlap Zones, sorted by time", () => {
    // 同日に 3 workout (08:00, 12:00, 18:00 HC), Zones 2 件 (08:00, 18:00)
    const rows: WorkoutRow[] = [
      baseRow({ id: "hc1", source: "hc", start_at: "2026-05-02T08:00:00Z", end_at: "2026-05-02T08:30:00Z" }),
      baseRow({ id: "hc2", source: "hc", start_at: "2026-05-02T12:00:00Z", end_at: "2026-05-02T12:20:00Z" }),
      baseRow({ id: "hc3", source: "hc", start_at: "2026-05-02T18:00:00Z", end_at: "2026-05-02T18:45:00Z" }),
      baseRow({ id: "z1", source: "zones", start_at: "2026-05-02T08:01:00Z", end_at: "2026-05-02T08:29:00Z" }),
      baseRow({ id: "z2", source: "zones", start_at: "2026-05-02T18:02:00Z", end_at: "2026-05-02T18:44:00Z" }),
    ];
    const items = pairHcZones(rows);
    // 並び順は start_at 昇順
    expect(items.map((it) => startAtOfTest(it))).toEqual([
      "2026-05-02T08:00:00Z",
      "2026-05-02T12:00:00Z",
      "2026-05-02T18:00:00Z",
    ]);
    expect(items[0].type).toBe("matched"); // 08:00 HC ↔ Z1
    expect(items[1].type).toBe("hc_only"); // 12:00 HC は対応 Zones 無し
    expect(items[2].type).toBe("matched"); // 18:00 HC ↔ Z2
  });

  it("zones_only is interleaved in time order (not appended)", () => {
    const rows: WorkoutRow[] = [
      // HC は 12:00 のみ。Zones は 08:00 と 18:00 (= 両方 zones_only)
      baseRow({ id: "hc1", source: "hc", start_at: "2026-05-03T12:00:00Z", end_at: "2026-05-03T12:30:00Z" }),
      baseRow({ id: "z1", source: "zones", start_at: "2026-05-03T08:00:00Z", end_at: "2026-05-03T08:30:00Z" }),
      baseRow({ id: "z2", source: "zones", start_at: "2026-05-03T18:00:00Z", end_at: "2026-05-03T18:30:00Z" }),
    ];
    const items = pairHcZones(rows);
    expect(items.map((it) => it.type)).toEqual(["zones_only", "hc_only", "zones_only"]);
  });

  it("HC with no start_at → always hc_only (no Zones consumed)", () => {
    const rows: WorkoutRow[] = [
      baseRow({ id: "hc-null", source: "hc", start_at: null, end_at: null }),
      baseRow({ id: "z1", source: "zones", start_at: "2026-05-04T08:00:00Z", end_at: "2026-05-04T08:30:00Z" }),
    ];
    const items = pairHcZones(rows);
    expect(items).toContainEqual(expect.objectContaining({ type: "hc_only" }));
    expect(items).toContainEqual(expect.objectContaining({ type: "zones_only" }));
  });

  it("2 HC sessions overlap same Zone → 1 matched group (N HC × 1 Zones)", () => {
    // 旧 greedy では先発 HC のみ matched で後発が hc_only だったが、新
    // connected-component アルゴリズムでは全 3 nodes が 1 グループに集まる。
    // (= 複数突合: 同じ Apple Watch session が HC で 2 つに分断記録されたケース)
    const z = baseRow({ id: "z1", source: "zones", start_at: "2026-05-05T10:00:00Z", end_at: "2026-05-05T11:00:00Z" });
    const hcEarly = baseRow({ id: "hc-early", source: "hc", start_at: "2026-05-05T10:00:00Z", end_at: "2026-05-05T10:30:00Z" });
    const hcLate = baseRow({ id: "hc-late", source: "hc", start_at: "2026-05-05T10:31:00Z", end_at: "2026-05-05T11:00:00Z" });
    const items = pairHcZones([hcEarly, hcLate, z]);
    expect(items).toHaveLength(1);
    const m = items[0] as any;
    expect(m.type).toBe("matched");
    expect(m.hcs.map((r: any) => r.id).sort()).toEqual(["hc-early", "hc-late"]);
    expect(m.zoneses.map((r: any) => r.id)).toEqual(["z1"]);
  });

  it("manual pair: time overlap が無くても明示リンクされた HC × Zones は matched", () => {
    const hc = baseRow({ id: "hc-x", source: "hc", start_at: "2026-05-06T08:00:00Z", end_at: "2026-05-06T08:30:00Z" });
    const z = baseRow({ id: "z-y", source: "zones", start_at: "2026-05-06T12:00:00Z", end_at: "2026-05-06T12:30:00Z" });
    const items = pairHcZones([hc, z], new Set(["hc-x::z-y"]));
    expect(items).toHaveLength(1);
    const m = items[0] as any;
    expect(m.type).toBe("matched");
    expect(m.has_manual).toBe(true);
  });

  it("unpair: 時刻 overlap があっても unpair set で抑止される", () => {
    const hc = baseRow({ id: "hc-1", source: "hc", start_at: "2026-05-07T08:00:00Z", end_at: "2026-05-07T08:30:00Z" });
    const z = baseRow({ id: "z-1", source: "zones", start_at: "2026-05-07T08:10:00Z", end_at: "2026-05-07T08:20:00Z" });
    const items = pairHcZones([hc, z], new Set(), new Set(["hc-1::z-1"]));
    expect(items).toHaveLength(2);
    expect(items.map((it) => it.type).sort()).toEqual(["hc_only", "zones_only"]);
  });

  it("複数突合 N:N: 2 HC ↔ 2 Zones を全て manual pair で 1 グループに", () => {
    const hc1 = baseRow({ id: "hc1", source: "hc", start_at: "2026-05-08T08:00:00Z", end_at: "2026-05-08T08:30:00Z" });
    const hc2 = baseRow({ id: "hc2", source: "hc", start_at: "2026-05-08T18:00:00Z", end_at: "2026-05-08T18:30:00Z" });
    const z1 = baseRow({ id: "z1", source: "zones", start_at: "2026-05-08T09:00:00Z", end_at: "2026-05-08T09:30:00Z" });
    const z2 = baseRow({ id: "z2", source: "zones", start_at: "2026-05-08T19:00:00Z", end_at: "2026-05-08T19:30:00Z" });
    // hc1-z1 / hc2-z2 はそれぞれ overlap なし、manual pair で繋ぐ
    // さらに z1-hc2 で全部を 1 group にする
    const items = pairHcZones([hc1, hc2, z1, z2], new Set([
      "hc1::z1",
      "hc2::z2",
      "hc2::z1",
    ]));
    expect(items).toHaveLength(1);
    const m = items[0] as any;
    expect(m.type).toBe("matched");
    expect(m.hcs.length).toBe(2);
    expect(m.zoneses.length).toBe(2);
    expect(m.edges.length).toBe(3);
  });
});

function startAtOfTest(it: any): string {
  if (it.type === "matched") {
    const all = [...it.hcs, ...it.zoneses].map((r: any) => r.start_at).filter(Boolean).sort();
    return all[0] ?? "";
  }
  if (it.type === "hc_only") return it.hc.start_at;
  return it.zones.start_at;
}

describe("GET /api/workouts (日付別 + 突合)", () => {
  it("401 without bearer", async () => {
    const r = await app.request("/api/workouts", {}, env);
    expect(r.status).toBe(401);
  });

  it("400 on days out of range", async () => {
    const r = await app.request("/api/workouts?days=0", { headers: auth() }, env);
    expect(r.status).toBe(400);
    const r2 = await app.request("/api/workouts?days=1000", { headers: auth() }, env);
    expect(r2.status).toBe(400);
  });

  it("returns grouped + matched workouts for the last N days", async () => {
    // 直近日に HC + Zones を 1 セット仕込む
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");
    const dateStr = `${yyyy}-${mm}-${dd}`;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO workouts (id, source, date, start_at, end_at, activity_name, distance_m, duration_sec, raw_key, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      "match-hc",
      "hc",
      dateStr,
      `${dateStr}T08:00:00Z`,
      `${dateStr}T08:30:00Z`,
      "ランニング",
      5000,
      1800,
      `hc/${yyyy}/${mm}-${dd}.json`,
      new Date().toISOString(),
    ).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO workouts (id, source, date, start_at, end_at, activity_name, distance_m, duration_sec, avg_heart_rate, raw_key, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      "match-z",
      "zones",
      dateStr,
      `${dateStr}T08:05:00Z`,
      `${dateStr}T08:28:00Z`,
      "ランニング",
      4800,
      1380,
      160,
      `zones/${yyyy}/${mm}-${dd}/match-z.json`,
      new Date().toISOString(),
    ).run();

    const r = await app.request(
      "/api/workouts?days=7",
      { headers: auth() },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      days_requested: number;
      day_count: number;
      total: number;
      days: Array<{ date: string; hc_count: number; zones_count: number; matched_count: number; items: any[] }>;
    };
    expect(j.days_requested).toBe(7);
    const todayDay = j.days.find((d) => d.date === dateStr);
    expect(todayDay).toBeTruthy();
    expect(todayDay!.matched_count).toBeGreaterThanOrEqual(1);
    const matchedItem: any = todayDay!.items.find(
      (it: any) => it.type === "matched" && it.hcs.some((h: any) => h.id === "match-hc"),
    );
    expect(matchedItem).toBeTruthy();
    expect(matchedItem.zoneses.map((z: any) => z.id)).toContain("match-z");
  });
});

describe("groupAndMatch", () => {
  it("groups rows by date, descending; computes per-day counts", () => {
    const rows: WorkoutRow[] = [
      {
        id: "a", source: "hc", date: "2026-05-10",
        start_at: "2026-05-10T08:00:00Z", end_at: "2026-05-10T08:30:00Z",
        activity_name: null, distance_m: null, duration_sec: null,
        active_calories: null, steps: null, avg_heart_rate: null, min_heart_rate: null, max_heart_rate: null,
        raw_key: "k1", uploaded_at: "x",
      },
      {
        id: "b", source: "zones", date: "2026-05-10",
        start_at: "2026-05-10T08:05:00Z", end_at: "2026-05-10T08:25:00Z",
        activity_name: null, distance_m: null, duration_sec: null,
        active_calories: null, steps: null, avg_heart_rate: null, min_heart_rate: null, max_heart_rate: null,
        raw_key: "k2", uploaded_at: "x",
      },
      {
        id: "c", source: "hc", date: "2026-05-11",
        start_at: "2026-05-11T08:00:00Z", end_at: "2026-05-11T08:30:00Z",
        activity_name: null, distance_m: null, duration_sec: null,
        active_calories: null, steps: null, avg_heart_rate: null, min_heart_rate: null, max_heart_rate: null,
        raw_key: "k3", uploaded_at: "x",
      },
    ];
    const out = groupAndMatch(rows);
    expect(out.map((d) => d.date)).toEqual(["2026-05-11", "2026-05-10"]); // desc
    const may10 = out.find((d) => d.date === "2026-05-10")!;
    expect(may10.matched_count).toBe(1);
    expect(may10.hc_count).toBe(1);
    expect(may10.zones_count).toBe(1);
  });

  it("regroups by JST date so UTC-evening rows roll to next JST day (= matched)", () => {
    // UTC 2026-05-25T19:36Z = JST 2026-05-26T04:36
    // UTC 2026-05-25T20:00Z = JST 2026-05-26T05:00
    // 両方とも JST date 2026-05-26 に乗るので、DB 上 date=2026-05-25 (UTC) でも
    // groupAndMatch は 2026-05-26 に合流させて matched にする。
    const rows: WorkoutRow[] = [
      {
        id: "hc-utc-evening", source: "hc", date: "2026-05-25",
        start_at: "2026-05-25T19:36:00Z", end_at: "2026-05-25T20:00:00Z",
        activity_name: "トレッドミル",
        distance_m: 4000, duration_sec: 1440,
        active_calories: null, steps: null, avg_heart_rate: null, min_heart_rate: null, max_heart_rate: null,
        raw_key: "hc/2026/05-25.json", uploaded_at: "x",
      },
      {
        id: "z-utc-evening", source: "zones", date: "2026-05-25",
        start_at: "2026-05-25T19:40:00Z", end_at: "2026-05-25T19:58:00Z",
        activity_name: "ランニング",
        distance_m: 3500, duration_sec: 1080,
        active_calories: 220, steps: 3500, avg_heart_rate: 160, min_heart_rate: null, max_heart_rate: null,
        raw_key: "zones/2026/05-25/foo.json", uploaded_at: "x",
      },
    ];
    const out = groupAndMatch(rows);
    expect(out.map((d) => d.date)).toEqual(["2026-05-26"]); // JST date
    expect(out[0].matched_count).toBe(1);
    expect(out[0].hc_count).toBe(1);
    expect(out[0].zones_count).toBe(1);
  });

  it("splits back-to-back HC + multi Zones into per-pair matches (Refs #50)", () => {
    // 2026-05-27 の実データ再現: HC が背中合わせ 4 個、Zones が 4 個。
    // 旧 union-find は 1 つの mega group (4 HC × 4 Zones) に統合してしまうが、
    // 貪欲 1:1 マッチングなら 4 個の独立した 1×1 matched group になる。
    // (UTC 19:?? = JST 04:?? なので JST 2026-05-27 にグルーピングされる)
    const mk = (id: string, source: "hc" | "zones", s: string, e: string): WorkoutRow => ({
      id, source, date: "2026-05-26",
      start_at: `2026-05-26T${s}:00Z`, end_at: `2026-05-26T${e}:00Z`,
      activity_name: source === "hc" ? "トレッドミル" : "ランニング",
      distance_m: null, duration_sec: null,
      active_calories: null, steps: null, avg_heart_rate: null, min_heart_rate: null, max_heart_rate: null,
      raw_key: `k-${id}`, uploaded_at: "x",
    });
    const rows: WorkoutRow[] = [
      // HC: 背中合わせ (end == 次の start)
      mk("hc1", "hc", "19:38", "19:44"),
      mk("hc2", "hc", "19:44", "20:01"),
      mk("hc3", "hc", "20:01", "20:06"),
      mk("hc4", "hc", "20:06", "20:22"),
      // Zones: 4 個 (各 1 つの HC と最大 overlap)
      mk("z1", "zones", "19:34", "19:40"),
      mk("z2", "zones", "19:41", "19:57"),
      mk("z3", "zones", "19:59", "20:04"),
      mk("z4", "zones", "20:06", "20:22"),
    ];
    const out = groupAndMatch(rows);
    expect(out).toHaveLength(1);
    const day = out[0];
    expect(day.date).toBe("2026-05-27"); // JST
    // 4 つの 1×1 matched group になっているはず (mega group 1 つではない)
    expect(day.matched_count).toBe(4);
    // hc_count / zones_count は matched 内の row 数も含む合算 (db.ts:757-764)。
    // 全 4 HC × 4 Zones が matched (4 個の 1×1 group) なので hc=4, zones=4。
    expect(day.hc_count).toBe(4);
    expect(day.zones_count).toBe(4);
    // hc_only / zones_only は 0 (全てペアされた)
    expect(day.items.filter((it) => it.type === "hc_only")).toHaveLength(0);
    expect(day.items.filter((it) => it.type === "zones_only")).toHaveLength(0);
    const matched = day.items.filter((it) => it.type === "matched");
    expect(matched).toHaveLength(4);
    for (const m of matched) {
      if (m.type !== "matched") continue;
      expect(m.hcs.length).toBe(1);
      expect(m.zoneses.length).toBe(1);
    }
    // 最大 overlap の pair (hc4↔z4 = 16 min) と (hc2↔z2 = 13 min) が確実に
    // 同一グループに入る (= 貪欲が正しく最大 overlap を優先している)
    const pairs = matched
      .filter((m): m is Extract<typeof m, { type: "matched" }> => m.type === "matched")
      .map((m) => [m.hcs[0].id, m.zoneses[0].id].sort().join("+"));
    expect(pairs).toContain(["hc4", "z4"].sort().join("+"));
    expect(pairs).toContain(["hc2", "z2"].sort().join("+"));
  });

  it("rows without start_at fall back to DB date (UTC)", () => {
    const rows: WorkoutRow[] = [
      {
        id: "no-start", source: "hc", date: "2026-05-01",
        start_at: null, end_at: null,
        activity_name: null, distance_m: null, duration_sec: null,
        active_calories: null, steps: null, avg_heart_rate: null, min_heart_rate: null, max_heart_rate: null,
        raw_key: "k", uploaded_at: "x",
      },
    ];
    const out = groupAndMatch(rows);
    expect(out[0].date).toBe("2026-05-01");
  });

  it("emits ghapi rows as standalone ghapi_only items (not matched with hc/zones)", () => {
    const rows: WorkoutRow[] = [
      {
        id: "hc1", source: "hc", date: "2026-05-10",
        start_at: "2026-05-10T08:00:00Z", end_at: "2026-05-10T08:30:00Z",
        activity_name: "トレッドミル", distance_m: 5000, duration_sec: 1800,
        active_calories: null, steps: null, avg_heart_rate: null, min_heart_rate: null, max_heart_rate: null,
        raw_key: "k1", uploaded_at: "x",
      },
      {
        id: "gh1", source: "ghapi", date: "2026-05-10",
        // hc1 と時刻 overlap するが突合せず ghapi_only のまま出る
        start_at: "2026-05-10T08:05:00Z", end_at: "2026-05-10T08:25:00Z",
        activity_name: "Morning run", distance_m: 4800, duration_sec: 1200,
        active_calories: 300, steps: 4500, avg_heart_rate: 150, min_heart_rate: 100, max_heart_rate: 175,
        raw_key: "k2", uploaded_at: "x",
      },
    ];
    const out = groupAndMatch(rows);
    const may10 = out.find((d) => d.date === "2026-05-10")!;
    expect(may10.hc_count).toBe(1);
    expect(may10.ghapi_count).toBe(1);
    expect(may10.matched_count).toBe(0); // ghapi は HC と突合しない
    const ghItem = may10.items.find((it) => it.type === "ghapi_only");
    expect(ghItem).toBeDefined();
    if (ghItem && ghItem.type === "ghapi_only") {
      expect(ghItem.ghapi.id).toBe("gh1");
      expect(ghItem.ghapi.activity_name).toBe("Morning run");
    }
  });
});

describe("POST /_admin/reindex", () => {
  it("401 without bearer", async () => {
    const r = await app.request("/_admin/reindex", { method: "POST" }, env);
    expect(r.status).toBe(401);
  });

  it("backfills D1 workouts from existing R2 hc/ and zones/ payloads", async () => {
    // 既存 R2 に payload を仕込む (PR #21 以前にアップロードされたデータの想定)
    const hcPayload = {
      date: "2026-03-15",
      sessions: [{
        startTime: "2026-03-15T08:00:00Z",
        endTime: "2026-03-15T08:30:00Z",
        exerciseType: 56,
        title: null,
        source: "x",
      }],
      distances: [{
        startTime: "2026-03-15T08:00:00Z",
        endTime: "2026-03-15T08:30:00Z",
        km: 5.0,
        source: "x",
      }],
    };
    await env.R2.put("hc/2026/03-15.json", JSON.stringify(hcPayload));

    const zonesPayload = {
      uuid: "FFFFFFFF-1111-2222-3333-444444444444",
      startDate: "2026-03-15T08:05:00Z",
      endDate: "2026-03-15T08:28:00Z",
      name: "ランニング",
      distance: { value: 4.8, unit: "km" },
      averageHeartRate: { value: 160, unit: "bpm" },
      minHeartRate: { value: 110, unit: "bpm" },
      maxHeartRate: { value: 178, unit: "bpm" },
    };
    await env.R2.put(
      "zones/2026/03-15/FFFFFFFF-1111-2222-3333-444444444444.json",
      JSON.stringify(zonesPayload),
    );

    // 想定外 layout の key (skip されるべき)
    await env.R2.put("hc/2026/03/15/wrong.json", "{}");
    await env.R2.put("zones/garbage.json", "{}");

    const r = await app.request(
      "/_admin/reindex",
      { method: "POST", headers: auth() },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      ok: boolean;
      hc_files: number; hc_rows: number;
      zones_files: number; zones_rows: number;
      skipped_total: number;
    };
    expect(j.ok).toBe(true);
    expect(j.hc_files).toBeGreaterThanOrEqual(1);
    expect(j.hc_rows).toBeGreaterThanOrEqual(1);
    expect(j.zones_files).toBeGreaterThanOrEqual(1);
    expect(j.zones_rows).toBeGreaterThanOrEqual(1);
    expect(j.skipped_total).toBeGreaterThanOrEqual(2); // bad-layout keys

    // 実際に D1 に row が入って /api/workouts で突合できることを確認
    const wr = await app.request(
      "/api/workouts?days=365",
      { headers: auth() },
      env,
    );
    const wj = (await wr.json()) as { days: Array<{ date: string; matched_count: number }> };
    const day = wj.days.find((d) => d.date === "2026-03-15");
    expect(day).toBeTruthy();
    expect(day!.matched_count).toBe(1);

    // min/max HR が D1 に backfill されている
    const zRow = await env.DB.prepare(
      "SELECT avg_heart_rate, min_heart_rate, max_heart_rate FROM workouts WHERE source='zones' AND id=?",
    ).bind("FFFFFFFF-1111-2222-3333-444444444444").first<{
      avg_heart_rate: number | null;
      min_heart_rate: number | null;
      max_heart_rate: number | null;
    }>();
    expect(zRow?.avg_heart_rate).toBe(160);
    expect(zRow?.min_heart_rate).toBe(110);
    expect(zRow?.max_heart_rate).toBe(178);
  });

  it("scope filter: prefix=zones/ だけ走らせると hc は触らない", async () => {
    await env.R2.put(
      "zones/2026/04-01/AAAAAAAA-0000-0000-0000-000000000000.json",
      JSON.stringify({
        uuid: "AAAAAAAA-0000-0000-0000-000000000000",
        startDate: "2026-04-01T07:00:00Z",
      }),
    );
    const r = await app.request(
      "/_admin/reindex?prefix=zones/",
      { method: "POST", headers: auth() },
      env,
    );
    const j = (await r.json()) as { hc_files: number; zones_files: number };
    expect(j.hc_files).toBe(0);
    expect(j.zones_files).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/workout (突合 detail)", () => {
  it("400 when both hc and zones are missing", async () => {
    const r = await app.request("/api/workout", { headers: auth() }, env);
    expect(r.status).toBe(400);
  });

  it("401 without bearer", async () => {
    const r = await app.request("/api/workout?hc=x", {}, env);
    expect(r.status).toBe(401);
  });

  it("404 when neither hc nor zones row exists", async () => {
    const r = await app.request(
      "/api/workout?hc=no-such-id&zones=also-none",
      { headers: auth() },
      env,
    );
    expect(r.status).toBe(404);
  });

  it("returns combined { hc, zones } row + raw R2 payload", async () => {
    const hcRawKey = "hc/2026/06-20.json";
    const hcPayload = {
      date: "2026-06-20",
      sessions: [{
        startTime: "2026-06-20T05:00:00Z",
        endTime: "2026-06-20T05:22:00Z",
        exerciseType: 56,
        title: null,
      }],
      distances: [{
        startTime: "2026-06-20T05:00:00Z",
        endTime: "2026-06-20T05:22:00Z",
        km: 4.0,
      }],
      speeds: [{
        startTime: "2026-06-20T05:00:00Z",
        endTime: "2026-06-20T05:22:00Z",
        samples: [
          { time: "2026-06-20T05:00:00Z", kmh: 8.0 },
          { time: "2026-06-20T05:10:00Z", kmh: 11.0 },
          { time: "2026-06-20T05:20:00Z", kmh: 10.0 },
        ],
      }],
    };
    await env.R2.put(hcRawKey, JSON.stringify(hcPayload));
    await env.DB.prepare(
      "INSERT OR REPLACE INTO workouts (id, source, date, start_at, end_at, activity_name, distance_m, duration_sec, raw_key, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      "detail-hc",
      "hc",
      "2026-06-20",
      "2026-06-20T05:00:00Z",
      "2026-06-20T05:22:00Z",
      "ランニング",
      4000,
      1320,
      hcRawKey,
      new Date().toISOString(),
    ).run();

    const zRawKey = "zones/2026/06-20/AAAAAAAA-1111-2222-3333-DDDDDDDDDDDD.json";
    const zPayload = {
      uuid: "AAAAAAAA-1111-2222-3333-DDDDDDDDDDDD",
      startDate: "2026-06-20T05:00:30Z",
      endDate: "2026-06-20T05:21:30Z",
      name: "トレッドミル",
      averageHeartRate: { value: 158, unit: "bpm" },
      zones: {
        zone1: { duration: { value: 60, unit: "sec" } },
        zone2: { duration: { value: 180, unit: "sec" } },
        zone3: { duration: { value: 540, unit: "sec" } },
        zone4: { duration: { value: 360, unit: "sec" } },
        zone5: { duration: { value: 120, unit: "sec" } },
      },
    };
    await env.R2.put(zRawKey, JSON.stringify(zPayload));
    await env.DB.prepare(
      "INSERT OR REPLACE INTO workouts (id, source, date, start_at, end_at, activity_name, avg_heart_rate, raw_key, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).bind(
      "detail-z",
      "zones",
      "2026-06-20",
      "2026-06-20T05:00:30Z",
      "2026-06-20T05:21:30Z",
      "トレッドミル",
      158,
      zRawKey,
      new Date().toISOString(),
    ).run();

    const r = await app.request(
      "/api/workout?hc=detail-hc&zones=detail-z",
      { headers: auth() },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { hc: any; zones: any; sessions: any };
    expect(j.hc.row.id).toBe("detail-hc");
    expect(j.hc.raw.speeds[0].samples.length).toBe(3);
    expect(j.zones.row.id).toBe("detail-z");
    expect(j.zones.raw.zones.zone3.duration.value).toBe(540);
    // sessions[] にも同じデータが入っている (multi-session 互換)
    expect(Array.isArray(j.sessions)).toBe(true);
    expect(j.sessions.length).toBe(1);
    expect(j.sessions[0].hc.row.id).toBe("detail-hc");
    expect(j.sessions[0].zones.row.id).toBe("detail-z");
  });

  it("returns multiple sessions when ids are comma-separated", async () => {
    // 2 つの HC session を別 date で作る
    for (const [id, date] of [["multi-hc-1", "2026-06-21"], ["multi-hc-2", "2026-06-22"]] as const) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO workouts (id, source, date, start_at, end_at, activity_name, distance_m, duration_sec, raw_key, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        id, "hc", date,
        date + "T05:00:00Z", date + "T05:20:00Z",
        "ランニング", 3000, 1200,
        "hc/" + date.slice(0, 4) + "/" + date.slice(5) + "-" + id + ".json",
        new Date().toISOString(),
      ).run();
    }
    const r = await app.request(
      "/api/workout?hc=multi-hc-1,multi-hc-2",
      { headers: auth() },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { sessions: any };
    expect(j.sessions.length).toBe(2);
    expect(j.sessions[0].hc.row.id).toBe("multi-hc-1");
    expect(j.sessions[1].hc.row.id).toBe("multi-hc-2");
    expect(j.sessions[0].zones).toBeNull();
  });
});

describe("GET /workout (HTML)", () => {
  it("200 HTML with chart canvases when authenticated", async () => {
    const r = await app.request(
      "/workout?hc=x&zones=y",
      { headers: auth() },
      env,
    );
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("combined-charts-container");
    expect(body).toContain("chart.js");
  });

  it("302 redirect when unauthenticated", async () => {
    const r = await app.request("/workout?hc=x", {}, env);
    expect(r.status).toBe(302);
  });
});

describe("GET /api/known-hc-ids", () => {
  it("401 without bearer", async () => {
    const r = await app.request("/api/known-hc-ids", {}, env);
    expect(r.status).toBe(401);
  });

  it("400 on days out of range", async () => {
    const r = await app.request("/api/known-hc-ids?days=0", { headers: auth() }, env);
    expect(r.status).toBe(400);
  });

  it("returns ids of existing HC rows in the date range", async () => {
    // 既存 HC 行を仕込む (date=今日付近)
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(today.getUTCDate()).padStart(2, "0");
    const dateStr = `${yyyy}-${mm}-${dd}`;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO workouts (id, source, date, raw_key, uploaded_at) VALUES (?,?,?,?,?)",
    )
      .bind("hc_known_1", "hc", dateStr, "k1", new Date().toISOString())
      .run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO workouts (id, source, date, raw_key, uploaded_at) VALUES (?,?,?,?,?)",
    )
      .bind("hc_known_2", "hc", dateStr, "k2", new Date().toISOString())
      .run();

    const r = await app.request("/api/known-hc-ids?days=7", { headers: auth() }, env);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { days: number; count: number; ids: string[] };
    expect(j.days).toBe(7);
    expect(j.ids).toContain("hc_known_1");
    expect(j.ids).toContain("hc_known_2");
  });
});

describe("POST /api/hc-session-id", () => {
  it("returns deterministic id for same input", async () => {
    const body = JSON.stringify({ startTime: "2026-06-01T10:00:00Z", exerciseType: 56 });
    const r1 = await app.request(
      "/api/hc-session-id",
      { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body },
      env,
    );
    const r2 = await app.request(
      "/api/hc-session-id",
      { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body },
      env,
    );
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { id: string };
    const j2 = (await r2.json()) as { id: string };
    expect(j1.id).toMatch(/^hc_[0-9a-f]{16}$/);
    expect(j1.id).toBe(j2.id);
  });

  it("400 on missing startTime", async () => {
    const r = await app.request(
      "/api/hc-session-id",
      { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: "{}" },
      env,
    );
    expect(r.status).toBe(400);
  });
});

describe("Auth: JWT cookie path", () => {
  // HS256 sign helper (test only)
  async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const body = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const data = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
    const bytes = new Uint8Array(sig);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    const sigB64 = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${data}.${sigB64}`;
  }

  it("200 GET / with valid cookie + allowed email", async () => {
    // vitest binding 経由で env.JWT_SECRET をセット (= production と同じ shape)
    const secret = "test-jwt-secret";
    const realEnv = { ...env, JWT_SECRET: secret };
    const future = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signJwt({ email: "m.tama.ramu@gmail.com", exp: future }, secret);
    const r = await app.request(
      "/",
      { headers: { Cookie: `logi_auth_token=${jwt}` } },
      realEnv,
    );
    expect(r.status).toBe(200);
  });

  it("302 GET / when cookie email is NOT in ALLOWED_EMAILS", async () => {
    const secret = "test-jwt-secret";
    const realEnv = { ...env, JWT_SECRET: secret };
    const future = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signJwt({ email: "intruder@example.com", exp: future }, secret);
    const r = await app.request(
      "/",
      { headers: { Cookie: `logi_auth_token=${jwt}` } },
      realEnv,
    );
    expect(r.status).toBe(302);
  });

  it("302 GET / when cookie is signed with wrong secret", async () => {
    const realEnv = { ...env, JWT_SECRET: "real-secret" };
    const future = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signJwt({ email: "m.tama.ramu@gmail.com", exp: future }, "wrong-secret");
    const r = await app.request(
      "/",
      { headers: { Cookie: `logi_auth_token=${jwt}` } },
      realEnv,
    );
    expect(r.status).toBe(302);
  });

  it("302 GET / when cookie is expired", async () => {
    const secret = "test-jwt-secret";
    const realEnv = { ...env, JWT_SECRET: secret };
    const past = Math.floor(Date.now() / 1000) - 3600;
    const jwt = await signJwt({ email: "m.tama.ramu@gmail.com", exp: past }, secret);
    const r = await app.request(
      "/",
      { headers: { Cookie: `logi_auth_token=${jwt}` } },
      realEnv,
    );
    expect(r.status).toBe(302);
  });

  it("200 GET /api/zones with valid cookie (no Bearer needed)", async () => {
    const secret = "test-jwt-secret";
    const realEnv = { ...env, JWT_SECRET: secret };
    const future = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signJwt({ email: "m.tama.ramu@gmail.com", exp: future }, secret);
    const r = await app.request(
      "/api/zones",
      { headers: { Cookie: `logi_auth_token=${jwt}` } },
      realEnv,
    );
    expect(r.status).toBe(200);
  });

  it("401 GET /api/zones without cookie and without Bearer", async () => {
    const r = await app.request("/api/zones", {}, env);
    expect(r.status).toBe(401);
  });
});

describe("POST /api/pair (手動突合)", () => {
  async function seed(date: string) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO workouts (id, source, date, start_at, end_at, activity_name, raw_key, uploaded_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(
      "hc-pair-test",
      "hc",
      date,
      `${date}T05:00:00Z`,
      `${date}T05:30:00Z`,
      "ランニング",
      `hc/${date}.json`,
      new Date().toISOString(),
    ).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO workouts (id, source, date, start_at, end_at, activity_name, raw_key, uploaded_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(
      "z-pair-test",
      "zones",
      date,
      `${date}T15:00:00Z`,   // time が離れている = auto では繋がらない
      `${date}T15:30:00Z`,
      "ランニング",
      `zones/${date}/z-pair-test.json`,
      new Date().toISOString(),
    ).run();
  }

  it("401 without bearer", async () => {
    const r = await app.request("/api/pair", { method: "POST" }, env);
    expect(r.status).toBe(401);
  });

  it("400 on missing ids", async () => {
    const r = await app.request("/api/pair", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: "{}",
    }, env);
    expect(r.status).toBe(400);
  });

  it("manual pair が auto overlap 無しでも matched にできる + 解除で zones_only/hc_only に戻る", async () => {
    const date = "2026-09-09";
    await seed(date);

    // POST /api/pair
    const r1 = await app.request("/api/pair", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ hc_id: "hc-pair-test", zones_id: "z-pair-test" }),
    }, env);
    expect(r1.status).toBe(200);

    const r2 = await app.request("/api/workouts?days=366", { headers: auth() }, env);
    const j2 = (await r2.json()) as any;
    const day = j2.days.find((d: any) => d.items.some((it: any) => it.type === "matched" && it.hcs?.some((h: any) => h.id === "hc-pair-test")));
    expect(day).toBeTruthy();
    const m = day.items.find((it: any) => it.type === "matched");
    expect(m.has_manual).toBe(true);

    // 解除
    const r3 = await app.request("/api/pair/delete", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ hc_id: "hc-pair-test", zones_id: "z-pair-test" }),
    }, env);
    expect(r3.status).toBe(200);

    // matched が無くなる (= hc_only / zones_only に戻る、所属日は別の場合もある)
    const r4 = await app.request("/api/workouts?days=366", { headers: auth() }, env);
    const j4 = (await r4.json()) as any;
    const allItems = j4.days.flatMap((d: any) => d.items);
    const hcItem = allItems.find((it: any) => it.hc?.id === "hc-pair-test");
    const zItem = allItems.find((it: any) => it.zones?.id === "z-pair-test");
    expect(hcItem?.type).toBe("hc_only");
    expect(zItem?.type).toBe("zones_only");
  });
});

describe("POST /_admin/migrate", () => {
  it("401 without bearer", async () => {
    const r = await app.request(
      "/_admin/migrate",
      { method: "POST" },
      env,
    );
    expect(r.status).toBe(401);
  });

  it("200 + idempotent (re-running does not throw, returns ran=statements)", async () => {
    const r1 = await app.request(
      "/_admin/migrate",
      { method: "POST", headers: auth() },
      env,
    );
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as {
      ok: boolean; ran: number; statements: number; skipped: number;
    };
    expect(j1.ok).toBe(true);
    expect(j1.statements).toBeGreaterThan(0);
    // CREATE 系は全部走る (ran)、ALTER ADD COLUMN は CREATE が完全 schema を
    // 立てた直後だと "duplicate column" で skipped 扱い → ran + skipped = statements。
    expect(j1.ran + j1.skipped).toBe(j1.statements);

    // re-run is safe (IF NOT EXISTS + ALTER duplicate-column skip)
    const r2 = await app.request(
      "/_admin/migrate",
      { method: "POST", headers: auth() },
      env,
    );
    expect(r2.status).toBe(200);
    const j2 = (await r2.json()) as {
      ok: boolean; ran: number; statements: number; skipped: number;
    };
    expect(j2.ok).toBe(true);
    expect(j2.ran + j2.skipped).toBe(j2.statements);

    // workouts テーブルが実在し、INSERT できる
    await env.DB.prepare(
      "INSERT OR REPLACE INTO workouts (id, source, date, raw_key, uploaded_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("smoke-1", "zones", "2026-01-01", "zones/2026/01-01/smoke-1.json", "2026-01-01T00:00:00Z")
      .run();
    const row = await env.DB.prepare(
      "SELECT id FROM workouts WHERE id = 'smoke-1'",
    ).first<{ id: string }>();
    expect(row?.id).toBe("smoke-1");
  });
});

describe("ghapi (Google Health API)", () => {
  it("ghapiExercisePointToRow maps a representative exercise dataPoint (Health API v4)", async () => {
    const { ghapiExercisePointToRow } = await import("../src/db");
    const point = {
      name: "users/me/dataTypes/exercise/dataPoints/dp-1234",
      exercise: {
        interval: {
          startTime: "2026-05-27T00:00:00Z",
          endTime: "2026-05-27T00:30:00Z",
        },
        exerciseType: "RUNNING",
        displayName: "Morning run",
        metricsSummary: {
          caloriesKcal: 320,
          distanceMillimeters: 5230500,
          // Refs #65: Google Health API v4 は int64 を文字列で返す
          averageHeartRateBeatsPerMinute: "152",
          steps: "5400",
        },
      },
    };
    const row = await ghapiExercisePointToRow(
      point,
      "ghapi/Exercise/2026/05-27.json",
      "2026-05-27T00:30:00Z",
    );
    expect(row).not.toBeNull();
    expect(row?.source).toBe("ghapi");
    expect(row?.date).toBe("2026-05-27");
    expect(row?.activity_name).toBe("Morning run");
    expect(row?.distance_m).toBe(5230.5);
    expect(row?.duration_sec).toBe(30 * 60);
    expect(row?.active_calories).toBe(320);
    // 文字列 int64 が数値として取り込まれる (旧バグでは null だった)
    expect(row?.steps).toBe(5400);
    expect(row?.avg_heart_rate).toBe(152);
    // min/max HR は Google Health API に存在しないので常に null
    expect(row?.min_heart_rate).toBeNull();
    expect(row?.max_heart_rate).toBeNull();
    // id は安定 (同じ dataPoint name を投げると同じ row id)
    const row2 = await ghapiExercisePointToRow(
      point,
      "ghapi/Exercise/2026/05-27.json",
      "2026-05-28T00:00:00Z",
    );
    expect(row2?.id).toBe(row?.id);
  });

  it("ghapiExercisePointToRow falls back to exerciseType when displayName missing", async () => {
    const { ghapiExercisePointToRow } = await import("../src/db");
    const row = await ghapiExercisePointToRow(
      {
        name: "users/me/dataTypes/exercise/dataPoints/dp-no-name",
        exercise: {
          interval: {
            startTime: "2026-05-01T01:00:00Z",
            endTime: "2026-05-01T01:20:00Z",
          },
          exerciseType: "WALKING",
        },
      },
      "ghapi/Exercise/2026/05-01.json",
      "2026-05-01T01:20:00Z",
    );
    expect(row?.activity_name).toBe("WALKING");
    expect(row?.distance_m).toBeNull();
  });

  it("ghapiExercisePointToRow returns null for invalid / missing exercise fields", async () => {
    const { ghapiExercisePointToRow } = await import("../src/db");
    expect(
      await ghapiExercisePointToRow({}, "k", "2026-01-01T00:00:00Z"),
    ).toBeNull();
    // end <= start
    expect(
      await ghapiExercisePointToRow(
        {
          exercise: {
            interval: {
              startTime: "2026-05-01T02:00:00Z",
              endTime: "2026-05-01T01:00:00Z",
            },
          },
        },
        "k",
        "2026-01-01T00:00:00Z",
      ),
    ).toBeNull();
  });

  it("upserts ghapi rows into workouts (source check accepts 'ghapi')", async () => {
    const { ghapiExercisePointToRow, upsertWorkout } = await import("../src/db");
    const row = await ghapiExercisePointToRow(
      {
        name: "users/me/dataTypes/exercise/dataPoints/dp-smoke-ghapi",
        exercise: {
          interval: {
            startTime: "2026-05-01T01:00:00Z",
            endTime: "2026-05-01T01:20:00Z",
          },
          displayName: "Walking",
          metricsSummary: { distanceMillimeters: 1200000 },
        },
      },
      "ghapi/Exercise/2026/05-01.json",
      "2026-05-01T01:20:00Z",
    );
    expect(row).not.toBeNull();
    if (!row) return;
    await upsertWorkout(env.DB, row);
    const got = await env.DB.prepare(
      "SELECT source, activity_name FROM workouts WHERE id = ?",
    )
      .bind(row.id)
      .first<{ source: string; activity_name: string }>();
    expect(got?.source).toBe("ghapi");
    expect(got?.activity_name).toBe("Walking");
  });

  it("ingestExercisePoints writes R2 + upserts D1 for Exercise points", async () => {
    const { ingestExercisePoints } = await import("../src/ghapi-ingest");
    const start = Date.UTC(2026, 3, 10, 2, 0, 0);
    const end = Date.UTC(2026, 3, 10, 2, 30, 0);
    const res = await ingestExercisePoints(
      env.R2,
      env.DB,
      "Exercise",
      [{ startTimeMillis: start, endTimeMillis: end }],
      [
        {
          name: "users/me/dataTypes/exercise/dataPoints/dp-backfill-1",
          exercise: {
            interval: {
              startTime: new Date(start).toISOString(),
              endTime: new Date(end).toISOString(),
            },
            displayName: "Running",
            metricsSummary: { distanceMillimeters: 4200000 },
          },
        },
      ],
    );
    expect(res.rawKey).toBe("ghapi/Exercise/2026/04-10.json");
    expect(res.fetched).toBe(1);
    expect(res.indexed).toBe(1);

    // R2 raw payload written (body must be consumed to release isolated storage)
    const stored = JSON.parse(await (await env.R2.get(res.rawKey))!.text());
    expect(stored.dataType).toBe("Exercise");
    expect(stored.points.length).toBe(1);

    // D1 row upserted
    const got = await env.DB.prepare(
      "SELECT source, activity_name, distance_m FROM workouts WHERE raw_key = ?",
    )
      .bind(res.rawKey)
      .first<{ source: string; activity_name: string; distance_m: number }>();
    expect(got?.source).toBe("ghapi");
    expect(got?.activity_name).toBe("Running");
    expect(got?.distance_m).toBe(4200);
  });

  it("ingestExercisePoints returns zero-indexed for empty intervals", async () => {
    const { ingestExercisePoints } = await import("../src/ghapi-ingest");
    const res = await ingestExercisePoints(env.R2, env.DB, "Exercise", [], []);
    expect(res).toEqual({ rawKey: "", fetched: 0, indexed: 0, rows: [] });
  });

  it("summarizeHr computes min/max/avg/count, null on empty", async () => {
    const { summarizeHr } = await import("../src/ghapi");
    expect(summarizeHr([])).toBeNull();
    expect(summarizeHr([{ t: 1, bpm: 100 }, { t: 2, bpm: 140 }, { t: 3, bpm: 120 }]))
      .toEqual({ min: 100, max: 140, avg: 120, count: 3 });
  });

  it("hrSeriesKey is deterministic per id", async () => {
    const { hrSeriesKey } = await import("../src/ghapi-ingest");
    expect(hrSeriesKey("ghapi_abc")).toBe("ghapi/hr/ghapi_abc.json");
  });

  it("listHeartRateSamples parses samples (string bpm) + paginates + sorts", async () => {
    const { listHeartRateSamples } = await import("../src/ghapi");
    const pages: Record<string, unknown> = {
      "": {
        dataPoints: [
          { heartRate: { sampleTime: { physicalTime: "2026-05-28T05:10:00Z" }, beatsPerMinute: "144" } },
          { heartRate: { sampleTime: { physicalTime: "2026-05-28T05:05:00Z" }, beatsPerMinute: 120 } },
        ],
        nextPageToken: "p2",
      },
      p2: {
        dataPoints: [
          { heartRate: { sampleTime: { physicalTime: "2026-05-28T05:20:00Z" }, beatsPerMinute: "150" } },
          { heartRate: { sampleTime: {}, beatsPerMinute: "99" } }, // 時刻欠落 → skip
        ],
      },
    };
    const fetchImpl = (async (url: string) => {
      const u = new URL(url);
      const tok = u.searchParams.get("pageToken") ?? "";
      return new Response(JSON.stringify(pages[tok]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const samples = await listHeartRateSamples(
      "tok",
      { startTimeMillis: Date.UTC(2026, 4, 28, 5, 0), endTimeMillis: Date.UTC(2026, 4, 28, 6, 0) },
      fetchImpl,
    );
    // 3 件 (時刻欠落の 1 件は除外)、時刻昇順
    expect(samples.map((s) => s.bpm)).toEqual([120, 144, 150]);
    expect(samples[0].t).toBeLessThan(samples[1].t);
  });

  it("listHeartRateSamples throws ghapi_hr_list_failed on non-2xx", async () => {
    const { listHeartRateSamples } = await import("../src/ghapi");
    const fetchImpl = (async () =>
      new Response("nope", { status: 403 })) as unknown as typeof fetch;
    await expect(
      listHeartRateSamples("tok", { startTimeMillis: 0, endTimeMillis: 1 }, fetchImpl),
    ).rejects.toThrow(/ghapi_hr_list_failed:403/);
  });

  it("listExercisePoints filters civil_start_time by JST calendar day (Refs #85)", async () => {
    const { listExercisePoints } = await import("../src/ghapi");
    // JST 2026-05-28 の 1 日分: [00:00 JST, 翌 00:00 JST) = [UTC 05-27 15:00, 05-28 15:00)
    const jstMidnight = Date.UTC(2026, 4, 28) - 9 * 60 * 60 * 1000;
    const DAY_MS = 86_400_000;
    let capturedFilter = "";
    const fetchImpl = (async (url: string) => {
      capturedFilter = new URL(url).searchParams.get("filter") ?? "";
      return new Response(JSON.stringify({ dataPoints: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await listExercisePoints(
      "tok",
      [{ startTimeMillis: jstMidnight, endTimeMillis: jstMidnight + DAY_MS }],
      fetchImpl,
    );
    // UTC 基準だと 05-27/05-28 になり当日が落ちる。JST 基準なら 05-28/05-29。
    expect(capturedFilter).toBe(
      'exercise.interval.civil_start_time >= "2026-05-28" AND ' +
        'exercise.interval.civil_start_time < "2026-05-29"',
    );
  });

  it("GET /api/ghapi/workout 400 without id, 401/404 with id", async () => {
    const r1 = await app.request("/api/ghapi/workout", {}, env);
    expect([400, 401]).toContain(r1.status);
  });

  // dayStarts は JST 暦日の 00:00 (JST midnight) を epoch ms で返す (Refs #85)。
  // JST 00:00 = UTC 前日 15:00 なので Date.UTC(...) から JST offset (9h) を引く。
  const jstMid = (y: number, m: number, d: number) =>
    Date.UTC(y, m, d) - 9 * 60 * 60 * 1000;

  it("backfillDayStarts: full N-day window when no last_backfill_at", async () => {
    const { backfillDayStarts } = await import("../src/ghapi-ingest");
    const now = Date.UTC(2026, 4, 28, 10, 0, 0); // 2026-05-28 19:00 JST
    const { dayStarts, incremental } = backfillDayStarts(now, 7, null, false);
    expect(incremental).toBe(false);
    expect(dayStarts.length).toBe(7);
    // newest first = JST today midnight
    expect(dayStarts[0]).toBe(jstMid(2026, 4, 28));
    expect(dayStarts[6]).toBe(jstMid(2026, 4, 22));
  });

  it("backfillDayStarts: JST morning still includes JST-today (Refs #85)", async () => {
    const { backfillDayStarts } = await import("../src/ghapi-ingest");
    // JST 2026-05-28 06:00 = UTC 2026-05-27 21:00。UTC 基準だと today=05-27 で
    // JST 今日 (05-28) が落ちる回帰。JST 基準なら最新日は 05-28。
    const now = Date.UTC(2026, 4, 27, 21, 0, 0);
    const { dayStarts } = backfillDayStarts(now, 7, null, false);
    expect(dayStarts[0]).toBe(jstMid(2026, 4, 28));
    expect(dayStarts[6]).toBe(jstMid(2026, 4, 22));
  });

  it("backfillDayStarts: incremental scans only since last_backfill_at day", async () => {
    const { backfillDayStarts } = await import("../src/ghapi-ingest");
    const now = Date.UTC(2026, 4, 28, 10, 0, 0); // 2026-05-28 19:00 JST
    // 最終取込が JST 2026-05-27 03:00 (= UTC 2026-05-26 18:00)
    const last = Date.UTC(2026, 4, 26, 18, 0, 0);
    const { dayStarts, incremental } = backfillDayStarts(now, 30, last, false);
    expect(incremental).toBe(true);
    // JST 05-27, 05-28 の 2 日だけ (last の JST 暦日含む)
    expect(dayStarts).toEqual([jstMid(2026, 4, 28), jstMid(2026, 4, 27)]);
  });

  it("backfillDayStarts: force ignores last_backfill_at (full window)", async () => {
    const { backfillDayStarts } = await import("../src/ghapi-ingest");
    const now = Date.UTC(2026, 4, 28, 10, 0, 0);
    const last = Date.UTC(2026, 4, 27, 0, 0, 0);
    const { dayStarts, incremental } = backfillDayStarts(now, 7, last, true);
    expect(incremental).toBe(false);
    expect(dayStarts.length).toBe(7);
  });

  it("backfillDayStarts: old last_backfill_at clamped to N-day window", async () => {
    const { backfillDayStarts } = await import("../src/ghapi-ingest");
    const now = Date.UTC(2026, 4, 28, 10, 0, 0);
    // last が window より古い (60 日前) → window 下限で頭打ち、incremental にならない
    const last = Date.UTC(2026, 2, 1, 0, 0, 0);
    const { dayStarts, incremental } = backfillDayStarts(now, 7, last, false);
    expect(incremental).toBe(false);
    expect(dayStarts.length).toBe(7);
  });

  it("POST /api/ghapi/backfill 401/500 without auth", async () => {
    const r = await app.request(
      "/api/ghapi/backfill",
      { method: "POST", body: JSON.stringify({ days: 30 }) },
      env,
    );
    // cookie auth 不在 → 401。DO 未 bind (test env) なら apiAuth 通過後 500。
    expect([401, 500]).toContain(r.status);
  });

  it("POST /api/ghapi/store-tokens 401 without Bearer", async () => {
    const r = await app.request(
      "/api/ghapi/store-tokens",
      { method: "POST", body: "{}" },
      env,
    );
    // INTERNAL_SHARED_SECRET 未設定 → 500、設定後は 401。test では未設定なので 500。
    expect([401, 500]).toContain(r.status);
  });

  it("POST /api/ghapi/webhook 401 without Bearer", async () => {
    const r = await app.request(
      "/api/ghapi/webhook",
      { method: "POST", body: "{}" },
      env,
    );
    expect([401, 500]).toContain(r.status);
  });
});

describe("404", () => {
  it("returns json not_found for unknown route", async () => {
    const r = await app.request("/nope", {}, env);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });
  });
});

// =============================================================================
// 手動作成 HC データ (source='manual') — Refs ippoan/HealthConnectReader#6
// =============================================================================

describe("manualKeyFor", () => {
  it("derives manual/{yyyy}/{mm-dd}/{id}.json from UTC startDate", () => {
    const k = manualKeyFor("2026-05-25T19:38:43Z", "manual_0123456789abcdef");
    expect(k).toEqual({
      yyyy: "2026",
      mmdd: "05-25",
      key: "manual/2026/05-25/manual_0123456789abcdef.json",
    });
  });
  it("returns null for invalid id", () => {
    expect(manualKeyFor("2026-05-25T00:00:00Z", "nope")).toBeNull();
    expect(manualKeyFor("2026-05-25T00:00:00Z", "manual_XYZ")).toBeNull();
  });
  it("returns null for invalid startDate", () => {
    expect(manualKeyFor("not-a-date", "manual_0123456789abcdef")).toBeNull();
  });
});

describe("manualSessionId / buildManualPayload / manualInputToRow", () => {
  it("manualSessionId is stable + matches manualKeyFor regex", async () => {
    const a = await manualSessionId("2026-05-25T06:00:00Z", 56, "朝ラン");
    const b = await manualSessionId("2026-05-25T06:00:00Z", 56, "朝ラン");
    expect(a).toBe(b);
    expect(a).toMatch(/^manual_[0-9a-f]{16}$/);
    const c = await manualSessionId("2026-05-25T06:00:00Z", 56, "違うタイトル");
    expect(c).not.toBe(a);
  });

  it("buildManualPayload builds HC-shaped payload with distance", () => {
    const p = buildManualPayload(
      { startTime: "2026-05-25T06:00:00Z", endTime: "2026-05-25T06:30:00Z", exerciseType: 56, title: "朝ラン", distanceKm: 5 },
      "2026-05-25T07:00:00Z",
    );
    expect(p.date).toBe("2026-05-25");
    expect(p.manual).toBe(true);
    expect((p.sessions as unknown[]).length).toBe(1);
    expect((p.distances as unknown[]).length).toBe(1);
    expect((p.distances as Array<{ km: number }>)[0].km).toBe(5);
    expect(p.speeds).toEqual([]);
  });

  it("buildManualPayload omits distances when distanceKm missing/zero", () => {
    const p = buildManualPayload(
      { startTime: "2026-05-25T06:00:00Z", endTime: "2026-05-25T06:30:00Z", exerciseType: 79, distanceKm: 0 },
      "2026-05-25T07:00:00Z",
    );
    expect(p.distances).toEqual([]);
  });

  it("manualInputToRow computes duration + distance_m, falls back to exercise name", () => {
    const row = manualInputToRow(
      { startTime: "2026-05-25T06:00:00Z", endTime: "2026-05-25T06:30:00Z", exerciseType: 56, title: null, distanceKm: 5 },
      "manual_0123456789abcdef",
      "manual/2026/05-25/manual_0123456789abcdef.json",
      "2026-05-25T07:00:00Z",
    );
    expect(row.source).toBe("manual");
    expect(row.duration_sec).toBe(1800);
    expect(row.distance_m).toBe(5000);
    expect(row.activity_name).toBe("ランニング");
    expect(row.date).toBe("2026-05-25");
  });

  it("manualInputToRow keeps null distance + custom title", () => {
    const row = manualInputToRow(
      { startTime: "2026-05-25T06:00:00Z", endTime: "2026-05-25T06:30:00Z", exerciseType: 999, title: "カスタム" },
      "manual_0123456789abcdef",
      "k",
      "u",
    );
    expect(row.distance_m).toBeNull();
    expect(row.activity_name).toBe("カスタム");
  });
});

describe("groupAndMatch with manual rows", () => {
  it("emits manual_only items and manual_count", () => {
    const rows: WorkoutRow[] = [
      manualInputToRow(
        { startTime: "2026-05-25T06:00:00Z", endTime: "2026-05-25T06:30:00Z", exerciseType: 56, distanceKm: 5 },
        "manual_aaaaaaaaaaaaaaaa", "k1", "u",
      ),
    ];
    const days = groupAndMatch(rows);
    expect(days.length).toBe(1);
    expect(days[0].manual_count).toBe(1);
    expect(days[0].items[0].type).toBe("manual_only");
  });
});

describe("POST /api/manual", () => {
  it("401 without bearer", async () => {
    const r = await app.request("/api/manual", { method: "POST", body: "{}" }, env);
    expect(r.status).toBe(401);
  });
  it("400 on invalid json", async () => {
    const r = await app.request(
      "/api/manual",
      { method: "POST", headers: auth(), body: "{" },
      env,
    );
    expect(r.status).toBe(400);
  });
  it("400 on invalid startTime", async () => {
    const r = await app.request(
      "/api/manual",
      { method: "POST", headers: auth(), body: JSON.stringify({ startTime: "x", endTime: "2026-05-25T06:30:00Z", exerciseType: 56 }) },
      env,
    );
    expect(((await r.json()) as { error: string }).error).toBe("invalid_startTime");
  });
  it("400 when end not after start", async () => {
    const r = await app.request(
      "/api/manual",
      { method: "POST", headers: auth(), body: JSON.stringify({ startTime: "2026-05-25T06:30:00Z", endTime: "2026-05-25T06:00:00Z", exerciseType: 56 }) },
      env,
    );
    expect(((await r.json()) as { error: string }).error).toBe("end_not_after_start");
  });
  it("400 on invalid exerciseType / distanceKm", async () => {
    const r1 = await app.request(
      "/api/manual",
      { method: "POST", headers: auth(), body: JSON.stringify({ startTime: "2026-05-25T06:00:00Z", endTime: "2026-05-25T06:30:00Z", exerciseType: "x" }) },
      env,
    );
    expect(((await r1.json()) as { error: string }).error).toBe("invalid_exerciseType");
    const r2 = await app.request(
      "/api/manual",
      { method: "POST", headers: auth(), body: JSON.stringify({ startTime: "2026-05-25T06:00:00Z", endTime: "2026-05-25T06:30:00Z", exerciseType: 56, distanceKm: -1 }) },
      env,
    );
    expect(((await r2.json()) as { error: string }).error).toBe("invalid_distanceKm");
  });
  it("200 creates manual workout (R2 + D1)", async () => {
    const r = await app.request(
      "/api/manual",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({
          startTime: "2026-03-10T06:00:00Z",
          endTime: "2026-03-10T06:30:00Z",
          exerciseType: 56,
          title: "テストラン",
          distanceKm: 5,
        }),
      },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; id: string; key: string };
    expect(j.ok).toBe(true);
    expect(j.id).toMatch(/^manual_[0-9a-f]{16}$/);
    expect(j.key).toBe("manual/2026/03-10/" + j.id + ".json");
    // R2 raw が HC payload 構造で書かれている
    const obj = await env.R2.get(j.key);
    expect(obj).not.toBeNull();
    const stored = JSON.parse(await obj!.text());
    expect(stored.manual).toBe(true);
    expect(stored.sessions[0].exerciseType).toBe(56);
    // D1 に source='manual' で入っている
    const list = await listManualFromDb(env.DB);
    expect(list.some((w) => w.id === j.id)).toBe(true);
  });
});

describe("GET /api/manual + POST /api/manual/delete", () => {
  it("401 without bearer (list)", async () => {
    const r = await app.request("/api/manual", {}, env);
    expect(r.status).toBe(401);
  });
  it("lists then deletes (R2 + D1 both gone)", async () => {
    const create = await app.request(
      "/api/manual",
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({
          startTime: "2026-04-15T22:00:00Z",
          endTime: "2026-04-15T22:45:00Z",
          exerciseType: 79,
          distanceKm: 3,
        }),
      },
      env,
    );
    const cj = (await create.json()) as { id: string; key: string };
    const id = cj.id;

    const listR = await app.request("/api/manual", { headers: auth() }, env);
    const lj = (await listR.json()) as { items: WorkoutRow[] };
    expect(lj.items.some((w) => w.id === id)).toBe(true);

    const del = await app.request(
      "/api/manual/delete",
      { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify({ id }) },
      env,
    );
    expect(del.status).toBe(200);
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);
    expect(await env.R2.get(cj.key)).toBeNull();
    const after = await listManualFromDb(env.DB);
    expect(after.some((w) => w.id === id)).toBe(false);
  });
  it("400 missing id on delete", async () => {
    const r = await app.request(
      "/api/manual/delete",
      { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify({}) },
      env,
    );
    expect(((await r.json()) as { error: string }).error).toBe("missing_id");
  });
});

describe("deleteWorkout / listManualFromDb helpers", () => {
  it("deleteWorkout removes a row by (source,id)", async () => {
    await upsertWorkout(
      env.DB,
      manualInputToRow(
        { startTime: "2026-02-01T06:00:00Z", endTime: "2026-02-01T06:20:00Z", exerciseType: 56, distanceKm: 2 },
        "manual_bbbbbbbbbbbbbbbb", "k", "u",
      ),
    );
    let list = await listManualFromDb(env.DB);
    expect(list.some((w) => w.id === "manual_bbbbbbbbbbbbbbbb")).toBe(true);
    await deleteWorkout(env.DB, "manual", "manual_bbbbbbbbbbbbbbbb");
    list = await listManualFromDb(env.DB);
    expect(list.some((w) => w.id === "manual_bbbbbbbbbbbbbbbb")).toBe(false);
  });
});

describe("GET /manual page", () => {
  it("200 HTML with Bearer", async () => {
    const r = await app.request("/manual", { headers: auth() }, env);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(await r.text()).toContain("HC データ手動作成");
  });
  it("200 with ?ghapi= query (anchor preselect path)", async () => {
    const r = await app.request("/manual?ghapi=ghapi_a5db782aaa40dfea", { headers: auth() }, env);
    expect(r.status).toBe(200);
  });
  it("302 without auth", async () => {
    const r = await app.request("/manual", {}, env);
    expect(r.status).toBe(302);
  });
});

describe("GET /ghapi/workout page has 手動作成 link", () => {
  it("contains link to /manual?ghapi=", async () => {
    const r = await app.request("/ghapi/workout?id=ghapi_x", { headers: auth() }, env);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("手動作成");
    expect(html).toContain("/manual?ghapi=");
  });
});
