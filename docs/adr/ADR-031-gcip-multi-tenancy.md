# ADR-031: Google Cloud Identity Platform マルチテナント採用

## ステータス
ドラフト（2026-04-21起票、未承認）

## コンテキスト
2026-04-21、外部ドメインユーザー（kanjikai.or.jp）がログインできないインシデントが発生。根本原因はGCP OAuth同意画面の `orgInternalOnly: true` 設定で、279279.net以外のユーザーが認証経路に入れない状態だった。

暫定対応として OAuth 同意画面を External 化した（ADR-030 レイヤー1の変更）が、以下の課題が残る:
- 全世界のGoogleアカウントがFirebase Authにユーザー作成可能となり、「所属テナントなし」の孤児ユーザーが蓄積する
- テナントごとに「許可ドメイン」「IdP」「サインイン方法」を差別化できない
- Firebase Auth（非マルチテナント版）はテナント単位の認証サイロを持たない

マルチテナントLMSとして、**テナントごとに独立した認証設定**を持つ設計が本筋である。

## 決定
Firebase Authentication を Google Cloud Identity Platform（GCIP）のマルチテナントにアップグレードし、各テナントに GCIP Tenant を対応させる。

### フェーズ定義
本ADRで言及する Phase 番号は以下に対応する（インシデント対応 Issue #272 の WBS と同期）:

| Phase | 内容 |
|-------|------|
| 1 | OAuth同意画面 External 化（暫定復旧） |
| 1.7 | 孤児Authユーザー掃除スクリプト雛形（`scripts/cleanup-orphan-auth-users.ts`） |
| 2 | 本ADR + ADR-030 起票（ドラフト） |
| 3 | GCIP移行実装（feature flag + カナリア） |
| 4 | Staging検証・本番ロールアウト |
| 5 | クリーンアップ・運用手順書整備（Cloud Scheduler正式化含む） |

### 移行戦略
1. **Identity Platform アップグレード**: Firebase プロジェクトで Identity Platform を有効化（SDK互換、既存UIDは保持される）
2. **GCIP Tenant の段階的作成**: 既存 Firestore `tenants/{tenantId}` に対応する GCIP Tenant を作成
3. **`tenants` スキーマ拡張**: `gcipTenantId: string | null` フィールド追加（nullableで後方互換）
4. **Feature flag `useGcip: boolean`**: テナント単位で GCIP 経路 / 旧 Firebase Auth 経路を切り替え
5. **FE ログインフロー変更**: `/[tenant]/` ルートでテナント情報を取得 → GCIP Tenant ID (`gcipTenantId`) を `auth.tenantId` にセット → `signInWithPopup`
6. **BE 検証強化**: `verifyIdToken` の戻り値 `decodedToken.firebase.tenant` は **GCIP Tenant ID**（URLパスの `tenantId` ではない）であり、これを Firestore `tenants/{tenantId}.gcipTenantId` と照合してテナント整合性を確認する
7. **カナリア展開**: 1テナントで動作確認 → テナント単位で段階展開 → 全テナント移行
8. **Feature flag 削除と旧経路除去**: 全テナント移行後

### UID保持戦略
- GCIP Tenant ごとにユーザーサイロが分かれるため、新UIDが発行される
- `tenant-auth.ts` の `findOrCreateTenantUser` 関数内の **email ベースフォールバック検索** がテナント単位の DataSource 内で移行時の橋渡しをする:
  - GCIP経由のログインで新UID取得 → テナント内 `users` コレクションを email で検索 → `firebaseUid` フィールドを新UIDに上書き
- 同一メール=同一人物の前提は **Google Workspace の再割当リスク** を考慮し、移行時に以下の追加条件を満たすことを要件化する:
  - `decodedToken.email_verified === true`（検証済みメールのみ）
  - `providerData[].providerId === "google.com"`（Google プロバイダ限定。SAML/OIDC導入時は拡張）
  - 既存ユーザーが suspended 状態でないこと
- **Custom Claims 未使用**のためClaims 再発行問題なし

### ロールバック戦略
- `useGcip: false` にすれば旧経路に戻る（feature flag）、`gcipTenantId` は nullable で残す
- 移行期間中、両経路が同時稼働可能
- **UID 揺り戻しリスク**: GCIP ログイン時に `firebaseUid` を新UIDへ上書きするため、ロールバック後は旧 Firebase Auth UID で再度上書きされる（email fallback で復旧可能だが UID 参照の揺れが発生）
  - 監査ログ上の UID 参照
  - 外部連携（Cloud Logging、BigQuery export、分析ダッシュボード）の UID 参照
  - アクティブセッション（ロールバック時はユーザーに再ログイン要求）
- 上記の影響を許容できるテナント単位でのみ段階的にロールバックを実施する

## 根拠
- **責務分離（ADR-030）**: テナント=認証サイロの1:1対応により、認証レイヤーもマルチテナント化
- **UID保持リスクの低さ**: 影響範囲は `firebaseUid` フィールド1箇所のみ。Custom Claims未使用
- **拡張性**: 将来的にテナントごとのSAML/OIDC連携（大手顧客SSO要件）に対応可能
- **セキュリティ**: テナント単位で Allowed Domains、Sign-in providers、MFA方針を独立設定
- **Codexセカンドオピニオン（2026-04-21）**: 段階移行、feature flag、カナリア展開を推奨

## 影響
### コード変更
- `services/api/src/middleware/tenant-auth.ts`: テナント整合性チェック追加
- `services/api/src/routes/tenants.ts`: 新規テナント作成時に GCIP Tenant 自動作成
- `web/lib/auth-context.tsx`: `auth.tenantId` 設定ロジック追加
- `web/app/[tenant]/page.tsx`: ログイン前のテナント解決
- Firestore `tenants` スキーマ: `gcipTenantId`, `useGcip` フィールド追加

### 運用変更
- GCP コンソールで GCIP Tenant 管理（新規テナント作成・削除手順の更新）
- 週次チェック: 孤児Authユーザー → 本ADRリリースと同時に追加された `scripts/cleanup-orphan-auth-users.ts` を Phase 5 で Cloud Scheduler 経由の定期実行に正式化
  - **既知の制約**: 現状の掃除スクリプトは `getAuth()` のデフォルトインスタンスのみを対象とし、GCIP Tenant 配下のユーザーは対象外。Phase 3 実装時に `tenantManager().authForTenant(gcipTenantId)` 対応を追加する（Phase 5 までの暫定制約）
- 監視: GCIP ログイン成功率・エラー率を Cloud Logging で計測

### 費用影響
- GCIP のマルチテナント機能（Identity Platform Tenants）は **Identity Platform の特定 Tier（Essentials 以上）** で提供される
- 料金体系は公式ドキュメントで常に変動し得るため、**Phase 3 実装着手前に GCP コンソールで現行プランを再確認**すること
- 現状 Firebase Auth は無料枠で運用中。GCIP移行後の費用は Tier とMAU次第で数千円〜数万円/月 の増加が見込まれる可能性があるため、Phase 3 着手前に費用試算を再実施する

### 非対応事項（スコープ外）
- SAML/OIDC連携は将来対応（現状は Google プロバイダのみ）
- パスワード認証は現状どおり非対応
- 匿名認証は非対応

## 参考
- インシデント契機: 2026-04-21 403 org_internal
- Codex セカンドオピニオン（2026-04-21）
- 関連ADR: ADR-005（Firebase Auth）、ADR-006（allowed_emails）、ADR-007（マルチテナント分離）、ADR-030（責務分離）
- Google 公式: [GCIP multi-tenancy](https://cloud.google.com/identity-platform/docs/multi-tenancy)
