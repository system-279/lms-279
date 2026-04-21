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

### 移行戦略
1. **Identity Platform アップグレード**: Firebase プロジェクトで Identity Platform を有効化（SDK互換、既存UIDは保持される）
2. **GCIP Tenant の段階的作成**: 既存 Firestore `tenants/{tenantId}` に対応する GCIP Tenant を作成
3. **`tenants` スキーマ拡張**: `gcipTenantId: string | null` フィールド追加（nullableで後方互換）
4. **Feature flag `useGcip: boolean`**: テナント単位で GCIP 経路 / 旧 Firebase Auth 経路を切り替え
5. **FE ログインフロー変更**: `/[tenant]/` ルートでテナント情報を取得 → `auth.tenantId = gcipTenantId` をセット → `signInWithPopup`
6. **BE 検証強化**: `verifyIdToken` で `decodedToken.firebase.tenant` と URL パスの一致を確認
7. **カナリア展開**: 1テナントで動作確認 → テナント単位で段階展開 → 全テナント移行
8. **Feature flag 削除と旧経路除去**: 全テナント移行後

### UID保持戦略
- GCIP Tenant ごとにユーザーサイロが分かれるため、新UIDが発行される
- 既存の `email` ベースフォールバック検索（`tenant-auth.ts:158-167`）が移行時の橋渡しをする:
  - GCIP経由のログインで新UID取得 → email でFirestore検索 → firebaseUid フィールドを新UIDに更新
- 既存の `firebaseUid` は更新される（同一メール=同一人物の前提）
- **Custom Claims 未使用**のためClaims 再発行問題なし

### ロールバック戦略
- `useGcip: false` にすれば即座に旧経路に戻る（feature flag）
- `gcipTenantId` は nullable で残す
- 移行期間中、両経路が同時稼働可能

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
- 週次チェック: 孤児Authユーザー → Phase 1.7 のクリーンアップスクリプトを Phase 5 で正式化
- 監視: GCIP ログイン成功率・エラー率を Cloud Logging で計測

### 費用影響
- GCIP の月額 MAU 課金（50,000 MAU まで無料、それ以上 $0.01/MAU 程度）
- 現状 Firebase Auth は無料枠で運用中。GCIP移行後も当面は無料枠内と想定

### 非対応事項（スコープ外）
- SAML/OIDC連携は将来対応（現状は Google プロバイダのみ）
- パスワード認証は現状どおり非対応
- 匿名認証は非対応

## 参考
- インシデント契機: 2026-04-21 403 org_internal
- Codex セカンドオピニオン（2026-04-21）
- 関連ADR: ADR-005（Firebase Auth）、ADR-006（allowed_emails）、ADR-007（マルチテナント分離）、ADR-030（責務分離）
- Google 公式: [GCIP multi-tenancy](https://cloud.google.com/identity-platform/docs/multi-tenancy)
