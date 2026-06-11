---
name: HealthConnectReaderWorker-map
generated-from: HealthConnectReaderWorker:343a532d3737032c0957d6b20104fde0f44e0ee6
paths: [src/]
description: ippoan/HealthConnectReaderWorker (Cloudflare Workers + Hono の健康データ収集 backend + PWA UI) の構造ナビゲーション。R2 raw 保存 / D1 突合インデックス / HC・Zones・manual・ghapi の 4 source 統合 / Google Health API webhook (DO) の配置と gotcha を 1 枚にまとめる。トリガー:「HealthConnectReaderWorker」「hcreader」「upload-batch」「workouts 突合」「Zones」「ghapi」「Google Health」「R2 merge」「_admin/migrate」「reindex」「pairing」等。
---

# HealthConnectReaderWorker-map — ippoan/HealthConnectReaderWorker 構造ナビゲーション

Android アプリ `ippoan/HealthConnectReader` の WebView UI と R2 backed upload
endpoint を host する単一 Worker (Hono)。`src/index.ts` 1 ファイルに全 route が並ぶ。

> 細部 (正確な行・JsInterface contract) は repo 側が正。ここは「どこを見るか」の索引。
> frontmatter の `generated-from` が現在の tree-sha とズレたら
> session-start-skill-coverage hook が再生成を促す。

## 区画 (src/ ファイル)

| ファイル | 役割 |
|---|---|
| `index.ts` | Hono 全 route (UI / upload / workouts / pair / manual / ghapi)。merge/index ロジックも内包 |
| `db.ts` | D1 `workouts` の upsert / list / 突合 (`groupAndMatch` / `loadPairSets` / `hcPayloadToRows` 等) |
| `r2.ts` | R2 key 規約 (`hc/{yyyy}/{mm-dd}.json` 等) と history 集計。`uploadKeyFor` / `zonesKeyFor` / `manualKeyFor` |
| `migrations.ts` | `SCHEMA_STATEMENTS` (D1 schema の source of truth) + `applySchema` |
| `auth.ts` | `apiAuth` / `bearerAuth` (UPLOAD_TOKEN timing-safe) + `verifyAuthCookie` (auth-worker JWT) |
| `ghapi.ts` / `ghapi-ingest.ts` | Google Health API client + 取込 (`hrSeriesKey` 等) |
| `durable_objects/ghapi-subscriber-do.ts` | `GhapiSubscriberDO` — per-user の refresh_token / subscription / health_user_id |
| `jwt.ts` `env.ts` `ui.ts` | JWT 検証 / binding reader / 埋め込み HTML (PWA shell + 各 detail ページ) |

## entrypoint (`src/index.ts` の主要 route)

- **UI (auth 3 経路: Bearer UPLOAD_TOKEN / auth-worker JWT cookie / 302 redirect)**: `GET /` `/workout` `/manual` `/ghapi/workout`、`/manifest.json` `/sw.js` `/favicon.ico`
- **HC upload**: `POST /api/upload` (today snapshot、`?force` で replace) / `POST /api/upload-batch` (incremental backfill + R2 merge) / `POST /api/upload-zones` (iOS Apple Watch)
- **読取/突合**: `GET /api/history` `/api/zones` `/api/workouts?days=N` `/api/workout?hc=&zones=` `/api/known-hc-ids` (diff upload 用)
- **manual workout**: `POST /api/manual` `/api/manual/delete`、`GET /api/manual`
- **pairing (手動突合)**: `POST /api/pair` `/api/pair/delete`
- **ghapi (Google Health)**: `GET /ghapi/connect` `/api/ghapi/connected` `/api/ghapi/status` `/api/ghapi/workout`、`POST /api/ghapi/store-tokens` (auth-worker→ここ、INTERNAL_SHARED_SECRET) `/api/ghapi/webhook` (Google→ここ、204 即返し + waitUntil で DO) `/api/ghapi/backfill` `/api/ghapi/disconnect`
- **admin**: `POST /_admin/migrate` (`applySchema` 適用) / `POST /_admin/reindex?prefix=` (R2 全件 → D1 再 index、idempotent)
- **export**: `default app` + `export { GhapiSubscriberDO }`

## gotcha (CLAUDE.md / wrangler.jsonc 由来)

- **single-env (staging = prod)**: `wrangler.jsonc` は root config 1 個のみ。custom domain `hcreader.ippoan.org`、`workers_dev: false`。PR merge も tag push も同じ `npx wrangler deploy`。
- **D1 schema は `src/migrations.ts` がSoT**。`wrangler d1 migrations apply` は使わず `POST /_admin/migrate` から適用 (CI token に D1:Edit 不要)。すべて `IF NOT EXISTS` で idempotent。
- **R2 は二重持ち**: raw JSON を R2 に、突合用メタを D1 `workouts` に。D1 が飛んでも `_admin/reindex` で R2 から再生できる。
- **JST date 罠**: `/api/upload` は payload の `date` (Android が JST で生成) を優先して key 決定。Worker の `new Date()` は UTC なので当日が前日 key に merge される事故を回避 (Refs #48)。
- **D1 への upsert は逐次 await** (workerd 上の row drop race 回避)。R2 GET は map 内で body 消費まで完了 (stalled HTTP response cancel 回避)。
- **secret は CF Secrets Store (`bd7bc91a...`) binding 経由**。`secrets.required` は**わざと書かない** (wrangler 4.79+ が secrets_store binding 名と衝突して deploy 落ちるため)。GCP Secret Manager にも同名 backup、`secret-verify-gcp.yml` が突合。
- **`INTERNAL_SHARED_SECRET` は auth-worker と共有値**。`/api/ghapi/store-tokens` の Bearer 検証用。Google Health 用 OAuth は **auth-staging** に redirect 固定 (Google Console 登録の経緯)。

## CCoW / CI から見た立ち位置

- consumer は Android アプリ (WebView) と PWA ブラウザ。auth は auth-worker (`auth.ippoan.org` login / cookie) に委譲。
- ghapi は auth-worker (`auth-staging.ippoan.org`) の Google Health OAuth と連携 (token を `/api/ghapi/store-tokens` で受領)。
- CI は `frontend-ci.yml` (worker)、TAGLESS_REPOS 掲載 → ci-dashboard が PR merge を mini-release 扱い。

## 関連

- `auth-worker-map` — login / JWT cookie / ghapi OAuth の発行元
- `secret-inject` — UPLOAD_TOKEN 等の no-leak 投入
- `wrangler-logs` / `worker-vitest` — ログ調査 / テスト
