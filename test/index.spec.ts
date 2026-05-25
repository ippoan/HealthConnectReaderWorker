import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import { summarizeHistory, uploadKeyFor } from "../src/r2";

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
  it("returns HTML with the upload button", async () => {
    const r = await app.request("/", {}, env);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(await r.text()).toContain("今すぐ Upload");
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

  it("counts and surfaces latest after uploads", async () => {
    await env.R2.put("hc/2026/05/05-20.json", "{}"); // wrong layout, ignored
    await env.R2.put("hc/2026/05-20.json", "{}");
    await env.R2.put("hc/2026/05-22.json", "{}");
    await env.R2.put("hc/2025/12-31.json", "{}");
    const r = await app.request(
      "/api/history",
      { headers: auth() },
      env,
    );
    expect(r.status).toBe(200);
    const j = (await r.json()) as { count: number; latest: string | null };
    expect(j.count).toBeGreaterThanOrEqual(3);
    expect(j.latest).toBe("2026-05-22");
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
  it("returns { count: 0, latest: null } on empty bucket", async () => {
    // Use a fresh-ish view: list existing then drop is overkill — instead
    // assert against a derived empty case via the function directly with a
    // miniflare-style stub would need its own bucket. We instead just check
    // that latest stays null when no matching keys exist.
    const fakeBucket: R2Bucket = {
      list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }) as never,
    } as unknown as R2Bucket;
    const out = await summarizeHistory(fakeBucket);
    expect(out).toEqual({ count: 0, latest: null });
  });
});

describe("404", () => {
  it("returns json not_found for unknown route", async () => {
    const r = await app.request("/nope", {}, env);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });
  });
});
