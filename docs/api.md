# API設計

## ベースURL

`/api/v2/:tenant/`

## 認証

- `Authorization: Bearer {Firebase ID Token}`
- 開発時: `AUTH_MODE=dev` + `X-Dev-User-Email` ヘッダ

## エラーレスポンス

```json
{
  "error": {
    "code": "not_found",
    "message": "Course not found",
    "details": {}
  }
}
```

## エンドポイント

### 継承（参考プロジェクトから）

| メソッド | パス | 説明 |
|---------|------|------|
| POST | `/auth/login` | ログイン |
| GET/POST | `/admin/users` | ユーザー管理 |
| GET/POST/DELETE | `/admin/allowed-emails` | 許可メール管理 |
| GET | `/admin/auth-errors` | 認証エラーログ |
| GET/PATCH | `/admin/notification-policies` | 通知ポリシー |
| POST | `/tenants` | テナント登録 |
| GET/PATCH | `/super/tenants` | スーパー管理者 |

### 講座管理（Admin）

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/admin/courses` | 講座一覧 |
| POST | `/admin/courses` | 講座作成 |
| GET | `/admin/courses/:id` | 講座詳細 |
| PATCH | `/admin/courses/:id` | 講座更新 |
| DELETE | `/admin/courses/:id` | 講座削除 |
| PATCH | `/admin/courses/:id/publish` | 講座公開 |
| PATCH | `/admin/courses/:id/archive` | 講座アーカイブ |

### レッスン管理（Admin）

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/admin/courses/:courseId/lessons` | レッスン一覧 |
| POST | `/admin/courses/:courseId/lessons` | レッスン作成 |
| GET | `/admin/courses/:courseId/lessons/:lessonId` | レッスン詳細 |
| PATCH | `/admin/courses/:courseId/lessons/:lessonId` | レッスン更新 |
| DELETE | `/admin/courses/:courseId/lessons/:lessonId` | レッスン削除 |
| PATCH | `/admin/courses/:courseId/lessons/reorder` | レッスン並べ替え |

### 動画管理

| メソッド | パス | 説明 | 権限 |
|---------|------|------|------|
| POST | `/admin/videos/upload-url` | GCS署名付きアップロードURL発行 | Admin |
| POST | `/admin/lessons/:lessonId/video` | 動画メタデータ登録 | Admin |
| PATCH | `/admin/lessons/:lessonId/video` | 動画メタデータ更新 | Admin |
| DELETE | `/admin/lessons/:lessonId/video` | 動画削除 | Admin |
| GET | `/videos/:videoId/playback-url` | 署名付き再生URL取得 | Student |
| POST | `/videos/:videoId/events` | イベントバッチ送信 | Student |
| GET | `/videos/:videoId/analytics` | 自分の視聴状況 | Student |

### クイズ

| メソッド | パス | 説明 | 権限 |
|---------|------|------|------|
| POST | `/admin/lessons/:lessonId/quiz` | クイズ作成 | Admin |
| PATCH | `/admin/lessons/:lessonId/quiz` | クイズ更新 | Admin |
| DELETE | `/admin/lessons/:lessonId/quiz` | クイズ削除 | Admin |
| GET | `/quizzes/:quizId` | クイズ取得（正解なし） | Student |
| POST | `/quizzes/:quizId/attempts` | クイズ開始 | Student |
| PATCH | `/quiz-attempts/:attemptId` | クイズ提出 | Student |
| GET | `/quiz-attempts/:attemptId/result` | 結果取得 | Student |

### 進捗

| メソッド | パス | 説明 | 権限 |
|---------|------|------|------|
| GET | `/courses` | コース一覧+進捗 | Student |
| GET | `/courses/:courseId` | コース詳細+レッスン一覧+進捗 | Student |
| GET | `/courses/:courseId/lessons/:lessonId` | レッスン詳細 | Student |

### 分析（Admin）

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/admin/analytics/courses/:courseId/progress` | コース別進捗 |
| GET | `/admin/analytics/users/:userId/progress` | ユーザー別進捗 |
| GET | `/admin/analytics/videos/:videoId/stats` | 動画視聴統計 |
| GET | `/admin/analytics/quizzes/:quizId/stats` | クイズ統計 |
| GET | `/admin/analytics/suspicious-viewing` | 不審視聴一覧 |
