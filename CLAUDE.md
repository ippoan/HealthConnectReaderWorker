# CLAUDE.md

`ippoan/HealthConnectReader` (Android) の WebView UI と R2 backed upload
endpoint を host する Cloudflare Worker。

このリポジトリで Claude Code セッションを動かす時の作業ガイド。本ファイルは
[ippoan/claude-md](https://github.com/ippoan/claude-md) の `CLAUDE.md.template`
から派生 — 共通項を直すときは template を更新する。

## まず読むもの

- [`README.md`](./README.md) — endpoint 一覧と運用フロー
- [`src/index.ts`](./src/index.ts) — Hono の route 構成
- [`src/r2.ts`](./src/r2.ts) — key 規約 (`hc/{yyyy}/{mm-dd}.json`) と history 集計
- [`wrangler.jsonc`](./wrangler.jsonc) — single-env (staging = prod) + secrets store binding
- 親 issue: ippoan/HealthConnectReader#6

## ブランチ運用 / Worktree

- 作業は **`main` から切った短命ブランチ**上で行う。命名規則:
  - 推奨形式: `<issue-number>-<type>-<short-description>` (`type ∈ feat|fix|refactor|infra`)
  - Claude Code が自動採番する `claude/<topic>-<sha>` で実装に入った場合は、
    対応 issue を立てた上で上記形式に rename する
- **`main` に直接 push しない。** PR を開く → CI が green になれば
  `frontend-ci.yml` 内蔵の auto-merge job が `gh pr merge --auto --squash` する。
- `git push --force` / `git commit --amend` / `git rebase -i` は `claude-hooks`
  の `git-safe-push.sh` で block されている。

## ビルド / テスト / lint

PR を出す前に手元で全部 green であること:

```sh
npm install
npm run typecheck
npm test
```

## GitHub 自動化

### Auto-merge

`frontend-ci.yml` (call 元) が内蔵 auto-merge job を持つので **workflow 側で
`gh pr merge --auto --squash` が走る**。`mcp__github__enable_pr_auto_merge`
を Claude が **直接** 叩くのは引き続き **user が明示指示した時のみ**。

### Single-env (staging = prod)

`wrangler.jsonc` には root config 1 個だけ。`deploy_staging_script` と
`deploy_release_script` の両方が `npx wrangler deploy` を叩く。PR merge は
staging deploy、tag push (`v*`) は release deploy として動くが、参照する
config は同一 (Refs ippoan/secrets-inventory パターン)。

### Secret 管理

- CF Secrets Store (`bd7bc91a3e5f4111add4acf6cb4b8733`) の
  `hcreader-upload-token` を `UPLOAD_TOKEN` binding で受ける
- GCP Secret Manager (`cloudsql-sv` project) にも同名で backup
- `secret-verify.yml` が PR / push で missing を検出
- `wrangler.jsonc` の `secrets.required` を増減させる時は **CF / GCP 両側に
  同名で投入してから merge** する (secrets-inventory MCP の `create_secret`
  tool が便利)

### PR description / commit message のキーワード

- ❌ 使用禁止: `Closes #N` / `Fixes #N` / `Resolves #N`
- ✅ 使用推奨: `Refs #N` / `Related to #N` / `Part of #N`

### PR 作成後の CI 監視

PR を作成したら同じ turn で `mcp__github__subscribe_pr_activity` を呼んで CI を
watch する。`sleep` / `gh run watch` / 手動 polling は禁止 — webhook で起こされる
前提でそのターンは終了する。

## 実装上の注意

### Bearer auth

`src/auth.ts` の `bearerAuth` middleware は `UPLOAD_TOKEN` (secrets store binding)
を timing-safe compare する。token 未設定なら 500 を返す (= deploy 漏れを fail-loud
にする)。

### R2 key 規約

- `hc/{yyyy}/{mm-dd}.json` 固定 (`src/r2.ts` の `uploadKeyFor`)
- 1 日 1 ファイル前提なので、同日複数 upload で上書きされる仕様
- 履歴集計はファイル名から日付を parse (ファイル中身は読まない) — 大量データでも
  R2 list だけで `{ count, latest }` を返せる

### WebView 側 contract

`src/ui.ts` の HTML は native の `window.HC` JsInterface に依存:

- `HC.readToday(): string` — Health Connect 読取結果の JSON 文字列
- `HC.getUploadToken(): string` — Bearer header 用
- `HC.scheduleDailyUpload()` / `HC.cancelDailyUpload()` — WorkManager 操作
- `HC.isDailyUploadScheduled(): boolean`

native (`ippoan/HealthConnectReader`) 側の `HCBridge.kt` と同期して維持する。

## やってはいけないこと

- **`main` に直 push しない**
- **force push / amend / rebase -i しない**
- **`secrets_store_secrets` の binding 名と `secrets.required` を不一致にしない**
  — secret-verify が誤検知 / 見逃しする
- **CI を green にするためだけのテスト無効化 / skip flag を入れない** — root cause
  を直す

---

_このファイルは [`ippoan/claude-md`](https://github.com/ippoan/claude-md) の
`CLAUDE.md.template` から派生したもの。共通部分の変更は template 側に PR を出すこと。_
