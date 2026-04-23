# Runbook: 外部ドメインユーザー受け入れ前のテナント / allowed_emails 事前確認

Issue #272 緊急復旧トラックの R2-R4 作業手順書。OAuth External 化（[oauth-external-publish.md](./oauth-external-publish.md)）を実施しても、テナントが存在しない / `allowed_emails` が未登録の場合はアプリ側で `403 tenant_access_denied` で止まるため、OAuth 設定と並行してデータ整備を行う。

## 前提

- **権限**: super-admin（`SUPER_ADMIN_EMAILS` 登録済み）でログイン済み、または Firestore への直接読み書き権限（`roles/datastore.user` 相当）
- **環境変数**（CLI 実行する場合）:
  - `GOOGLE_APPLICATION_CREDENTIALS`: 本番サービスアカウント JSON パス
  - `FIREBASE_PROJECT_ID=lms-279`
- **email 正規化**: 本システムの `allowed_emails` は `.trim().toLowerCase()` 正規化後の値で保存される（PR #277 で統一）
- **`(tenantId, email)` 唯一性**: 認可単位は tenant とペア。同一 email が別テナントに存在しても可（ADR-031）

## 作業ステップ

### 1. テナント存在確認

対象テナント（例: `kanjikai`）が Firestore `tenants` コレクションに存在するか確認する。

#### 1-A. super-admin UI で確認（推奨）

1. 本番環境に super-admin 権限でログイン
2. `/super-admin/tenants` で一覧を開く
3. 対象テナント名 / ID が存在するか確認

#### 1-B. gcloud CLI で確認（UI 不可時）

```bash
gcloud firestore documents get \
  --project=lms-279 \
  "tenants/kanjikai"
```

確認観点:
- ドキュメントが存在する
- `status` が `"active"`（`"suspended"` では `tenant_access_denied` になる）
- `useGcip` が `false` または未設定（GCIP 未移行の現状は `false` / null が正常）
- `gcipTenantId` が `null`（同上）

### 2. allowed_emails 登録確認

対象 email（例: `sayori-maeda@kanjikai.or.jp`）が正規化後の値で登録されているか確認する。

#### 2-A. tenant admin UI で確認（推奨）

1. 対象テナントの admin として `/[tenantId]/admin/allowed-emails` を開く
2. 一覧に対象 email が表示されるか確認
3. 入力したメールと表示されているメールが大文字小文字も含めて完全一致していることを確認（正規化漏れの検知）

#### 2-B. gcloud CLI で確認（UI 不可時）

```bash
# 正規化後の email を doc ID として問い合わせ
NORMALIZED_EMAIL=$(echo "sayori-maeda@kanjikai.or.jp" | tr '[:upper:]' '[:lower:]' | xargs)
gcloud firestore documents get \
  --project=lms-279 \
  "tenants/kanjikai/allowed_emails/${NORMALIZED_EMAIL}"
```

> 備考: allowed_emails の doc ID に email を使っていない実装の場合は、コレクション全スキャンが必要。`scripts/audit-users-vs-allowed-emails.ts --tenant-id=kanjikai --dry-run` でも確認可能。

### 3. 未登録時の作成手順

#### 3-A. テナント未作成 → super-admin API で作成

`name` と `ownerEmail` のみで tenant 作成可能。`ownerEmail` は正規化後に allowed_emails に自動登録される（既存実装のオーナー初期化フロー、要実装確認）。

```bash
curl -X POST \
  -H "Authorization: Bearer $SUPER_ADMIN_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Kanjikai",
    "ownerEmail": "sayori-maeda@kanjikai.or.jp"
  }' \
  "https://<本番 URL>/api/v2/super-admin/tenants"
```

レスポンスで返される `tenantId` を記録。ランダム生成のため固定できない。

#### 3-B. テナント既存・allowed_emails のみ未登録 → tenant admin API で追加

```bash
curl -X POST \
  -H "Authorization: Bearer $TENANT_ADMIN_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "sayori-maeda@kanjikai.or.jp",
    "role": "student"
  }' \
  "https://<本番 URL>/api/v2/<tenantId>/admin/allowed-emails"
```

role は対象の運用実態に合わせて `admin` / `teacher` / `student` から選択。

### 4. 登録後の確認

- Cloud Logging で構造化ログを確認（allowed_emails 追加のログイベントが記録される）
- Firestore で再度 §1-§2 の手順で整合性を確認
- `note` / `memo` 系フィールドがある場合は `Issue #272 緊急対応` を記載

## OAuth 作業との依存関係

```
[R2 テナント確認] → [R4 作成 (必要時)] ─┐
                                         ├→ [R8 sayori-maeda 再ログイン]
[R3 allowed_emails 確認] → [R4 登録] ─┘    ↑
                                            │
[R5 OAuth External化] → [R6 Publish] ──────┘
```

本 runbook（R2/R3/R4）と [oauth-external-publish.md](./oauth-external-publish.md)（R5/R6）は **並行実行可能**。別の担当者で同時進行して所要時間を短縮できる。

## トラブルシュート

| 症状 | 原因候補 | 対処 |
|------|---------|------|
| `tenant_access_denied` | tenant は存在するが status が `suspended` / `allowed_emails` 未登録 | §1-§2 で確認、必要に応じて §3 |
| `email_verification_required` | Google アカウント側で email 未検証 | 利用者にアカウント検証を依頼（PR #288 チェック） |
| `provider_not_allowed` | sign_in_provider != `google.com`（例: パスワード認証） | Google ログインを使うよう案内（PR #288 チェック） |
| `uid_reassignment_blocked` | 既存 users に同 email で別 UID が存在 | Cloud Logging で該当 user の UID を調査、手動マージが必要 |
| 登録直後でも拒否される | `allowed_emails` リアルタイム再チェックは有効（PR #284）だがキャッシュ等ではなく、リクエスト毎に Firestore 照会のため即時反映される。反映されない場合は email 正規化差分を疑う | 大文字小文字・前後空白を確認、必要なら `scripts/normalize-allowed-emails.ts --tenant=<id> --dry-run` |

## 関連

- ADR-030: 認証/認可/テナント解決/Workspace 連携の責務分離
- ADR-031: GCIP マルチテナント採用（本 runbook は Phase 1 暫定復旧、Phase 3 移行後も手順は類似）
- Issue #272: 外部ドメインユーザーログイン不可の恒久対応
- PR #277: allowed_emails 削除時セッション即時失効 + email 正規化統一
- PR #284: allowed_emails 継続的認可境界（リアルタイム再チェック）
- PR #288: email_verified / sign_in_provider 必須チェック
- PR #318: findOrCreateTenantUser UID 原子化
- scripts/audit-users-vs-allowed-emails.ts: 棚卸し
- scripts/normalize-allowed-emails.ts: email 正規化
