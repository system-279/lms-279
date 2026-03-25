# PRD: LMS 内部ポータルページ

## 背景と目的

LMS（Learning Management System）は3つのロール（スーパー管理者/テナント管理者/受講者）に分かれた複数の画面を持つが、全体像を把握する内部向けドキュメントが存在しない。

新規メンバーのオンボーディング、運用担当者の操作ガイド、開発者のシステム理解を支援するため、**内部向けポータルページ**を作成する。

## ターゲットユーザー

- 社内の運用担当者（非エンジニア含む）
- 開発メンバー（新規参加者）
- テナント管理者（講座運用者）

## 要件

### 1. ポータルページの構成

```
/internal （内部ポータルトップ）
├── システム全体図（アーキテクチャ図）
├── 画面一覧と各画面へのリンク
├── 運用フロー（コース作成〜受講者視聴まで）
└── 主要機能の説明
```

### 2. 画面一覧とリンク

| セクション | 画面 | URL | 説明 |
|-----------|------|-----|------|
| **スーパー管理** | マスターコース管理 | `/super/master/courses` | コース・レッスン・動画・テストの管理 |
| | マスターコース詳細 | `/super/master/courses/{id}` | 動画・テスト設定、プレビュー |
| | テナント配信 | `/super/distribute` | マスターコースをテナントに配信・再配信 |
| | 設定 | `/super/settings` | テナント管理 |
| **テナント管理** | ダッシュボード | `/{tenant}/admin` | テナントの概要 |
| | 講座管理 | `/{tenant}/admin/courses` | コースの公開/アーカイブ/削除 |
| | レッスン管理 | `/{tenant}/admin/courses/{id}/lessons` | レッスン一覧 |
| | レッスン詳細 | `/{tenant}/admin/courses/{id}/lessons/{id}` | 動画・テスト管理 |
| | 受講者管理 | `/{tenant}/admin/users` | 受講者の登録・管理 |
| | 許可メール管理 | `/{tenant}/admin/allowed-emails` | ログイン許可メール |
| | 分析 | `/{tenant}/admin/analytics` | 進捗・視聴データ分析 |
| **受講者** | コース一覧 | `/{tenant}/student/courses` | 受講可能コース |
| | コース詳細 | `/{tenant}/student/courses/{id}` | レッスン一覧・進捗 |
| | レッスン受講 | `/{tenant}/student/courses/{id}/lessons/{id}` | 動画視聴・テスト受験 |

### 3. 運用フロー（メインシナリオ）

```
1. マスターコース作成（スーパー管理）
   └→ コース名・説明を設定

2. レッスン追加（スーパー管理）
   └→ レッスンタイトル・順序を設定

3. 動画登録（スーパー管理）
   ├→ ファイルアップロード（GCS）
   └→ Google Driveからインポート

4. テスト作成（スーパー管理）
   ├→ 手動作成（問題・選択肢を入力）
   ├→ Google Docsから生成（AIが問題を自動生成）
   └→ Google Docsからインポート（既存テストを取り込み）★New

5. コース公開（スーパー管理）
   └→ ステータスを draft → published に変更

6. テナント配信（スーパー管理）
   ├→ 初回配信: コース・レッスン・動画・テストを深コピー
   └→ 再配信: 既存を削除して最新を再コピー ★New

7. テナント側コース公開（テナント管理）
   └→ 配信されたコースを公開

8. 受講者がコースを受講
   └→ 動画視聴 → テスト受験 → 進捗記録
```

### 4. 主要機能の説明セクション

#### テスト取り込み機能（Issue #60）
- Google Docsの「テスト」タブから既存テストをインポート
- 太字=正解として自動判定
- Geminiをパーサーとして使用（問題の創作を防止）
- 正解不明の場合はユーザーが手動設定

#### コース配信（ADR-024）
- マスターコースの深コピーでテナントに配信
- 再配信オプションで最新コンテンツを反映（Issue #65）
- GCS動画パスは共有（コピーしない）

#### 動画プレイヤー（ADR-012〜015）
- カスタムHTML5 Video API
- 倍速禁止（サーバーサイド違反記録）
- 署名付きURL（2時間有効）

### 5. 本番環境情報

| サービス | URL |
|---------|-----|
| Web（フロント） | `https://web-3zcica5euq-an.a.run.app` |
| API | `https://api-3zcica5euq-an.a.run.app` |
| GCP Project | `lms-279` |
| Firebase Project | `lms-279` |

### 6. アーキテクチャ概要

```
[Web App (Next.js 16)] → [API Service (Express 5)] → [Firestore]
         |                        |
         |                        +→ [GCS (動画ストレージ)]
         |                        +→ [Firebase Auth]
         |                        +→ [Vertex AI (Gemini)]
         |                        +→ [Google Docs API]
         |                        +→ [Google Drive API]
         +→ [Notification Service]

全サービス: Cloud Run (asia-northeast1)
```

## 実装方針

### オプションA: 静的ページ（推奨）
- `/internal` ルートにNext.jsの静的ページとして実装
- 認証不要（または簡易的なBasic認証）
- マークダウンベースで編集しやすい

### オプションB: 別リポジトリのドキュメントサイト
- Docusaurus/VitePress等で別途構築
- メンテナンスコストが増加

### 推奨: オプションA
LMSのリポジトリ内に `/internal` ページとして実装。コードベースと同じリポジトリなので常に最新を維持しやすい。

### 7. 画面キャプチャ

Playwright MCPでデスクトップレイアウト（1440x900）のスクリーンショットを撮影し、各セクションに挿し込む。

| 対象画面 | ファイル名 |
|---------|-----------|
| スーパー管理 - マスターコース管理 | `super-master-courses.png` |
| スーパー管理 - コース詳細（動画・テストプレビュー） | `super-master-course-detail.png` |
| スーパー管理 - テナント配信 | `super-distribute.png` |
| テナント管理 - 講座管理 | `tenant-admin-courses.png` |
| テナント管理 - レッスン詳細（動画・テスト） | `tenant-admin-lesson-detail.png` |
| 受講者 - コース一覧 | `student-courses.png` |
| 受講者 - レッスン受講（動画プレイヤー） | `student-lesson.png` |

保存先: `docs/images/`

撮影手順:
1. Playwright MCPでブラウザを起動
2. 本番サイトに手動でGoogleログイン
3. 各画面に遷移してスクリーンショット撮影
4. ポータルページのmarkdownに画像を埋め込み

## 非スコープ
- 外部向けドキュメント
- APIリファレンス（Swagger/OpenAPI）
- 運用手順書の詳細（別途作成）
