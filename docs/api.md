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

### テスト

| メソッド | パス | 説明 | 権限 |
|---------|------|------|------|
| POST | `/admin/lessons/:lessonId/quiz` | テスト作成 | Admin |
| PATCH | `/admin/lessons/:lessonId/quiz` | テスト更新 | Admin |
| DELETE | `/admin/lessons/:lessonId/quiz` | テスト削除 | Admin |
| GET | `/quizzes/:quizId` | テスト取得（正解なし） | Student |
| POST | `/quizzes/:quizId/attempts` | テスト開始 | Student |
| PATCH | `/quiz-attempts/:attemptId` | テスト提出 | Student |
| GET | `/quiz-attempts/:attemptId/result` | 結果取得 | Student |
| POST | `/admin/lessons/:lessonId/quiz/generate` | Google DocsからAIテスト生成 | Admin |

### 進捗

| メソッド | パス | 説明 | 権限 |
|---------|------|------|------|
| GET | `/courses` | コース一覧+進捗 | Student |
| GET | `/courses/:courseId` | コース詳細+レッスン一覧+進捗 | Student |
| GET | `/courses/:courseId/lessons/:lessonId` | レッスン詳細 | Student |

### 出席管理（セッション）

| メソッド | パス | 説明 | 権限 |
|---------|------|------|------|
| POST | `/lesson-sessions` | セッション作成（入室打刻） | Student |
| GET | `/lesson-sessions/active?lessonId=X` | アクティブセッション取得 | Student |
| PATCH | `/lesson-sessions/:sessionId/force-exit` | 強制退室 | Student |

### 分析（Admin）

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/admin/analytics/courses/:courseId/progress` | コース別進捗 |
| GET | `/admin/analytics/users/:userId/progress` | ユーザー別進捗 |
| GET | `/admin/analytics/videos/:videoId/stats` | 動画視聴統計 |
| GET | `/admin/analytics/quizzes/:quizId/stats` | テスト統計 |
| GET | `/admin/analytics/suspicious-viewing` | 不審視聴一覧 |
| GET | `/admin/analytics/attendance/courses/:courseId` | コース出席管理 |
| GET | `/admin/analytics/attendance/export/courses/:courseId` | 出席CSVエクスポート |

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
| DELETE | `/master/lessons/:id` | レッスン削除（動画・テスト含む） |

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

#### テストCRUD

| メソッド | パス | 説明 |
|---------|------|------|
| POST | `/master/lessons/:lessonId/quiz` | テスト作成/置換 |
| PATCH | `/master/quizzes/:id` | テスト更新 |
| DELETE | `/master/quizzes/:id` | テスト削除（IDで） |
| DELETE | `/master/lessons/:lessonId/quiz` | テスト削除（レッスンIDで） |

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


### 公開テナント情報（認証不要）

ベースURL: `/api/v2/public/`

FE が GCIP 経路のログイン前に `auth.tenantId` へ `gcipTenantId` をセットするための認証不要エンドポイント（ADR-031）。

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/tenants/:tenantId` | テナントの公開情報取得（認証不要） |

#### レスポンス

```json
// GET /public/tenants/:tenantId (200)
{
  "tenant": {
    "id": "test-tenant",
    "status": "active",
    "gcipTenantId": "tenant-gcip-xyz",
    "useGcip": true
  }
}
```

#### セキュリティ設計

- **情報漏洩防止**: `name` / `ownerId` / `ownerEmail` / `userCount` / `createdAt` / `updatedAt` は含めない（顧客名の enumeration 漏洩防止）
- **Enumeration 防止**: 未登録 / `RESERVED_TENANT_IDS` / 不正フォーマットは全て同一の `404 tenant_not_found` + 同一 `Cache-Control` を返す
- **suspended テナント**: 200 で返却し `status: "suspended"` を含める（FE はメンテ画面切替に使用）
- **status の fail-closed 判定**: `"active"` / `"suspended"` 以外の値（データ破損・未設定）は `suspended` にフォールバック（active 漏洩防止）
- **レート制限**: `authLimiter` 流用（10 req/min/IP）
- **Firestore 障害時**: `503 firestore_unavailable` + `Cache-Control: no-store` + 構造化 `logger.error` でアラート可能
- **HTTP キャッシュ**: 200 / 404 とも `Cache-Control: public, max-age=60`（header 差分で存在有無が推測されないよう統一）、503 は `no-store`

関連: ADR-031

### プラットフォーム認証エラーログ（Super Admin）

ベースURL: `/api/v2/super/`

super-admin 経路の認証拒否（tenant スコープ外）を root コレクション `platform_auth_error_logs` に記録し、同ルートから参照する。tenant-scoped `/admin/auth-errors` と分離されている（ADR-031）。

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/platform/auth-errors` | プラットフォーム認証エラーログ一覧取得（super-admin のみ） |

#### クエリパラメータ
- `email`（任意）: メールアドレス完全一致フィルタ
- `startDate`（任意）: ISO 8601 日時。不正値は 400 `invalid_start_date`
- `endDate`（任意）: ISO 8601 日時。不正値は 400 `invalid_end_date`。`startDate > endDate` は空配列を返す
- `limit`（任意）: 1〜500（デフォルト 100、範囲外は clamp、不正値は 100）

```json
// GET /platform/auth-errors レスポンス（200）
{
  "platformAuthErrorLogs": [
    {
      "id": "abc123",
      "email": "denied@example.com",
      "tenantId": "__platform__",
      "errorType": "super_admin_denied",
      "reason": "not_super_admin",
      "errorMessage": "Email not registered as super admin",
      "path": "/api/v2/super/tenants",
      "method": "GET",
      "userAgent": null,
      "ipAddress": null,
      "firebaseErrorCode": null,
      "occurredAt": "2026-04-22T12:00:00.000Z"
    }
  ]
}
```

#### 認可
- `superAdminAuthMiddleware` 配下。非 super-admin は 403 `{ error: "forbidden" }`
- 認証欠落は 401 `{ error: "unauthorized" }`

関連 Issue: #292（記録側）、#299（読み取り側）
