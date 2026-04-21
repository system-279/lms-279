# ADR-030: 認証・認可・テナント解決・Workspace連携の責務分離

## ステータス
ドラフト（2026-04-21起票、未承認）

## コンテキスト
現状、Firebase Authenticationを「認証」として利用し、Firestoreの `allowed_emails` を「認可」として利用している。また、Google Workspace DWD（Drive/Docs連携、ADR-026）も同じGCPプロジェクト内で稼働しており、責務の境界が暗黙的になっている。

2026-04-21のインシデント（外部ドメインユーザーのログイン不可、エラー403 org_internal）を契機に、以下の課題が顕在化した:
- OAuth同意画面（Internal設定）が「認証以前」の前段にあることの認識が薄かった
- `allowed_emails` が「認可」と「テナント所属判定」を兼ねている
- DWD用OAuthクライアントと Firebase Auth 用 OAuth クライアントの混在リスク

本ADRはGCIPマルチテナント移行（ADR-031）の前提として、4つの責務を明文化する。

## 決定
以下の4レイヤーに責務を分離し、各レイヤーの変更が他レイヤーに波及しない設計を維持する。

### レイヤー1: 認証（Authentication）
**責務**: 誰であるかの証明
- 現在: Firebase Authentication + Google OAuth
- 移行後: Google Cloud Identity Platform（GCIP）マルチテナント（ADR-031）
- 扱うデータ: Firebase UID、email、displayName

### レイヤー2: 認可（Authorization）
**責務**: 何ができるかの判定
- テナント内のロール（admin / teacher / student）
- 実装: `tenants/{tenantId}/users` の `role` フィールド
- ミドルウェア: `services/api/src/middleware/auth.ts` の `requireUser` / `requireAdmin`
- teacher/student のロール別判定はルートハンドラ内で `req.user.role` を直接参照する設計（専用ミドルウェアは未提供）

### レイヤー3: テナント解決（Tenant Resolution）
**責務**: どのテナントに属するユーザーかの判定
- URLパス: `/[tenant]/...`
- Firestoreパス: `tenants/{tenantId}/...`
- アクセス許可: `tenants/{tenantId}/allowed_emails`
- ミドルウェア: `services/api/src/middleware/tenant.ts`

### レイヤー4: Workspace連携（API代行）
**責務**: サーバーサイドでのGoogle Drive/Docs APIアクセス
- 認証方式: サービスアカウント Domain-Wide Delegation（DWD）
- 対象ドメイン: 279279.net限定
- サービスアカウント鍵: Secret Manager シークレット `dwd-workspace-key` から実行時取得（`google-auth.ts` 参照）
- 実装:
  - `services/api/src/services/google-auth.ts`: DWD JWT認証の実体（`getDriveClient()` / `getDocsClient()`）
  - `services/api/src/services/google-drive.ts`: Drive API呼び出し（認証経路は google-auth.ts に委譲）
  - `services/api/src/services/google-docs.ts`: Docs API呼び出し（同上）
- **エンドユーザー認証経路とは完全に独立**

## 根拠
- **OAuth同意画面はレイヤー1の前段に位置する**: この認識がなかったため、インシデント時に「allowed_emailsに追加すれば解決」と誤判断するリスクがあった
- **レイヤー3は認可ではない**: `allowed_emails` は「このテナントに所属を許可されたメール」であり、ロール（レイヤー2）とは別概念
- **DWDとエンドユーザー認証の混同防止**: OAuthクライアントID、スコープ、サービスアカウント、監査ログは別個に管理する
- **GCIP移行の土台**: ADR-031でテナント単位の認証経路を導入する際、本ADRの責務分離が前提となる

## 影響
- ドキュメント `docs/architecture.md` に4レイヤー図を追加
- 新規エンジニアオンボーディング時に本ADRを必読資料として提示
- OAuthクライアントIDの命名規則（**新規作成時のみ適用**）: `lms-279-auth-*`（認証用）、`lms-279-dwd-*`（DWD用）とプレフィックスで区別
  - 既存クライアントの改名は不要（ラベルで識別を補完する運用）
- 監査ログ: 現状の Cloud Logging ログに `layer` ラベル（`auth` / `authz` / `tenant` / `workspace`）を追加する方針。新規ログバケット作成は不要

## 参考
- インシデント契機: 2026-04-21 外部ドメインユーザーのログイン不可（403 org_internal）
- Codex セカンドオピニオン（2026-04-21）: 「認証/認可/テナント解決/Workspace連携の責務分離を明文化すべき」
- 関連ADR: ADR-005（Firebase Auth）、ADR-006（allowed_emails）、ADR-007（マルチテナント分離）、ADR-026（DWD）
