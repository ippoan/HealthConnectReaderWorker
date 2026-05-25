# healthconnectreader-worker

`ippoan/HealthConnectReader` (Android) の WebView UI を host する Cloudflare
Worker。Android native が Health Connect から読んだ JSON を `POST /api/upload`
で受け、R2 (`hcreader-data`) に `hc/{yyyy}/{mm-dd}.json` で保存する。

Refs ippoan/HealthConnectReader#6

## Endpoints

| Method | Path                 | Auth              | 役割                                                       |
| ------ | -------------------- | ----------------- | ---------------------------------------------------------- |
| GET    | `/`                  | Bearer **or** auth-worker JWT cookie | Tailwind ベースの WebView / PWA UI (Upload / 自動 / 履歴 / Zones)。未認証は `auth.ippoan.org` に 302 |
| GET    | `/manifest.json`     | none              | Web App Manifest (iOS Safari でホーム画面追加 → standalone PWA) |
| GET    | `/sw.js`             | none              | 最小 Service Worker (PWA install 条件のスタブ)             |
| GET    | `/health`            | none              | liveness probe                                             |
| POST   | `/api/upload`        | Bearer **or** cookie | request body の JSON を R2 に PUT (`hc/yyyy/mm-dd.json`)   |
| POST   | `/api/upload-batch`  | Bearer **or** cookie | `{days:[{date,payload}]}` を 1 リクエストで N 日分投入     |
| POST   | `/api/upload-zones`  | Bearer **or** cookie | iOS Zones (Apple Watch) workout JSON 1 件を R2 (`zones/yyyy/mm-dd/{uuid}.json`) + D1 `workouts` に並列保存 |
| GET    | `/api/history`       | Bearer **or** cookie | R2 `hc/` listing → `{ count, latest }` を返す              |
| GET    | `/api/zones`         | Bearer **or** cookie | D1 `workouts` (source='zones') を `uploaded_at` desc で → `{ count, items: [{date, uuid, key, uploaded}] }` |
| POST   | `/_admin/migrate`    | Bearer **or** cookie | `src/migrations.ts` の `SCHEMA_STATEMENTS` を D1 に idempotent 適用 |
| GET    | `/favicon.ico`       | none              | 単色 16x16 ICO (404 抑止)                                  |

## 認証

3 経路を受け付ける (`/`, `/api/*`, `/_admin/*` 共通):

1. **`Authorization: Bearer ${UPLOAD_TOKEN}`** — Android WebView (header inject) / iOS ショートカット / CI / curl
2. **auth-worker JWT cookie** (`logi_auth_token`, `Domain=.ippoan.org`) — PWA / ブラウザ
   - cookie の `email` claim が `src/env.ts::ALLOWED_EMAILS` に含まれること
   - JWT は `JWT_SECRET` (Workers secret、auth-worker と物理共有) で HS256 検証
3. `/` のみ: どちらも無ければ `https://auth.ippoan.org/oauth/google/redirect?redirect_uri=https://hcreader.ippoan.org/` に 302
   - auth-worker でログイン後、cookie が `.ippoan.org` で発行され自動で hcreader に乗る

### 必要な user 操作 (1 回だけ)

```sh
# 1. JWT_SECRET を hcreader-worker に投入 (auth-worker と同じ値)
npx wrangler secret put JWT_SECRET

# 2. auth-worker KV `origins:prod` に hcreader を追加
cd ../auth-worker
CURRENT=$(npx wrangler kv:key get --binding=AUTH_CONFIG --remote "origins:prod")
npx wrangler kv:key put --binding=AUTH_CONFIG --remote "origins:prod" "${CURRENT},https://hcreader.ippoan.org"
```

`JWT_SECRET` 未設定でも Bearer 認証は引き続き動く (= cookie 経路が無効化されるだけ)。

## D1 schema 適用フロー

`wrangler d1 migrations apply` は **使わない**。CI token に D1:Edit を足さずに済むよう、
Worker 自身が DB binding 経由で schema を流す方式にしてある。

**自動化済**: `.github/workflows/migrate.yml` が `workflow_run` で CI 完走を検知 →
`POST /_admin/migrate` を `HCREADER_RELEASE_UPLOAD_TOKEN` 付きで叩く。
schema 変更時は `src/migrations.ts` の `SCHEMA_STATEMENTS` 末尾に `ALTER TABLE` 等を
追記して PR → merge するだけで自動で本番 D1 に反映される (すべて `IF NOT EXISTS` で書く)。

手元から手動で流したい時:

```sh
curl -X POST https://hcreader.ippoan.org/_admin/migrate \
  -H "Authorization: Bearer $UPLOAD_TOKEN"
# → { "ok": true, "ran": 4, "statements": 4 }
```

または GitHub Actions の `D1 Migrate` workflow を `workflow_dispatch` で手動 trigger。

### D1 `workouts` テーブル (突合用 metadata index)

HC (Android Health Connect) と Zones (iOS Apple Watch) 双方の workout 要約を 1 テーブルで保持し、
時刻 overlap での JOIN で「同じ workout の HC 距離 + Zones 心拍 zone」を 1 グラフ化する用途。
生 JSON は引き続き R2 に保存 (`raw_key` がその pointer)。

```
workouts(
  PRIMARY KEY (source, id),
  source TEXT,          -- 'hc' | 'zones'
  date TEXT,            -- YYYY-MM-DD (UTC)
  start_at, end_at,     -- ISO 8601 UTC
  activity_name,
  distance_m, duration_sec, active_calories,
  steps, avg_heart_rate,
  raw_key, uploaded_at
)
```

突合クエリ例 (Phase 3 で endpoint 化予定):

```sql
-- 同日かつ時刻区間が overlap する HC と Zones を結合
SELECT h.start_at, h.distance_m, z.avg_heart_rate
FROM workouts h JOIN workouts z
  ON h.source='hc' AND z.source='zones'
 AND h.start_at < z.end_at AND z.start_at < h.end_at;
```

`${TOKEN}` は CF Secrets Store の `hcreader-upload-token` (binding 名
`UPLOAD_TOKEN`)。GCP Secret Manager にも同名で backup されており、
`.github/workflows/secret-verify.yml` で CI 検証される。

## iPhone (Apple Watch) からの取り込み

Android の Health Connect には iOS のデータは流れないため、iPhone 側は
**Zones アプリの JSON export → `/api/upload-zones`** という経路を取る。
2 つの渡し方が選べる。

### A. PWA 経由 (Safari でホーム画面追加)

1. iOS Safari で `https://hcreader.ippoan.org/` を開く
2. 共有ボタン → 「ホーム画面に追加」 → standalone アプリ化
   (※ iOS Chrome ではただのブックマーク扱いになり standalone にならないので Safari を使う)
3. 初回起動時に "Upload token" 欄に `UPLOAD_TOKEN` を貼る (localStorage 保存)
4. Zones アプリ → workout → 共有 → 「ファイル」に保存
5. PWA に戻り「Zones JSON を選択」 → 保存した JSON を選び「Zones JSON を送信」

### B. iOS ショートカット経由 (タップ 2 回)

PWA を経由せず Zones の共有シートから直接 endpoint を叩く。
**iOS Safari は Web Share Target API 未対応**のため、共有シートから PWA に
直接渡す方法は無い → ショートカットが最短ルート。

ショートカット定義 (iPhone で 1 回作る):

```
[アクション 1] URLの内容を取得 (Get Contents of URL)
   URL:           https://hcreader.ippoan.org/api/upload-zones
   メソッド:      POST
   ヘッダ:        Authorization = Bearer <UPLOAD_TOKEN>
   本文を要求:    ファイル
   ファイル:      ショートカットの入力
[アクション 2] (任意) 通知を表示 — "URL の内容を取得" の結果

[ⓘ 詳細]
   共有シートで表示:   ON
   受け入れる項目:     ファイルのみ ON (他は OFF)
```

保存後、Zones の workout → 共有 → 「その他のアクション」一覧から作成した
ショートカットを ON にすると、共有シートのアクション欄から 1 タップで送信できる。

> Token はショートカット定義に直書きされ iCloud リンクで共有すると漏洩するため、
> リンク共有はせず手元で作成すること。

## Run / Deploy

```sh
npm install
npm run dev            # wrangler dev (local, miniflare R2)
npm test               # vitest (workerd pool + in-mem R2)
npm run typecheck

npx wrangler deploy    # single-env (staging = prod)
```

R2 bucket は事前に作成しておく:

```sh
npx wrangler r2 bucket create hcreader-data
```

Secret は CF Secrets Store に投入後、wrangler が binding 解決する:

```sh
# 例: secrets-inventory MCP で投入する場合
# rotate_secret / create_secret tool 経由
```

## CI

- `test.yml` → `ippoan/ci-workflows/.github/workflows/frontend-ci.yml@main`
  (single-env、PR merge / tag push どちらも root `wrangler deploy`)
- `secret-verify.yml` → `ippoan/ci-workflows/.github/workflows/secret-verify-gcp.yml@main`
  (GCP Secret Manager に `hcreader-upload-token` が存在するか検証)

## Branch / PR

- 作業 branch は `main` から短命に切る (例 `claude/<topic>-<sha>`)
- PR description / commit message では `Refs #N` を使う
  (`Closes` / `Fixes` は auto-close 衝突のため禁止)
