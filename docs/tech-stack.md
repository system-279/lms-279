# 技術スタック

## ランタイム・言語

| 技術 | バージョン | 用途 |
|------|----------|------|
| Node.js | v24.12.0+ | ランタイム |
| TypeScript | 5.9.3 | 型安全 |
| ES Modules | - | モジュールシステム（全サービス `type: "module"`） |

## フロントエンド

| 技術 | バージョン | 用途 |
|------|----------|------|
| Next.js | 16.2.6 | App Router, SSR/RSC |
| React | 19.2.8 | UIフレームワーク |
| Tailwind CSS | 4.1.18 | スタイリング |
| Radix UI | 各種 | アクセシブルUIコンポーネント |
| Lucide React | 0.577.0 | アイコン |
| Firebase SDK | 12.14.0 | クライアント認証 |

## バックエンド

| 技術 | バージョン | 用途 |
|------|----------|------|
| Express | 5.2.1 | REST APIフレームワーク |
| Firebase Admin SDK | 13.10.0 | サーバーサイド認証 |
| Firestore SDK | 8.6.0 | データベース |
| GCS SDK | 7.16.0 | 動画ストレージ |

## テスト

| 技術 | バージョン | 用途 |
|------|----------|------|
| Vitest | 4.1.6 | ユニットテスト |
| Supertest | 7.2.2 | APIテスト |
| Playwright | 1.60.0 | E2Eテスト |

## インフラ

| 技術 | 用途 |
|------|------|
| Cloud Run | コンテナ実行 |
| Firestore | NoSQLデータベース |
| Google Cloud Storage | 動画ストレージ |
| Firebase Authentication | ユーザー認証 |
| Artifact Registry | Dockerイメージ |
| Cloud Scheduler | 定期実行 |
| Secret Manager | 機密情報管理 |
| GitHub Actions | CI/CD |

## 開発ツール

| 技術 | バージョン | 用途 |
|------|----------|------|
| ESLint | 9.39.4 | リンター |
| npm workspaces | - | モノレポ管理 |
