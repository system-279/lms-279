# 設計仕様: 講座資料スライド PDF ダウンロード機能

**作成日**: 2026-05-17
**ステータス**: Draft (Phase 8 ユーザーレビュー前)
**関連 Issue / 依頼**: Session 28 ハンドオフ オーダー②

## 1. 概要

レッスンに紐づく講座資料スライド PDF を、テスト合格後の受講者がダウンロードできる機能を追加する。マスターレッスン (`_master`) で super-admin が PDF をアップロード・管理し、各テナントへのコース配信時にメタ情報のみディープコピーする (ADR-024 と同方針)。受講者は当該レッスンのテスト合格後、受講期間内に限り PDF をダウンロードできる。

## 2. 動機

- 介護講座の受講者から「視聴した動画の内容を後から見返したい」「スライド資料を職場で参照したい」というニーズ (現場声起点、Session 28 オーダー②)
- 動画 (60-80 分) を再視聴するよりも、スライド PDF で要点を素早く確認できる方が復習効率が高い
- super-admin が中央集権的にコンテンツを管理する既存運用 (ADR-024) と一貫した配信方法を採用

## 3. 要件

### 3.1 機能要件

| # | 要件 |
|---|---|
| F-1 | super-admin はマスターレッスンに PDF (最大 50 MB) を 1 個アップロードできる |
| F-2 | 受講者は当該レッスンの quiz_attempts でテスト合格 (`user_progress.quizPassed === true`) 後、PDF をダウンロードできる |
| F-3 | ダウンロード可能期間は受講開始から `videoAccessUntil` (デフォルト +1 年) まで |
| F-4 | マスターコースをテナントに配信 (`distributeCourseToTenant`) する際、PDF メタ情報 (gcsPath/fileName/sizeBytes/updatedAt) もディープコピーされる |
| F-5 | GCS のファイル本体は全テナントで共有 (`_master` のパスを参照)、ストレージコストを最小化 |
| F-6 | super-admin はマスターレッスンの PDF を差し替え・削除できる |
| F-7 | super-admin は既存配信済みコースに対し PDF メタ情報の遡及反映 (sync) を実行できる |
| F-8 | UI: レッスン詳細/一覧で合格後に DL ボタンを常設表示。未合格時は disabled + ツールチップ |
| F-9 | UI: 受講期間切れ後は DL ボタンを hide |
| F-10 | テナント管理者は PDF を編集できない (super-admin のみ管理) |

### 3.2 非機能要件

| # | 要件 |
|---|---|
| NF-1 | DL 用署名 URL は 15 分有効 (短期、ADR-013 動画 2 時間より厳しい) |
| NF-2 | DL アクセスは Cloud Logging に構造化ログで記録 (監査用) |
| NF-3 | undefined Firestore 書込み禁止 (`rules/production-data-safety.md` §1) |
| NF-4 | 認可失敗の列挙攻撃対策: 他テナントの lessonId は 404 で統一 |
| NF-5 | エラーレスポンスは ADR-010 改訂版フラット形式 (`{ error, message }`) |
| NF-6 | レッスン部分更新は他フィールド (`title`, `order`, `hasVideo` 等) を変化させない (CLAUDE.md CRITICAL Partial Update) |

## 4. アーキテクチャ

```
┌─ super-admin (Web) ─────────────────────────────────┐
│  Lesson 編集 UI: PDF upload widget                  │
│   1. POST /master/lessons/:id/pdf-upload-url        │
│      → 署名 PUT URL (1h)                            │
│   2. クライアント直接 PUT to GCS                     │
│   3. POST /master/lessons/:id/pdf  (confirm)        │
│      → lessons.pdfGcsPath 等 4 fields 書込み         │
└─────────────────┬───────────────────────────────────┘
                  │ 配信時 (既存 distributeCourseToTenant)
                  ▼
┌─ tenants/{tenant}/lessons/{id} ─────────────────────┐
│  pdfGcsPath: "lessons/{masterLessonId}/x.pdf"       │
│  pdfFileName, pdfSizeBytes, pdfUpdatedAt            │
│  (GCS パスは _master のものを共有、本体コピーなし)    │
└─────────────────┬───────────────────────────────────┘
                  │
                  ▼
┌─ 受講者 (Web) ──────────────────────────────────────┐
│  レッスン詳細/一覧:                                  │
│   quizPassed && now < videoAccessUntil ? 有効 : 無効│
│   click → GET /api/v2/:tenant/lessons/:id/pdf-      │
│           download                                   │
│   → 認可 (auth + quizPassed + videoAccessUntil)     │
│   → 短期署名 URL (15min) を JSON 返却                │
└─────────────────────────────────────────────────────┘
```

### 4.1 新規 GCS バケット

- バケット名: `lms-279-resources`
- env: `GCS_RESOURCE_BUCKET` (default `lms-279-resources`)
- IAM: super-admin SA write, API SA read のみ
- Object lifecycle: なし (講座資料は永続保持、削除は API 経由のみ)
- パス規約: `lessons/{masterLessonId}/{timestamp}_{sanitizedFileName}.pdf`

### 4.2 依存方向

- Web → API → Firestore + GCS (既存と同じ)
- 新規外部サービス・新規ライブラリ追加なし (`@google-cloud/storage` 既存)

## 5. データモデル

### 5.1 `lessons` コレクション拡張

```typescript
// services/api/src/types/entities.ts
interface Lesson {
  // 既存フィールド: courseId, title, order, hasVideo, hasQuiz, videoUnlocksPrior, createdAt, updatedAt
  pdfGcsPath?: string;       // 例: "lessons/{masterLessonId}/1684300000_intro.pdf"
  pdfFileName?: string;      // 受講者 DL 時の Content-Disposition で使用
  pdfSizeBytes?: number;     // UI 表示用
  pdfUpdatedAt?: Timestamp;  // 監査用
}
```

全 4 フィールドを optional にする理由: 既存レッスン (PDF 未添付) を破壊しないため。

### 5.2 `@lms-279/shared-types` への型追加

```typescript
// packages/shared-types/src/lesson.ts
export interface LessonResource {
  pdfFileName: string;
  pdfSizeBytes: number;
  pdfUpdatedAt: string;  // ISO 8601
}

export interface LessonDetailResponse {
  // 既存フィールド ...
  resource?: LessonResource;  // PDF 未添付なら undefined
}

export interface LessonPdfDownloadResponse {
  url: string;
  fileName: string;
  expiresAt: string;
}
```

`pdfGcsPath` は受講者向け API レスポンスには含めない (内部実装の露出を避ける)。

### 5.3 `course-distributor.ts` 拡張

```typescript
const lessonData = {
  // 既存フィールド ...
  ...(masterLesson.pdfGcsPath && {
    pdfGcsPath: masterLesson.pdfGcsPath,
    pdfFileName: masterLesson.pdfFileName,
    pdfSizeBytes: masterLesson.pdfSizeBytes,
    pdfUpdatedAt: masterLesson.pdfUpdatedAt,
  }),
};
```

`pdfGcsPath` 未設定マスターレッスンに対しては 4 フィールド全て書き込まない (production-data-safety §1)。

### 5.4 アクセス制御で参照する既存フィールド

| 用途 | 参照先 | 検証ロジック |
|---|---|---|
| 合格判定 | `user_progress.quizPassed` (ID: `{userId}_{lessonId}`) | `=== true` |
| DL 期限 | `course_enrollment_settings.videoAccessUntil` (ID: `{courseId}`) | `now < videoAccessUntil` (ISO 文字列比較) |

両方サーバー側で検証 (security boundary は API)。

## 6. インターフェース

### 6.1 新規 API エンドポイント

**super-admin 用 (`/api/v2/master/*`、既存 super-admin guard 利用)**:

| # | Method | Path | 用途 |
|---|---|---|---|
| 1 | POST | `/master/lessons/:lessonId/pdf-upload-url` | PUT 署名 URL 発行 (1h) |
| 2 | POST | `/master/lessons/:lessonId/pdf` | upload 確認 + メタ書込み |
| 3 | DELETE | `/master/lessons/:lessonId/pdf` | メタ削除 + GCS 削除 |
| 4 | POST | `/master/courses/:courseId/sync-resources` | 既存配信先テナントへ遡及反映 |

**受講者用 (`/api/v2/:tenant/*`、既存 firebase auth + tenant guard 利用)**:

| # | Method | Path | 用途 |
|---|---|---|---|
| 5 | GET | `/:tenant/lessons/:lessonId/pdf-download` | 認可後の短期署名 URL (15min) を返す JSON |

**既存エンドポイント拡張**:

- `GET /:tenant/lessons/:lessonId`: レスポンス DTO に `resource?: LessonResource`
- `GET /:tenant/courses/:courseId/lessons`: 各レッスンに同じ `resource?` (一覧画面用)

### 6.2 リクエスト/レスポンス例

**#1 POST `/master/lessons/:lessonId/pdf-upload-url`**

```json
// request
{ "fileName": "介護記録の書き方.pdf", "contentType": "application/pdf", "sizeBytes": 12345678 }
// response 200
{ "uploadUrl": "https://storage.googleapis.com/...", "gcsPath": "lessons/{id}/1684300000_介護記録の書き方.pdf", "expiresAt": "2026-05-17T15:00:00Z" }
```

制約:
- `contentType === "application/pdf"` 限定
- `sizeBytes <= 50 * 1024 * 1024` (50 MB)
- ファイル名は basename + 安全文字のみ (path traversal 防止)

**#5 GET `/:tenant/lessons/:lessonId/pdf-download`**

```json
// response 200
{ "url": "https://storage.googleapis.com/...", "fileName": "介護記録の書き方.pdf", "expiresAt": "2026-05-17T13:15:00Z" }
```

### 6.3 新規サービス層

`services/api/src/services/lesson-resource.ts` (新規):

```typescript
export async function generatePdfUploadUrl(masterLessonId, fileName, contentType): Promise<UploadUrlResponse>
export async function confirmPdfUpload(masterLessonId, gcsPath, fileName, sizeBytes): Promise<LessonResource>
export async function deletePdfResource(masterLessonId): Promise<void>
export async function generatePdfDownloadUrl(tenantId, lessonId, userId): Promise<DownloadUrlResponse>
export async function syncResourcesToTenants(masterCourseId): Promise<{ tenantsCount: number; lessonsCount: number }>
```

## 7. エラー処理

### 7.1 エラーコード一覧

| エラー種別 | 状況 | HTTP | message | リトライ |
|---|---|---|---|---|
| `invalid_file_type` | contentType ≠ application/pdf | 400 | "PDF ファイルのみアップロード可能です" | permanent |
| `file_too_large` | sizeBytes > 50 MB | 400 | "50 MB を超えるファイルはアップロードできません" | permanent |
| `lesson_not_found` | masterLessonId が _master に存在しない | 404 | | permanent |
| `quiz_not_passed` | user_progress.quizPassed !== true | 403 | "テスト合格後にダウンロード可能です" | permanent |
| `access_expired` | now >= videoAccessUntil | 403 | "受講期間が終了しています" | permanent |
| `resource_not_found` | lessons.pdfGcsPath 未設定 | 404 | "このレッスンには資料が登録されていません" | permanent |
| `gcs_unavailable` | GCS API 一時的エラー (503/429/timeout) | 503 | "一時的に取得できません" | **transient** (FE retry-after) |
| `gcs_file_missing` | gcsPath は記録あるが GCS にファイルなし | 500 | "資料ファイルが見つかりません" | permanent |

エラー形式は ADR-010 改訂版 (`{ error, message }` フラット)。

### 7.2 Firestore 書込みサニタイズ (production-data-safety §1)

```typescript
// confirmPdfUpload: 4 フィールド更新、他フィールドは保護
await lessonRef.update(sanitizeForUpdate({
  pdfGcsPath, pdfFileName, pdfSizeBytes, pdfUpdatedAt: FieldValue.serverTimestamp(),
}));

// deletePdfResource: FieldValue.delete() で明示削除
await lessonRef.update({
  pdfGcsPath: FieldValue.delete(),
  pdfFileName: FieldValue.delete(),
  pdfSizeBytes: FieldValue.delete(),
  pdfUpdatedAt: FieldValue.delete(),
});
```

### 7.3 エラーハンドラ自体のエラー耐性 (error-handling §1)

`deletePdfResource`: Firestore 削除 → GCS 削除 の順 (状態復旧優先)。GCS 削除失敗時は orphan ログを残して成功扱い (別途 cleanup ジョブで掃除可能)。

### 7.4 列挙攻撃対策

`GET /:tenant/lessons/:lessonId/pdf-download` で `lessonId` が他テナントのものだった場合、`404 lesson_not_found` を返す (403 と区別すると lessonId の存在/不在を漏らす)。

### 7.5 構造化ログ

```typescript
logger.info("pdf_uploaded", { masterLessonId, gcsPath, sizeBytes, userId: actor.uid });
logger.info("pdf_downloaded", { tenantId, lessonId, userId });
logger.error("pdf_download_denied", { tenantId, lessonId, userId, reason });
```

### 7.6 GCS 上書きアップロードの競合

`pdf-upload-url` のパスに `Date.now()` を含める。`confirmPdfUpload` で新 gcsPath をメタ書込みする際、旧 gcsPath を読んで GCS から削除。

## 8. テスト戦略

### 8.1 Acceptance Criteria

| # | カテゴリ | 基準 |
|---|---|---|
| AC-1 | アップロード成功 | super-admin が PDF アップロード → 4 フィールド書込み |
| AC-2 | 配信時コピー | `distributeCourseToTenant` で 4 フィールドがテナントにコピーされる |
| AC-3 | 既存 lesson 未破壊 | PDF アップロードしても title/order/hasVideo/hasQuiz/videoUnlocksPrior が変化しない |
| AC-4 | DL: 合格時 | quizPassed=true + 期間内 → 15min 署名 URL JSON |
| AC-5 | DL: 未合格 | quizPassed=false → 403 quiz_not_passed |
| AC-6 | DL: 期間切れ | now >= videoAccessUntil → 403 access_expired |
| AC-7 | DL: PDF 未添付 | pdfGcsPath 未設定 → 404 resource_not_found |
| AC-8 | DL: 他テナント侵入 | tenant=A token で tenant=B lessonId → 404 lesson_not_found |
| AC-9 | 削除順序 | メタ削除失敗 → throw, メタ削除成功 + GCS 削除失敗 → orphan ログのみで成功 |
| AC-10 | サイズ上限 | sizeBytes > 50MB → 400 file_too_large |
| AC-11 | MIME 制限 | contentType ≠ application/pdf → 400 invalid_file_type |
| AC-12 | UI: 未合格時 disabled | quizPassed=false → DL ボタン disabled + ツールチップ |
| AC-13 | UI: 期間切れ hide | now >= videoAccessUntil → DL ボタン hide |
| AC-14 | 遡及反映 | `syncResourcesToTenants` で全配信先 lessons の 4 フィールドが最新マスター値に同期 |

### 8.2 テスト分割

| レイヤー | テストファイル | フレームワーク | 件数目安 |
|---|---|---|---|
| 統合 (API ルート) | `services/api/src/routes/shared/__tests__/lesson-resource.test.ts` (新規) | InMemoryDataSource + supertest | 14 (AC-1〜11, 14) |
| サービスユニット | `services/api/src/services/__tests__/lesson-resource.test.ts` (新規) | vitest + GCS モック | 12 |
| 配信ロジック | `services/api/src/services/__tests__/course-distributor.test.ts` (既存追加) | InMemoryDataSource | 3 |
| FE コンポーネント | `web/components/lesson/__tests__/LessonPdfButton.test.tsx` (新規) | vitest + @testing-library | 4 |

**合計 33 ケース** (api 27 + web 4 + course-distributor 2 純増、共有部 -0)。

### 8.3 テストデータパターン

| パターン | quizPassed | videoAccessUntil | pdfGcsPath | 期待 |
|---|---|---|---|---|
| 1. 正常 | true | now+30d | あり | 200 + url |
| 2. 未合格 | false | now+30d | あり | 403 quiz_not_passed |
| 3. 期間切れ | true | now-1d | あり | 403 access_expired |
| 4. 期間ぴったり | true | now | あり | 403 access_expired |
| 5. PDF 未添付 | true | now+30d | undefined | 404 resource_not_found |
| 6. 他テナント | (A) true | (A) now+30d | (B) あり | 404 lesson_not_found |

### 8.4 データフロー検証

実装完了後に `/trace-dataflow` で `lessons.pdfGcsPath` (BE Firestore) → `LessonResource.pdfFileName` (shared-types DTO) → `pdfSizeBytes` 表示 (FE UI) の経路を全レイヤー追跡。

### 8.5 Quality Gate

- **5 ファイル以上**: ✅ 該当 → **Evaluator 分離プロトコル発動** (rules/quality-gate.md)
- **3 ファイル以上**: `/simplify` → `/safe-refactor` 実行
- **新機能の追加**: ✅ 該当 → Evaluator 分離

### 8.6 Definition of Done

- `npm run test -w @lms-279/api` 920 件以上 (現 893 + 27)
- `npm run test -w @lms-279/web` 57 件以上 (現 53 + 4)
- `npm run lint`, `npm run type-check` 全 PASS
- 変更コードパスを最低 1 回実機実行 (super-admin PDF アップロード + 受講者 DL)
- PR Test plan 全実行

## 9. スコープ外 / 将来課題

| 項目 | 理由 |
|---|---|
| 複数 PDF / 複数リソース種別 (動画補足、Excel 等) | 現要件 (1 レッスン 1 PDF) を超える、YAGNI |
| テナント管理者による差し替え/独自アップロード | super-admin 一元管理方針 (確定要件) |
| 期間無制限 DL (修了証代わり) | videoAccessUntil 同期方針 (確定要件) |
| PDF ウォーターマーク (受講者名透かし) | 別 Issue として将来検討 |
| PDF プレビュー (DL 前のサムネ表示) | 別 Issue として将来検討 |
| orphan GCS ファイル cleanup ジョブ | 運用上必要になったタイミングで Cloud Scheduler 追加 |
| `videoAccessUntil` を上書きする救済運用 | course_enrollment_settings 既存機能で対応可、本機能と独立 |

## 10. Open Questions

| # | 質問 | 検討タイミング |
|---|---|---|
| OQ-1 | super-admin Web UI の PDF アップロード widget は drop-zone か file-input か | impl-plan 時 / `/fd` で UI モック |
| OQ-2 | レッスン一覧 (`GET /:tenant/courses/:courseId/lessons`) のレスポンスサイズ増加影響 | impl-plan 時 / 既存 N+1 検証 |
| OQ-3 | ファイル名サニタイズ規約 (日本語 OK、特殊文字 NG の境界) | impl-plan 時 / セキュリティチームレビューなし、内部運用想定 |

## 11. 関連 ADR / リンク

| ADR | タイトル | 関係 |
|---|---|---|
| ADR-010 | エラーレスポンスフラット形式 | 準拠 |
| ADR-013 | GCS 動画ホスティング | 既存パターン流用 (バケット分離) |
| ADR-018 | Course-Lesson 階層 | 準拠 (Lesson に embedded) |
| ADR-019 | 動画完了がテストアクセスをゲート | 同方針 (テスト合格が DL をゲート) |
| ADR-024 | マスターコンテンツ配信 | 改訂対象 (PDF も同方針追記) |
| ADR-025 | セキュリティ強化 | 短期署名 URL / 認可ログ |
| ADR-028 | DataSource テスト戦略 | 準拠 (InMemoryDataSource 中心) |
| ADR-029 | タイムゾーン基準 | 準拠 (videoAccessUntil 比較) |
| ADR-036 (新規) | 講座資料 PDF 配信 | 本機能の決定事項を記録 |

## 12. 設計承認履歴

| Phase | セクション | 日付 | 承認 |
|---|---|---|---|
| Phase 3 Q1 | PDF スコープ = レッスン単位 | 2026-05-17 | ✅ |
| Phase 3 Q2 | UI 配置 = レッスン詳細/一覧で合格後常設 | 2026-05-17 | ✅ |
| Phase 3 Q3 | 管理権限 = super-admin のみ | 2026-05-17 | ✅ |
| Phase 3 Q4 | DL 期限 = videoAccessUntil まで | 2026-05-17 | ✅ |
| Phase 4 | 案 A: Lesson embedded + 新 GCS バケット | 2026-05-17 | ✅ |
| Phase 5/1 | アーキテクチャ | 2026-05-17 | ✅ |
| Phase 5/2 | データモデル | 2026-05-17 | ✅ |
| Phase 5/3 | API/関数境界 | 2026-05-17 | ✅ |
| Phase 5/4 | エラー処理 | 2026-05-17 | ✅ |
| Phase 5/5 | テスト戦略 | 2026-05-17 | ✅ |
