# Runbook: 本番 AUTH_MODE=firebase 確認手順

Issue #290 で導入した起動時 fail-safe の運用手順。**本番 runtime** と判定され、かつ `AUTH_MODE !== "firebase"` の状態で API サービスがロードされると、`services/api/src/middleware/tenant-auth.ts` と `services/api/src/middleware/super-admin.ts` がモジュールトップレベルで `Error` を throw し、Cloud Run インスタンスは起動失敗する。

### 本番 runtime 判定 (Issue #290 codex 指摘反映)

以下のいずれかを満たすと「本番」と判定される（defense-in-depth）:

1. `NODE_ENV` を trim + lowercase で正規化した値が `"production"`
2. `K_SERVICE` 環境変数が設定されている（Cloud Run が自動注入。[Container Contract](https://cloud.google.com/run/docs/container-contract#services-env-vars) 参照）

→ deploy.yml で `NODE_ENV=production` を明示し忘れても、Cloud Run 上では `K_SERVICE` で自動検知される。

## なぜこの fail-safe が必要か

`AUTH_MODE` のデフォルト値は `"dev"`（ヘッダ疑似認証: `X-User-Email` を無検証で信頼）。本番環境で環境変数の設定漏れ / IaC ドリフト / Cloud Run リビジョン切り戻しなどで `AUTH_MODE` が欠落すると、`email_verified` / `sign_in_provider` / `allowed_emails` 境界（ADR-031 Issue #286 / #294）が**全てバイパス**され、誰でも任意の email で認証可能になる。

この事故を防ぐため、モジュールロード時に fail-fast で検知する。

## 本番デプロイ前チェックリスト

### 1. Cloud Run 環境変数の確認

```bash
gcloud run services describe api \
  --region asia-northeast1 \
  --format='value(spec.template.spec.containers[0].env)' \
  | grep -E "AUTH_MODE|NODE_ENV"
```

期待値:
- `AUTH_MODE=firebase`
- `NODE_ENV=production`

### 2. IaC 設定との一致確認

`cloudbuild.yaml` / `deploy/cloud-run-*.yaml` / Terraform 等で `AUTH_MODE=firebase` が明示されているか確認。**デフォルト依存は禁止**（設定漏れで dev にフォールバックすると fail-safe が発火し起動失敗するため、明示設定が必須）。

### 3. リビジョン切り戻し時の注意

Cloud Run の UI / gcloud で旧リビジョンにロールバックした際、そのリビジョンに `AUTH_MODE=firebase` が設定されていなかった場合は起動失敗する。リビジョン作成時点で必ず `AUTH_MODE=firebase` を明示していること。

## 起動失敗時の挙動

`Error: FATAL: AUTH_MODE must be "firebase" in production (got "dev"). ...` がログに出力され、Cloud Run インスタンスは ready にならない。トラフィックは直前の正常リビジョンに維持されるため、サービス停止は発生しない（新規リビジョン作成が失敗する）。

## 復旧手順

1. Cloud Run のリビジョン設定で `AUTH_MODE=firebase` を追加して新リビジョンをデプロイ
2. 新リビジョンが healthy 100% になったことを確認
3. 旧（失敗）リビジョンを削除

## 開発環境

`NODE_ENV` が `"production"` **以外**（`"development"`, `"test"`, 未設定など）の場合、この fail-safe は発動しない。ローカル / CI / staging では従来通り `AUTH_MODE=dev` で起動可能。

## 関連

- ADR-031（認証・認可・テナント解決の責務分離 + GCIP マルチテナント）
- Issue #286 / PR #288（email_verified / sign_in_provider 必須化）
- Issue #289 / PR #291（super-admin 経路への同等ガード）
- Issue #294 / PR #301（help-role.ts / tenants.ts への境界統一）
- Issue #290（本 runbook の元 Issue、起動時 assertion）
