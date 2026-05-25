# healthconnectreader-worker

`ippoan/HealthConnectReader` (Android) の WebView UI を host する Cloudflare
Worker。Android native が Health Connect から読んだ JSON を `POST /api/upload`
で受け、R2 (`hcreader-data`) に `hc/{yyyy}/{mm-dd}.json` で保存する。

Refs ippoan/HealthConnectReader#6

## Endpoints

| Method | Path           | Auth              | 役割                                                  |
| ------ | -------------- | ----------------- | ----------------------------------------------------- |
| GET    | `/`            | none              | Tailwind ベースの WebView UI (Upload / 自動 / 履歴)   |
| GET    | `/health`      | none              | liveness probe                                        |
| POST   | `/api/upload`  | `Bearer ${TOKEN}` | request body の JSON を R2 に PUT (`hc/yyyy/mm-dd.json`) |
| GET    | `/api/history` | `Bearer ${TOKEN}` | R2 listing → `{ count, latest }` を返す               |

`${TOKEN}` は CF Secrets Store の `hcreader-upload-token` (binding 名
`UPLOAD_TOKEN`)。GCP Secret Manager にも同名で backup されており、
`.github/workflows/secret-verify.yml` で CI 検証される。

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
