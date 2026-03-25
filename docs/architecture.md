# アーキテクチャ

## システム構成

```
[Web App (Next.js 16)] → [API Service (Express 5)] → [Firestore]
         |                        |                         |
         |                        +→ [GCS (動画ストレージ)]
         |                        +→ [Firebase Auth]
         |
         +→ [Notification Service]
```

### サービス構成（すべてCloud Run）

| サービス | 役割 |
|---------|------|
| `services/api` | REST API（認証、講座管理、動画管理、テスト、進捗） |
| `services/notification` | 通知送信 |
| `web` | Next.js App Router（受講者/管理画面） |

### データフロー

1. **動画視聴**: 講座選択 → レッスン開始 → 署名付きURL取得 → 動画再生 → イベントバッチ送信 → サーバー集計 → 完了判定
2. **テスト受験**: 動画完了確認 → テスト開始 → 回答 → 提出 → サーバーサイド採点 → 結果表示
3. **進捗更新**: 動画完了/テスト合格時 → user_progress更新 → course_progress更新

### GCPリソース

| リソース | 名前 | 用途 |
|---------|------|------|
| Cloud Run | `api` | Express API |
| Cloud Run | `web` | Next.js |
| Cloud Run | `notification` | 通知 |
| Firestore | (default) | データストア |
| GCS | `lms-279-videos` | 動画保存 |
| GCS | `lms-279-uploads` | 一時アップロード（24h TTL） |
| Artifact Registry | `lms-279` | Dockerイメージ |
| Cloud Scheduler | `notification-trigger` | 通知トリガー |
| Firebase Auth | - | ユーザー認証 |
| Secret Manager | super-admin-emails等 | 機密情報 |

### 認証フロー

1. Web: Firebase SDK → Googleソーシャルログイン → IDトークン取得
2. API: Authorization: Bearer {token} → Firebase Admin SDK検証 → allowed_emails確認
3. 開発時: AUTH_MODE=dev → X-Dev-User-Emailヘッダで疑似認証

### マルチテナント

- URLパス: `/api/v2/:tenant/`
- データ分離: `tenants/{tenantId}/` 配下に全データ格納
- テナントミドルウェアでアクセス制御
