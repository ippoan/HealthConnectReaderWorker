import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import app from "../src/index";
import {
  groupAndMatch,
  hcPayloadToRows,
  listWorkouts,
  pairHcZones,
  zonesPayloadToRow,
} from "../src/db";
import type { WorkoutRow } from "../src/db";
import { applySchema } from "../src/migrations";
import { summarizeHistory, uploadKeyFor, zonesKeyFor } from "../src/r2";

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

  it("incremental: skips days whose R2 key already exists (Refs #7)", async () => {
    // Pre-populate one of the two days
    await env.R2.put("hc/2026/06-10.json", '{"old":true}');
    const body = JSON.stringify({
      days: [
        { date: "2026-06-10", payload: { fresh: 1 } }, // should be skipped (already exists)
        { date: "2026-06-11", payload: { fresh: 2 } }, // should be written
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
      skipped: Array<{ index: number; reason: string; key?: string }>;
      force: boolean;
    };
    expect(j.written).toBe(1);
    expect(j.keys).toEqual(["hc/2026/06-11.json"]);
    expect(j.force).toBe(false);
    expect(j.skipped).toContainEqual({
      index: 0,
      reason: "already_exists",
      key: "hc/2026/06-10.json",
    });
    // existing key was untouched
    expect(await (await env.R2.get("hc/2026/06-10.json"))!.text()).toBe('{"old":true}');
    // new key was written
    expect(await (await env.R2.get("hc/2026/06-11.json"))!.text()).toBe('{"fresh":2}');
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
    await env.R2.put("hc/2026/08-01.json", "{}");
    await env.R2.put("hc/2026/08-02.json", "{}");
    const body = JSON.stringify({
      days: [
        { date: "2026-08-01", payload: { a: 1 } },
        { date: "2026-08-02", payload: { a: 2 } },
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
    expect(j.skipped.filter((s) => s.reason === "already_exists")).toHaveLength(2);
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

  it("upload-batch: skipped (already-exists) days are not re-indexed", async () => {
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
    expect(j.written).toBe(1); // 11-02 のみ
    expect(j.indexed).toBe(1);
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
    expect(items[0]).toMatchObject({ type: "matched", overlap_sec: 20 * 60 });
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

  it("greedy: when 2 HC sessions overlap same Zone, earliest HC wins", () => {
    const z = baseRow({ id: "z1", source: "zones", start_at: "2026-05-05T10:00:00Z", end_at: "2026-05-05T11:00:00Z" });
    const hcEarly = baseRow({ id: "hc-early", source: "hc", start_at: "2026-05-05T10:00:00Z", end_at: "2026-05-05T10:30:00Z" });
    const hcLate = baseRow({ id: "hc-late", source: "hc", start_at: "2026-05-05T10:31:00Z", end_at: "2026-05-05T11:00:00Z" });
    const items = pairHcZones([hcEarly, hcLate, z]);
    const early = items.find((it) => "hc" in it && it.hc?.id === "hc-early");
    const late = items.find((it) => "hc" in it && it.hc?.id === "hc-late");
    expect(early?.type).toBe("matched");
    expect(late?.type).toBe("hc_only");
  });
});

function startAtOfTest(it: any): string {
  if (it.type === "matched") return it.hc.start_at;
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
    const matchedItem = todayDay!.items.find((it: any) => it.type === "matched" && it.hc.id === "match-hc");
    expect(matchedItem).toBeTruthy();
    expect(matchedItem.zones.id).toBe("match-z");
  });
});

describe("groupAndMatch", () => {
  it("groups rows by date, descending; computes per-day counts", () => {
    const rows: WorkoutRow[] = [
      {
        id: "a", source: "hc", date: "2026-05-10",
        start_at: "2026-05-10T08:00:00Z", end_at: "2026-05-10T08:30:00Z",
        activity_name: null, distance_m: null, duration_sec: null,
        active_calories: null, steps: null, avg_heart_rate: null,
        raw_key: "k1", uploaded_at: "x",
      },
      {
        id: "b", source: "zones", date: "2026-05-10",
        start_at: "2026-05-10T08:05:00Z", end_at: "2026-05-10T08:25:00Z",
        activity_name: null, distance_m: null, duration_sec: null,
        active_calories: null, steps: null, avg_heart_rate: null,
        raw_key: "k2", uploaded_at: "x",
      },
      {
        id: "c", source: "hc", date: "2026-05-11",
        start_at: "2026-05-11T08:00:00Z", end_at: "2026-05-11T08:30:00Z",
        activity_name: null, distance_m: null, duration_sec: null,
        active_calories: null, steps: null, avg_heart_rate: null,
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
    const j1 = (await r1.json()) as { ok: boolean; ran: number; statements: number };
    expect(j1.ok).toBe(true);
    expect(j1.ran).toBe(j1.statements);
    expect(j1.statements).toBeGreaterThan(0);

    // re-run is safe (IF NOT EXISTS)
    const r2 = await app.request(
      "/_admin/migrate",
      { method: "POST", headers: auth() },
      env,
    );
    expect(r2.status).toBe(200);

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

describe("404", () => {
  it("returns json not_found for unknown route", async () => {
    const r = await app.request("/nope", {}, env);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });
  });
});
