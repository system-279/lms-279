# ADR-036: 講座資料スライド PDF 配信

## ステータス
採用 (2026-05-17) / 上限 150 MB に改訂 (2026-06-18) / 上限 300 MB に再改訂 (2026-06-19)

## コンテキスト

受講者から「動画視聴後の復習用にスライド資料を参照したい」要望が継続的に発生。動画 (60-80 分) を再視聴するよりスライド PDF で要点を素早く確認できる方が学習効率が高い。Session 28 オーダー② として要件化された。

## 決定事項

### スコープ

- レッスン単位 (1 レッスン 1 PDF)、最大 300 MB (2026-06-19 改訂: 旧 150 MB。230 MB 超のスライド資料を添付したい現場要望が発生したため再度引き上げ。2026-06-18 改訂: 50 MB → 150 MB)
- 受講者は当該レッスンのテスト合格 (`user_progress.quizPassed === true`) + 受講期間内 (`TenantEnrollmentSetting.videoAccessUntil > now`) でダウンロード可能
- super-admin が `_master` テナント配下でアップロード/差し替え/削除 (一元管理)
- マスター→テナント配信時に PDF メタ (`pdfGcsPath` / `pdfFileName` / `pdfSizeBytes` / `pdfUpdatedAt`) をディープコピー、GCS ファイル本体は全テナントで共有 (ADR-024 と同方針)
- DL 期限は `videoAccessUntil` (受講開始 +1 年) に同期、終了後は UI ボタン hide

### データモデル拡張

`lessons` コレクションに以下 4 フィールドを追加 (全 optional):

```
pdfGcsPath?: string     // 例: "lessons/{masterLessonId}/{timestamp}_{fileName}.pdf"
pdfFileName?: string    // 受講者 DL 時の Content-Disposition で使用
pdfSizeBytes?: number   // UI 表示用
pdfUpdatedAt?: string   // ISO 8601、監査・追跡用
```

### GCS バケット

- 新規バケット `lms-279-resources` (動画バケットと分離して IAM/lifecycle/監査を独立管理)
- env: `GCS_RESOURCE_BUCKET` (default `lms-279-resources`)
- パス規約: `lessons/{masterLessonId}/{timestamp}_{sanitizedFileName}.pdf`

### API エンドポイント

**super-admin (`/api/v2/super/master/*`)**:
- `POST /master/lessons/:lessonId/pdf-upload-url` — 署名 PUT URL 発行 (1 時間有効)
- `POST /master/lessons/:lessonId/pdf` — upload 確認 + メタ書込み
- `DELETE /master/lessons/:lessonId/pdf` — メタクリア + GCS 削除
- `POST /master/courses/:courseId/sync-resources` — 既存配信先テナントへ遡及反映

**受講者 (`/api/v2/:tenant/*`)**:
- `GET /lessons/:lessonId` — レッスン詳細 (`resource?: LessonResource` 含む、`pdfGcsPath` は除外)
- `GET /lessons/:lessonId/pdf-download` — 認可後の短期署名 URL (15 分有効) を JSON で返す

### エラー処理

`{ error, message }` フラット形式 (ADR-010)。`gcs_unavailable` のみ transient (FE retry-after)、他は permanent。列挙攻撃対策: 他テナントの lessonId は `404 lesson_not_found` で統一。

### 削除順序

`deletePdfResource`: Firestore メタ削除 → GCS 削除 の順 (状態復旧優先)。GCS 削除失敗時は orphan として残し、別途 cleanup ジョブで対応可能。

## 根拠

- ADR-024 (マスター配信、コピー型) と同方針: 既存パターン流用で実装コスト最小、運用一貫性確保
- ADR-018 (Course-Lesson 階層): Lesson に embedded フィールドが階層と整合
- ADR-019 (動画→テストゲート): テスト合格を DL ゲートにする同方針
- 案 C (lesson_resources 新コレクション) は将来の複数ファイル対応の足場だが、現要件 (1 PDF) では YAGNI

## 影響

- 新規 GCS バケット作成 + IAM 設定が必要 (super-admin SA write, API SA read)
- `lessons` 型に 4 フィールド追加 (全 optional、既存データ未破壊)
- `course-distributor.ts` で PDF メタコピー処理を追加
- super-admin UI は本 PR では未実装、API 経由 (curl/Postman) で運用可能。完全 UI 化は別 Issue で後追い

## 関連 ADR

- ADR-010 (エラー形式)
- ADR-013 (GCS 動画ホスティング、バケット分離方針)
- ADR-018 (Course-Lesson 階層)
- ADR-019 (動画→テストゲート)
- ADR-024 (マスター配信、ディープコピー同方針)
- ADR-025 (セキュリティ強化、短期署名 URL)
- ADR-028 (DataSource テスト戦略)
- ADR-029 (タイムゾーン、`videoAccessUntil` 比較)

## 検討した代替案

- **同期型配信**: マスター更新がテナントへ自動反映 → 複雑性が高く、テナント独自編集と競合 (ADR-024 不採用と同理由)
- **lesson_resources 新コレクション**: 将来 N 種類リソース対応の足場 → 現要件 1 PDF に過剰、YAGNI
- **既存 videos バケット共存**: バケット新設不要 → 動画と資料の IAM/lifecycle/監査が prefix だけで境界曖昧化、運用上不利
- **DL 期限を `quizAccessUntil` (+2 ヶ月)**: テスト受験期間と一致しシンプル → 復習用途には短い、棄却
- **テナント管理者の差し替え権**: ADR-024 の「コピー後は自由編集」を踏襲 → 現運用は中央集権コンテンツ、UI/メンタルモデル複雑化、棄却
