# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

動画視聴管理・テスト機能を統合したLMS（Learning Management System）。参考プロジェクト `classroom-check-in` のマルチテナント基盤を継承し、動画プレイヤーとテスト機能を中核として新規構築。

**参考プロジェクトとの主な違い**:
- 動画プレイヤー（カスタムHTML5 Video API）が中核機能
- テスト自動採点システム
- 進捗トラッキング（非正規化）
- GCS動画ホスティング + 署名付きURL

## 開発コマンド

```bash
# 依存関係のインストール（npm workspaces）
npm install

# 各サービスのビルド
npm run build -w @lms-279/api
npm run build -w @lms-279/notification
npm run build -w @lms-279/web

# 各サービスの起動
npm run start -w @lms-279/api

# Web開発サーバー
npm run dev -w @lms-279/web

# リント・型チェック・テスト（全ワークスペース）
npm run lint
npm run type-check
npm run test
```

## アーキテクチャ

```
[Web App (Next.js 16)] → [API Service (Express 5)] → [Firestore]
         |                        |
         |                        +→ [GCS (動画ストレージ)]
         |                        +→ [Firebase Auth]
         +→ [Notification Service]
```

### サービス構成（すべてCloud Run）

| サービス | 役割 |
|---------|------|
| `packages/shared-types` | FE-BE共有APIレスポンス型（`@lms-279/shared-types`） |
| `services/api` | REST API（認証、講座管理、動画管理、テスト、進捗） |
| `services/notification` | 通知送信 |
| `web` | Next.js App Router（受講者/管理画面） |

## 技術スタック

- Node.js v24.12.0 (LTS)
- TypeScript 5.9.3, ES Modules (`type: "module"`)
- Next.js 16.1.1, React 19.2.3
- Express 5.2.1
- Firestore 8.1.0, GCS 7.16.0
- Firebase Admin SDK 13.6.0

バージョンは`docs/tech-stack.md`と`package.json`で同期を維持すること。

## 環境変数

| 変数 | 説明 |
|------|------|
| `AUTH_MODE` | `dev`=ヘッダ疑似認証、`firebase`=Firebase認証（本番用） |
| `GOOGLE_APPLICATION_CREDENTIALS` | サービスアカウントJSONパス |
| `FIREBASE_PROJECT_ID` | Firebase プロジェクトID |
| `SUPER_ADMIN_EMAILS` | スーパー管理者メールアドレス（カンマ区切り） |
| `GCS_VIDEO_BUCKET` | 動画保存バケット名（default: lms-279-videos） |
| `GCS_UPLOAD_BUCKET` | 一時アップロードバケット名（default: lms-279-uploads） |
| `GOOGLE_WORKSPACE_ADMIN_EMAIL` | DWD用Workspace管理者メール（Google Drive/Docs連携） |
| `VERTEX_AI_LOCATION` | Vertex AIリージョン（default: asia-northeast1） |

## 重要な設計判断

- **動画プレイヤー**: カスタムHTML5 Video API。Video.js/Plyr不使用（ADR-012）
- **動画配信**: GCS + 署名付きURL（2時間有効）（ADR-013）
- **視聴分析**: クライアント→生イベント送信、サーバー→集計（ADR-014）
- **倍速禁止**: クライアント即時リセット + サーバー違反記録（ADR-015）
- **テスト**: 問題埋め込み（上限50問）、サーバーサイド採点（ADR-016, ADR-017）
- **コンテンツ階層**: Course → Lessons → Video + Quiz（ADR-018）
- **動画→テストゲート**: video完了後にテストアクセス許可（ADR-019）
- **進捗**: user_progress + course_progress 非正規化（ADR-020）
- **イベント送信**: 5秒間隔バッチ、最大50件/リクエスト（ADR-021）
- **不審検出**: サーバーサイドヒューリスティクス（ADR-022）
- **認証**: Firebase Authentication + Googleソーシャルログイン（ADR-005）
- **マルチテナント**: Firestoreパスベース分離（ADR-007）
- **エラーレスポンス**: フラット形式 { error: "code", message: "..." }（ADR-010改訂済み）
- **Classroom/Forms不使用**: 再生制御・視聴追跡が不可のため自前実装（ADR-023）
- **マスターコンテンツ配信**: 深コピーでテナントに配信（ADR-024）
- **セキュリティ強化**: Helmet, レート制限, CORS（ADR-025）
- **Google Workspace連携**: DWDでDrive動画インポート + Docsテスト生成（ADR-026）
- **出席管理**: lesson_sessionsで入退室打刻、15分一時停止/2時間制限で強制退室（ADR-027）
- **テスト戦略**: InMemoryDataSource中心の統合テスト（ADR-028）
- **タイムゾーン基準**: 受講期限はUTC日末保存、JST表示（ADR-029）
- **FE-BE共有型**: `@lms-279/shared-types`でAPIレスポンスDTOを共有。新規APIエンドポイント追加時はshared-typesに型を先に定義すること

全ADRは`docs/adr/`を参照。

## APIベースURL

`/api/v2/:tenant/`

主要エンドポイントは`docs/api.md`を参照。

## データモデル

Firestore: `tenants/{tenantId}/` 配下に全データ。
詳細は`docs/data-model.md`を参照。

主要コレクション: courses, lessons, videos, video_events, video_analytics, quizzes, quiz_attempts, user_progress, course_progress, lesson_sessions

## ドキュメント更新ルール

変更時は以下の順序で更新:
1. `docs/requirements.md`（仕様変更）
2. `docs/adr/`（判断理由をADR形式で記録）
3. `docs/data-model.md` / `docs/architecture.md`（整合性維持）
4. `docs/tech-stack.md`（依存更新時）

## 実装フェーズ

| Phase | 内容 | 状態 |
|-------|------|------|
| 1 | 基盤構築（API, Web, Auth, CRUD, CI/CD） | 完了 |
| 2 | 動画プレイヤー + 分析 | 完了 |
| 3 | テストシステム（動画完了ゲート付き） | 完了 |
| 4 | 進捗トラッキング | 完了 |
| 5 | 管理ダッシュボード + 分析 + CSVエクスポート | 完了 |
| 6 | APIセキュリティ強化（Helmet, レート制限） | 完了 |
| 7 | 可観測性（構造化ログ, Error Reporting, ヘルスチェック） | 完了 |
| 8 | E2Eテスト + CI強化（Playwright, テストジョブ） | 完了 |
| 9 | パフォーマンス + 本番仕上げ（キャッシュ, シャットダウン） | 完了 |
| 10 | Google Workspace連携（Drive動画インポート, Docsテスト生成） | 完了 |
| 11 | 出席管理システム（入退室打刻 + セッション管理） | 完了 |
