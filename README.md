# healthconnectreader-worker

`ippoan/HealthConnectReader` (Android) の WebView UI を host する Cloudflare
Worker。Android native が Health Connect から読んだ JSON を `POST /api/upload`
で受け、R2 (`hcreader-data`) に `hc/{yyyy}/{mm-dd}.json` で保存する。

Refs ippoan/HealthConnectReader#6

## Endpoints

| Method | Path                 | Auth              | 役割                                                       |
| ------ | -------------------- | ----------------- | ---------------------------------------------------------- |
| GET    | `/`                  | none              | Tailwind ベースの WebView / PWA UI (Upload / 自動 / 履歴 / Zones) |
| GET    | `/manifest.json`     | none              | Web App Manifest (iOS Safari でホーム画面追加 → standalone PWA) |
| GET    | `/sw.js`             | none              | 最小 Service Worker (PWA install 条件のスタブ)             |
| GET    | `/health`            | none              | liveness probe                                             |
| POST   | `/api/upload`        | `Bearer ${TOKEN}` | request body の JSON を R2 に PUT (`hc/yyyy/mm-dd.json`)   |
| POST   | `/api/upload-batch`  | `Bearer ${TOKEN}` | `{days:[{date,payload}]}` を 1 リクエストで N 日分投入     |
| POST   | `/api/upload-zones`  | `Bearer ${TOKEN}` | iOS Zones (Apple Watch) workout JSON 1 件を `zones/yyyy/mm-dd/{uuid}.json` に保存 |
| GET    | `/api/history`       | `Bearer ${TOKEN}` | R2 listing → `{ count, latest }` を返す                    |

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
