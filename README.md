# LMS-279

動画視聴管理・テスト機能を統合したLMS（Learning Management System）。

## リンク

| 環境 | URL |
|------|-----|
| Web App | https://web-3zcica5euq-an.a.run.app |
| 内部ポータル | https://web-3zcica5euq-an.a.run.app/internal |
| API | https://api-3zcica5euq-an.a.run.app |

## 技術スタック

- **Frontend**: Next.js 16 / React 19 / TypeScript 5.9
- **Backend**: Express 5 / Node.js v24
- **Database**: Firestore
- **Storage**: Google Cloud Storage（動画ホスティング）
- **Auth**: Firebase Authentication
- **Infra**: Cloud Run

## 開発

```bash
npm install
npm run dev -w @lms-279/web       # Web開発サーバー
npm run start -w @lms-279/api     # APIサーバー
```

詳細は [CLAUDE.md](./CLAUDE.md) を参照。
