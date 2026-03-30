# 介護DX college２７９Classroom

動画視聴管理・テスト機能を統合した学習管理システム。

## リンク

| 環境 | URL |
|------|-----|
| Web App | https://web-3zcica5euq-an.a.run.app |
| API | https://api-3zcica5euq-an.a.run.app |

### ヘルプページ

| 対象 | URL |
|------|-----|
| ヘルプセンター（トップ） | https://web-3zcica5euq-an.a.run.app/help |
| 受講者向けヘルプ | https://web-3zcica5euq-an.a.run.app/help/student |
| 管理者向けヘルプ | https://web-3zcica5euq-an.a.run.app/help/admin |
| スーパー管理者向けヘルプ | https://web-3zcica5euq-an.a.run.app/help/super |

### 管理画面

| 画面 | URL |
|------|-----|
| スーパー管理 | https://web-3zcica5euq-an.a.run.app/super/master/courses |
| 内部ポータル | https://web-3zcica5euq-an.a.run.app/internal |

## 主な機能

### 受講者向け
- 講座の受講（コース一覧・レッスン選択）
- 動画視聴（カスタムHTML5プレイヤー、倍速禁止）
- 出席管理（入退室打刻、2時間制限、一時停止15分制限）
- テスト受験（単一選択/複数選択、自動採点、無制限受験）

### テナント管理者向け
- 講座の作成・公開・アーカイブ
- 動画登録（ファイルアップロード / Google Driveインポート）
- テスト作成（手動 / AI生成 / Googleドキュメントインポート）
- 受講者管理・許可メール管理
- 分析ダッシュボード（コース進捗 / 受講者進捗 / 不審視聴 / 出席管理 + CSVエクスポート）

### スーパー管理者向け
- マスター講座の作成・編集・受講者プレビュー
- テナントへの講座配信・再配信（上書き更新）
- スーパー管理者の追加・削除

## 技術スタック

- **Frontend**: Next.js 16 / React 19 / TypeScript 5.9
- **Backend**: Express 5 / Node.js v24
- **Database**: Firestore（パスベースマルチテナント）
- **Storage**: Google Cloud Storage（動画ホスティング + 署名付きURL）
- **Auth**: Firebase Authentication + Googleログイン
- **AI**: Vertex AI / Gemini（テスト生成・インポート）
- **Infra**: Cloud Run（asia-northeast1）

## 開発

```bash
npm install
npm run dev -w @lms-279/web       # Web開発サーバー
npm run start -w @lms-279/api     # APIサーバー
npm run type-check                # 型チェック
npm run lint                      # lint
npm run test                      # テスト実行
```

詳細は [CLAUDE.md](./CLAUDE.md) を参照。設計判断は [docs/adr/](./docs/adr/) を参照。
