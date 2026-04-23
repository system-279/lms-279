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

`name` と `ownerEmail` のみで tenant 作成可能。以下が **同一トランザクション内で一括作成** される（`services/api/src/routes/super-admin.ts` L263-310）:

- `tenants/{tenantId}` ドキュメント（`status: "active"` / `gcipTenantId: null` / `useGcip: false` が固定で入る）
- `tenants/{tenantId}/allowed_emails/{autoId}` に正規化後の `ownerEmail` を登録（`note: "オーナー（スーパー管理者が登録）"` 固定、後から追記したい場合は Firestore 直編集か §3-B で別途追加登録）
- `ownerEmail` が **既存 Firebase Auth ユーザー** の場合は `tenants/{tenantId}/users/{autoId}` に `role: "admin"` で初期管理者レコードも同時作成される。未登録の場合は初回ログイン時に自動作成される

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

レスポンスで返される `tenantId` を記録（ランダム生成のため固定不可）。このフローで allowed_emails にもオーナーが自動登録されるため、§3-B の追加登録は不要。

#### 3-B. テナント既存・allowed_emails のみ未登録 → tenant admin API で追加

`POST /admin/allowed-emails` は `{ email, note }` のみ受け付ける（`services/api/src/routes/shared/allowed-emails.ts` L45-74）。role は **この endpoint では扱わない**。

```bash
curl -X POST \
  -H "Authorization: Bearer $TENANT_ADMIN_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "sayori-maeda@kanjikai.or.jp",
    "note": "Issue #272 緊急対応 (2026-04-23)"
  }' \
  "https://<本番 URL>/api/v2/<tenantId>/admin/allowed-emails"
```

- `note` は optional（省略時は null）
- 既に登録済みなら **409 `email_exists`** が返る（冪等的に扱える）
- 正規化（`.trim().toLowerCase()`）は API 内で適用されるため、入力大文字小文字は気にしなくてよい
- **role は `users` ドキュメント側で管理**。初回ログイン時に `tenants/{tenantId}/users/{autoId}` が自動生成され、以降は tenant admin UI で role（`admin` / `teacher` / `student`）を変更可能

### 4. 登録後の確認

- Cloud Logging で構造化ログを確認（`Tenant created by super admin` 等のログが記録される）
- Firestore で再度 §1-§2 の手順で整合性を確認
- §3-A で tenant 作成した場合、オーナー email の `note` は固定値（`"オーナー（スーパー管理者が登録）"`）で保存される。Issue 追跡用の `note` を付けたい場合は §3-B で追加登録時に指定するか、Firestore 直編集で追記

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
