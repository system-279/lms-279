# 講座資料 PDF DL 機能 smoke test runbook (2026-05-17)

**対象機能**: ADR-036 講座資料スライド PDF 配信 (PR #410)
**目的**: 本番 Cloud Run 上で機能の end-to-end 動作を「smoke 専用リソースに封じ込めた」状態で検証し、実コンテンツ投入前に正常動作を確認する
**ステータス**: Draft — 実行待ち

## 1. 前提

### 1.1 完了済み (2026-05-17)

- GCS バケット `gs://lms-279-resources` 作成 (asia-northeast1, UBLA, public access prevention)
- IAM: Cloud Run default compute SA `1034821634012-compute@developer.gserviceaccount.com` に `roles/storage.objectAdmin` を bucket scope で付与
- Cloud Run api サービス env: `GCS_RESOURCE_BUCKET=lms-279-resources` (revision `api-00289-987`)
- `.github/workflows/deploy.yml` ENV_VARS にも反映済み (PR #410)

### 1.2 ユーザー側で必要なもの

| # | 項目 | 取得方法 |
|---|---|---|
| 1 | super-admin の Firebase ID Token | 後述「2. Bearer Token 取得手順」 |
| 2 | smoke 用受講者アカウント (Firebase Auth) | 既存 demo 系テナントの受講者 or 新規作成 |
| 3 | 受講者の Firebase ID Token | 後述「2.」と同じ手順 |
| 4 | smoke 用テナント ID | 既存の検証用テナント (例: `demo`、`8vexhzpc` 等の本番テナントは避ける) |
| 5 | smoke 用 PDF ファイル | 任意の透かし入り PDF (数 KB ~ 数 MB、個人情報なし) |
| 6 | curl コマンド実行環境 | macOS Terminal / Linux shell |

### 1.3 API ベース URL

```
https://api-3zcica5euq-an.a.run.app/api/v2
```

## 2. Bearer Token 取得手順

### 2.1 super-admin

1. 本番 Web (https://web-3zcica5euq-an.a.run.app) を Chrome で開き super-admin アカウントでログイン
2. DevTools (`F12` or `⌥⌘I`) → Console タブ
3. 以下を実行:

   ```javascript
   await firebase.auth().currentUser.getIdToken(true)
   ```

   または Firebase SDK の global 公開がない場合:

   ```javascript
   const { getAuth } = await import("firebase/auth");
   await getAuth().currentUser.getIdToken(true);
   ```

4. 出力された JWT 文字列をコピー → `export SUPER_TOKEN="eyJ..."` でシェル変数化

### 2.2 受講者

同様に受講者アカウントで本番 Web にログイン → DevTools で実行 → `export USER_TOKEN="eyJ..."`

> **注意**: ID Token は 1 時間で expire。途中で 401 が出たら再取得して `export` し直す

## 3. smoke リソース命名規約

| リソース | 命名例 | 理由 |
|---|---|---|
| マスターコース名 | `[SMOKE] PDF配信検証 2026-05-17` | UI 一覧で本番講座と即時識別可能 |
| レッスン title | `[SMOKE] レッスン1` | 同上 |
| Quiz title | `[SMOKE] 検証用テスト` | 同上 |
| PDF ファイル名 | `smoke-test-2026-05-17.pdf` | GCS path から smoke と特定可能 |

## 4. 環境変数の事前設定

以下を一括で `export` (実行前に値を埋める):

```bash
export API_BASE="https://api-3zcica5euq-an.a.run.app/api/v2"
export SUPER_TOKEN="eyJ..."          # 2.1 で取得
export USER_TOKEN="eyJ..."           # 2.2 で取得
export SMOKE_TENANT="demo"           # smoke 用テナント ID (実テナントは避ける)
export SMOKE_PDF_PATH="$HOME/Desktop/smoke-test-2026-05-17.pdf"  # ローカルにダミー PDF
```

## 5. 実行ステップ (順次、各 step のレスポンスから次の値を抽出)

### Step 1: smoke 専用マスターコース作成

```bash
curl -X POST "$API_BASE/super/master/courses" \
  -H "Authorization: Bearer $SUPER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"[SMOKE] PDF配信検証 2026-05-17","description":"smoke test only, will be deleted","passThreshold":50}'
```

**期待レスポンス (201)**:
```json
{"course":{"id":"<COURSE_ID>","name":"[SMOKE] PDF配信検証 2026-05-17",...}}
```

→ `export SMOKE_COURSE_ID="<COURSE_ID>"`

### Step 2: smoke 用レッスン作成

```bash
curl -X POST "$API_BASE/super/master/courses/$SMOKE_COURSE_ID/lessons" \
  -H "Authorization: Bearer $SUPER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"[SMOKE] レッスン1"}'
```

**期待レスポンス (201)**: `{"lesson":{"id":"<LESSON_ID>","title":"[SMOKE] レッスン1","hasVideo":false,"hasQuiz":false,...}}`

→ `export SMOKE_LESSON_ID="<LESSON_ID>"`

### Step 3: smoke 用 Quiz 作成 (動画なしレッスンで合格を成立させる)

```bash
curl -X POST "$API_BASE/super/master/lessons/$SMOKE_LESSON_ID/quiz" \
  -H "Authorization: Bearer $SUPER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title":"[SMOKE] 検証用テスト",
    "passThreshold":50,
    "requireVideoCompletion":false,
    "questions":[{
      "type":"single_choice",
      "text":"smoke test 用の自明問題",
      "choices":[{"id":"a","text":"正解"},{"id":"b","text":"不正解"}],
      "correctChoiceId":"a",
      "points":100
    }]
  }'
```

**期待レスポンス (201)**: `{"quiz":{"id":"<QUIZ_ID>",...}}`

→ `export SMOKE_QUIZ_ID="<QUIZ_ID>"`

> **重要**: `requireVideoCompletion: false` を必ず指定。動画なしレッスンで quiz 受験可能にする

### Step 4: smoke PDF アップロード URL を発行

```bash
SIZE=$(stat -f%z "$SMOKE_PDF_PATH" 2>/dev/null || stat -c%s "$SMOKE_PDF_PATH")
curl -X POST "$API_BASE/super/master/lessons/$SMOKE_LESSON_ID/pdf-upload-url" \
  -H "Authorization: Bearer $SUPER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"fileName\":\"smoke-test-2026-05-17.pdf\",\"contentType\":\"application/pdf\",\"sizeBytes\":$SIZE}"
```

**期待レスポンス (200)**:
```json
{"uploadUrl":"https://storage.googleapis.com/...","gcsPath":"lessons/<SMOKE_LESSON_ID>/<timestamp>_<uuid>_smoke-test-2026-05-17.pdf","expiresAt":"..."}
```

→ `export UPLOAD_URL="<uploadUrl>"`
→ `export SMOKE_GCS_PATH="<gcsPath>"`

### Step 5: GCS へ PDF を直接 PUT

```bash
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: application/pdf" \
  --data-binary "@$SMOKE_PDF_PATH"
```

**期待**: HTTP 200、レスポンス body は空 (GCS の正常完了)

### Step 6: アップロード確認 + Firestore メタ書込み

```bash
curl -X POST "$API_BASE/super/master/lessons/$SMOKE_LESSON_ID/pdf" \
  -H "Authorization: Bearer $SUPER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"gcsPath\":\"$SMOKE_GCS_PATH\",\"fileName\":\"smoke-test-2026-05-17.pdf\",\"sizeBytes\":$SIZE}"
```

**期待レスポンス (200)**:
```json
{"resource":{"pdfFileName":"smoke-test-2026-05-17.pdf","pdfSizeBytes":<実サイズ>,"pdfUpdatedAt":"..."}}
```

> サーバーは実 GCS metadata を信頼するため `sizeBytes` がリクエスト値と異なれば 400 `file_too_large` 等が返る (Codex High #2 対策)

### Step 7: マスターコース公開

```bash
curl -X PATCH "$API_BASE/super/master/courses/$SMOKE_COURSE_ID/publish" \
  -H "Authorization: Bearer $SUPER_TOKEN"
```

**期待レスポンス (200)**: `{"course":{"status":"published",...}}`

### Step 8: smoke テナントへ配信

```bash
curl -X POST "$API_BASE/super/master/distribute" \
  -H "Authorization: Bearer $SUPER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"courseIds\":[\"$SMOKE_COURSE_ID\"],\"tenantIds\":[\"$SMOKE_TENANT\"]}"
```

**期待レスポンス (200)**: `{"results":[{"tenantId":"<SMOKE_TENANT>","courseId":"<新 tenant courseId>","status":"distributed",...}]}`

→ `export TENANT_COURSE_ID="<新 tenant courseId>"`
→ `export TENANT_LESSON_ID=` で TenantSide のレッスン ID を別途確認 (`GET /api/v2/$SMOKE_TENANT/courses/$TENANT_COURSE_ID/lessons` 等)

### Step 9: 受講者ロールで Quiz 受験 → 合格

具体の attempt 開始/送信 endpoint は `docs/api.md` の Quiz セクション参照。流れ:

```bash
# 9a. attempt 開始
curl -X POST "$API_BASE/$SMOKE_TENANT/lessons/$TENANT_LESSON_ID/quiz/attempts" \
  -H "Authorization: Bearer $USER_TOKEN"
# → {"attemptId":"<ATTEMPT_ID>",...}

# 9b. attempt 提出 (Step 3 の correctChoiceId="a" を選ぶ)
curl -X POST "$API_BASE/$SMOKE_TENANT/quiz-attempts/<ATTEMPT_ID>/submit" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"answers":[{"questionId":"<Q_ID>","choiceId":"a"}]}'
# → {"score":100,"passed":true}
```

**期待**: `passed: true`

### Step 10: PDF DL URL 取得 (合格後)

```bash
curl "$API_BASE/$SMOKE_TENANT/lessons/$TENANT_LESSON_ID/pdf-download" \
  -H "Authorization: Bearer $USER_TOKEN"
```

**期待レスポンス (200)**:
```json
{"url":"https://storage.googleapis.com/...","fileName":"smoke-test-2026-05-17.pdf","expiresAt":"..."}
```

→ 取得した `url` をブラウザで開き、smoke PDF が DL されることを確認

### Step 11 (オプション): 失敗ケース確認

#### 11a. 別アカウント (未合格) で 403

```bash
curl "$API_BASE/$SMOKE_TENANT/lessons/$TENANT_LESSON_ID/pdf-download" \
  -H "Authorization: Bearer <別の未合格受講者 Token>"
```

**期待**: 403 `quiz_not_passed`

#### 11b. lessonId を別テナントのものに置換 (列挙攻撃対策確認)

```bash
curl "$API_BASE/$SMOKE_TENANT/lessons/<他テナントの lessonId>/pdf-download" \
  -H "Authorization: Bearer $USER_TOKEN"
```

**期待**: 404 `lesson_not_found` (403 と区別しないことで列挙不能)

## 6. クリーンアップ

smoke 検証が完了したら以下を順次実行:

```bash
# 6.1 マスターレッスンの PDF メタ削除 (GCS object は orphan に残る → 別途 cleanup ジョブ)
curl -X DELETE "$API_BASE/super/master/lessons/$SMOKE_LESSON_ID/pdf" \
  -H "Authorization: Bearer $SUPER_TOKEN"

# 6.2 配信先テナントの smoke コース削除 (テナント管理者 admin endpoint)
#     → admin API の course/lesson 削除 endpoint を使う、または Firestore コンソールから手動削除

# 6.3 マスターコース削除 (関連 lessons / quiz / video も一括削除)
curl -X DELETE "$API_BASE/super/master/courses/$SMOKE_COURSE_ID" \
  -H "Authorization: Bearer $SUPER_TOKEN"

# 6.4 (任意) GCS object 手動削除
gcloud storage rm "gs://lms-279-resources/$SMOKE_GCS_PATH"
```

> **note**: master 側 PDF 削除では GCS object は残す設計 (Codex High #1、配信済みテナント保護)。smoke では tenant 側も即削除するので 6.4 で明示的に GCS object も削除する

## 7. 完了判定 (Definition of Done)

以下全て成立で smoke 合格:

- [ ] Step 6 で `pdfFileName`, `pdfSizeBytes`, `pdfUpdatedAt` が Firestore に書込まれ resource として返る
- [ ] Step 8 で 配信先テナントのレッスンに pdfGcsPath が伝播 (`GET /$SMOKE_TENANT/lessons/$TENANT_LESSON_ID` で `resource?.pdfFileName === "smoke-test-2026-05-17.pdf"`)
- [ ] Step 10 で signed URL 200 取得 + 実際に PDF がブラウザで DL できる
- [ ] Step 11a で 403 `quiz_not_passed` を返す
- [ ] Step 11b で 404 `lesson_not_found` を返す (403 と区別なし)
- [ ] クリーンアップ後、`GET /$SMOKE_TENANT/courses` から smoke コースが消えている

## 8. 失敗時の切り分け

| 症状 | 確認場所 | 対処 |
|---|---|---|
| Step 4-6 で 500 / 403 | Cloud Logging の api サービス | IAM 設定 (objectAdmin bucket scope) 確認、signBlob 権限が必要なら `roles/iam.serviceAccountTokenCreator` 付与検討 |
| Step 5 PUT で 403 | UPLOAD_URL の expiresAt 過ぎ | Step 4 から再取得 |
| Step 5 PUT で 400 | Content-Type が `application/pdf` か | header 確認 |
| Step 8 配信失敗 | smoke テナントが存在するか | `GET /$API_BASE/super/tenants` で確認、なければ事前作成 |
| Step 9b 提出で 400 | `correctChoiceId` 不一致 / quiz 仕様の差 | Step 3 で作った quiz schema を `docs/api.md` quizzes 章と照合 |
| Step 10 で 403 `quiz_not_passed` | Step 9 が成功していない | quiz_attempts 再実行、`user_progress` doc を Firestore コンソールで確認 |
| Step 10 で 403 `access_expired` | `TenantEnrollmentSetting.videoAccessUntil` の値 | smoke テナント `_config` doc を Firestore コンソールで確認、過去日なら未来日に更新 |
| Step 10 で 404 `resource_not_found` | Step 6 confirm 失敗 / Step 8 配信が PDF メタを伝播していない | Firestore で master / tenant 両方の lesson doc を確認 |

## 9. 監査ログ確認

検証完了後、以下を Cloud Logging で確認:

```
resource.type="cloud_run_revision"
resource.labels.service_name="api"
jsonPayload.message=~"pdf_uploaded|pdf_downloaded|pdf_download_denied"
```

`pdf_uploaded` (Step 6) と `pdf_downloaded` (Step 10) が記録されていること。

## 10. 進行管理

実行時は本セッションの AI と協調進行:

1. 各 step を実行
2. レスポンス全文を AI に貼る
3. AI が期待値と照合 + 次の export 文を生成
4. 失敗時は §8 切り分け表を参照しつつ AI に状況共有

## 関連リンク

- ADR-036: `docs/adr/ADR-036-course-resource-pdf-distribution.md`
- 設計仕様: `docs/specs/2026-05-17-course-pdf-download-design.md`
- PR #410: https://github.com/system-279/lms-279/pull/410
- 環境セットアップ完了の経緯: `docs/handoff/LATEST.md` §Superseded note (2026-05-17)
