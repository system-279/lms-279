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
| POST | `/admin/videos/import-from-drive` | Google Driveから動画インポート | Admin |
| GET | `/admin/videos/:videoId/import-status` | インポート状況確認 | Admin |

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
| POST | `/admin/lessons/:lessonId/quiz/generate` | Google DocsからAIクイズ生成 | Admin |

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

### マスターコンテンツ管理（Super Admin）

ベースURL: `/api/v2/super/`

#### コースCRUD

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/master/courses` | マスターコース一覧 |
| POST | `/master/courses` | マスターコース作成 |
| GET | `/master/courses/:id` | マスターコース詳細+レッスン一覧 |
| PATCH | `/master/courses/:id` | マスターコース更新 |
| DELETE | `/master/courses/:id` | マスターコース削除（配下含む） |

```json
// POST /master/courses リクエスト
{ "name": "基礎研修コース", "description": "新入社員向け", "passThreshold": 80 }

// レスポンス 201
{
  "course": {
    "id": "abc123",
    "name": "基礎研修コース",
    "description": "新入社員向け",
    "status": "draft",
    "lessonOrder": [],
    "passThreshold": 80,
    "createdBy": "admin@example.com",
    "createdAt": "2026-03-19T00:00:00.000Z",
    "updatedAt": "2026-03-19T00:00:00.000Z"
  }
}
```

#### レッスンCRUD

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/master/courses/:courseId/lessons` | レッスン一覧 |
| POST | `/master/courses/:courseId/lessons` | レッスン作成 |
| PATCH | `/master/lessons/:id` | レッスン更新 |
| DELETE | `/master/lessons/:id` | レッスン削除（動画・クイズ含む） |

```json
// POST /master/courses/:courseId/lessons リクエスト
{ "title": "第1回 基本操作" }

// レスポンス 201
{
  "lesson": {
    "id": "les123",
    "courseId": "abc123",
    "title": "第1回 基本操作",
    "order": 0,
    "hasVideo": false,
    "hasQuiz": false,
    "videoUnlocksPrior": false,
    "createdAt": "2026-03-19T00:00:00.000Z",
    "updatedAt": "2026-03-19T00:00:00.000Z"
  }
}
```

#### 動画CRUD

| メソッド | パス | 説明 |
|---------|------|------|
| POST | `/master/lessons/:lessonId/video` | 動画作成/置換 |
| PATCH | `/master/videos/:id` | 動画更新 |
| DELETE | `/master/videos/:id` | 動画削除（IDで） |
| DELETE | `/master/lessons/:lessonId/video` | 動画削除（レッスンIDで） |

```json
// POST /master/lessons/:lessonId/video リクエスト
{ "sourceType": "gcs", "gcsPath": "videos/intro.mp4", "durationSec": 300 }

// レスポンス 201
{
  "video": {
    "id": "vid123",
    "lessonId": "les123",
    "courseId": "abc123",
    "sourceType": "gcs",
    "gcsPath": "videos/intro.mp4",
    "durationSec": 300,
    "requiredWatchRatio": 0.95,
    "speedLock": true,
    "createdAt": "2026-03-19T00:00:00.000Z",
    "updatedAt": "2026-03-19T00:00:00.000Z"
  }
}
```

#### クイズCRUD

| メソッド | パス | 説明 |
|---------|------|------|
| POST | `/master/lessons/:lessonId/quiz` | クイズ作成/置換 |
| PATCH | `/master/quizzes/:id` | クイズ更新 |
| DELETE | `/master/quizzes/:id` | クイズ削除（IDで） |
| DELETE | `/master/lessons/:lessonId/quiz` | クイズ削除（レッスンIDで） |

```json
// POST /master/lessons/:lessonId/quiz リクエスト
{
  "title": "確認テスト",
  "questions": [{
    "id": "q1", "text": "1+1=?", "type": "single",
    "options": [
      { "id": "o1", "text": "2", "isCorrect": true },
      { "id": "o2", "text": "3", "isCorrect": false }
    ],
    "points": 1, "explanation": "1+1=2"
  }]
}

// レスポンス 201
{ "quiz": { "id": "qz123", "lessonId": "les123", "courseId": "abc123", "title": "確認テスト", ... } }
```

#### 配信

| メソッド | パス | 説明 |
|---------|------|------|
| POST | `/master/distribute` | コースをテナントに配信 |
| GET | `/master/courses/:id/distributions` | 配信状況確認 |

```json
// POST /master/distribute リクエスト
{ "courseIds": ["abc123"], "tenantIds": ["tenant1", "tenant2"] }

// レスポンス 200
{
  "results": [
    {
      "tenantId": "tenant1",
      "courseId": "new-course-id-1",
      "masterCourseId": "abc123",
      "status": "success",
      "lessonsCount": 5,
      "videosCount": 3,
      "quizzesCount": 2
    },
    {
      "tenantId": "tenant2",
      "courseId": "existing-id",
      "masterCourseId": "abc123",
      "status": "skipped",
      "reason": "already distributed",
      "lessonsCount": 0,
      "videosCount": 0,
      "quizzesCount": 0
    }
  ]
}

// GET /master/courses/:id/distributions レスポンス
{
  "distributions": [
    {
      "tenantId": "tenant1",
      "tenantName": "テスト組織",
      "courseId": "new-course-id-1",
      "courseName": "基礎研修コース",
      "status": "draft",
      "copiedAt": "2026-03-19T00:00:00.000Z"
    }
  ]
}
```

#### 配信済みコースの追加フィールド

テナントAPIの講座レスポンスに、マスターから配信されたコースの場合のみ追加されるフィールド:

```json
{
  "course": {
    "id": "new-course-id-1",
    "name": "基礎研修コース",
    "sourceMasterCourseId": "abc123",
    "copiedAt": "2026-03-19T00:00:00.000Z",
    ...
  }
}
```
