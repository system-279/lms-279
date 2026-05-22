# DXcollege 自動完了通知システム 設計仕様書

| 項目 | 値 |
|---|---|
| 起票日 | 2026-05-20 |
| 改訂日 | 2026-05-21 (ADR-037 OQ-2 RESOLVED 反映、SendAs 案 X 採用) / 2026-05-20 (Codex セカンドオピニオン反映) |
| 関連 ADR (追加) | ADR-037 (送信元 impersonation: SendAs) |
| 起票者 | 本田様 (要件) / system-279 (設計) |
| 関連 ADR | ADR-026 (DWD) / ADR-029 (JST) / ADR-034 (Phase 2 Gmail 下書き) |
| 関連 PR | #434 (Phase 2 Gmail 下書き、Manual flow、本機能と独立) |
| brainstorm 結果 | Phase 1-5 全承認済、Phase 7-8 改訂中 |
| 処理フロー図 | [docs/specs/2026-05-20-completion-notification-flow.mmd](./2026-05-20-completion-notification-flow.mmd) |

---

## 1. 概要 / 動機

### 1.1 背景

既存 PR #434「受講者進捗 PDF Gmail 下書き作成」は、スーパー管理者が画面でボタン押下し、押した管理者個人の Gmail に**下書き**を作成する**手動フロー**である。

現場 (本田様) より以下 4 つの追加要件:

1. 送信元 `From:` ヘッダを `dxcollege@279279.net` (Google Group エイリアス) に固定
   - 当初は DWD `subject=dxcollege@279279.net` で impersonation する設計だったが、OQ-2 smoke (2026-05-21) で Group エイリアスへの DWD impersonation 不可と確定。**ADR-037 採用案 X (SendAs) に移行**: DWD subject = 実ユーザー mailbox (`system@279279.net`)、Gmail SendAs で From を `dxcollege@279279.net` に偽装する
2. 指定曜日・時刻で**自動送信**
3. テナントごとの担当者 CC を**複数件**指定可能に
4. **全コース 100% 完了** した受講者のみ、**1 度だけ** 完了通知メールを自動送信

### 1.2 目的

既存の手動 Gmail 下書き機能 (PR #434) と完全に独立した**自動完了通知レーン**を新設する。

### 1.3 既存機能との関係 (重要)

```
[既存] スーパー管理者が画面でボタン → Gmail 下書き (個人 OAuth, gmail.compose)  ← 維持
[新規] 自動完了通知 (Cloud Scheduler → DWD なりすまし送信)                      ← 追加
```

両者は別ファイル・別 routes・別 collection で完全分離する。

---

## 2. 要件

### 2.1 機能要件

| ID | 要件 |
|---|---|
| FR-1 | Cloud Scheduler が毎時 00 分 (JST) に起動し、内部 API を呼ぶ |
| FR-2 | API は `super_dispatch_settings/global` の `enabled` / `scheduleDaysOfWeek` / `scheduleHourJst` と JST 現在時刻を照合し、一致時のみ配信処理を実行 |
| FR-3 | 全テナントを直列、テナント内 user を並列度 8 で走査 |
| **FR-4 (改訂)** | **published コース全件**を母集合とし、各 courseId に対して `course_progress.isCompleted=true` かつ `totalLessons` が現行 `lessonOrder.length` と一致することを 100% 完了条件とする。`course_progress` doc が存在しない course は未着手扱い (Codex Critical-2) |
| **FR-5 (改訂)** | DWD なりすまし送信 (`subject=DXCOLLEGE_DISPATCH_SUBJECT` env、Gmail mailbox を持つ実ユーザー、初期値 `system@279279.net`)、専用 scope `gmail.send`、From ヘッダは `DXCOLLEGE_SENDER_EMAIL` (`dxcollege@279279.net`) を SendAs 経由で偽装する (ADR-037 案 X) |
| FR-6 | `To` = 受講者本人、`Cc` = `ownerEmail` + `tenants/{tenantId}.notificationCcEmails` (各 email を個別 validate、重複排除) |
| **FR-7 (改訂)** | **送信前に Firestore transaction で `completion_notifications/{userId}` を `reserved` 状態で create**。取得できた worker のみ Gmail 送信。送信成功後に `sent` に更新 (Codex Critical-1+3) |
| FR-8 | スーパー管理者が `/super/dispatch-settings` で設定編集、配信履歴閲覧、ドライラン、テスト送信を実行可能 |
| FR-9 | テナントごとの `notificationCcEmails` をスーパー管理者が編集可能 (chips UI、上限 10 件) |
| FR-10 | kill switch (`enabled: false`) は次回 cron 起動時に即時反映 |
| **FR-11 (新規)** | **run-level lock**: 同一時刻に Cloud Scheduler 重複起動された場合、`super_dispatch_runs/{runId}` を Firestore transaction で create することで二重実行を防止 (Codex Important-3) |
| **FR-12 (新規)** | **completion_notifications には `courseIdsSnapshot: string[]` / `publishedCourseCount: number` を保存**し、後の問い合わせで「どの時点の全コースか」が追跡可能 (Codex Important-5) |

### 2.2 非機能要件

| ID | 要件 |
|---|---|
| NFR-1 | PII 最小化: recipient email は sha256 ハッシュで保存 (ADR-034 踏襲) |
| NFR-2 | 認証: 内部 API は OIDC ID Token、スーパー管理者 API は既存 super-admin auth (Firebase Bearer Token、CSRF 不要) |
| **NFR-3 (改訂)** | **二重送信防止: pre-send reservation を transaction で実施。reservation 取得→Gmail 送信→sent 更新の順。reservation 取得後に Gmail 送信失敗した場合は transient なら reservation 維持、permanent なら failed_permanent に更新。lease 期限切れの reserved は manual_review_required に降格** (Codex Critical-1+3) |
| NFR-4 | audit_logs は Firestore TTL Policy で 1 年自動削除 |
| NFR-5 | user 1 件あたりの PDF 生成は 30 秒 timeout、超過時は user スキップ |
| NFR-6 | 設定変更は楽観的ロック (version フィールド)、競合時 409 |
| NFR-7 | test-send は 1 日 50 件レート制限、**固定ダミーデータ + 添付なし** (本番 PII 複製を防止、Codex Important-8) |
| NFR-8 | 送信元 email は Cloud Run 環境変数 `DXCOLLEGE_SENDER_EMAIL` で固定 (Secret Manager 不使用、機密性なし) |
| NFR-9 | DWD SA キーは既存 Secret Manager `dwd-workspace-key` を継承。**`gmail.send` scope は専用 client (`getGmailClientForSender`) に分離し、既存共通 `SCOPES` に追加しない** (Codex Important-1) |
| NFR-10 | 既存の手動 Gmail 下書き機能 (PR #434) の動作には一切影響を与えない |
| **NFR-11 (新規)** | **PII sanitize: `sanitizeErrorForAudit()` で email 正規表現・MIME headers・access token 断片を除去してから audit_logs / Error Reporting に渡す** (Codex Important-7) |

---

## 3. アーキテクチャ

### 3.1 システム全体図

```
┌─────────────────────────────────────────────────────┐
│          Cloud Scheduler (asia-northeast1)          │
│  cron: "0 * * * *"                                  │
│  time-zone: "Asia/Tokyo"                            │
│  → 毎時 JST 00 分に起動                              │
│  Service Account: dxcollege-scheduler@lms-279.iam   │
└─────────────────────────────────────────────────────┘
                    │ HTTP POST + OIDC ID Token
                    │ audience = endpoint URL
                    ▼
┌─────────────────────────────────────────────────────┐
│       Cloud Run: services/api (既存 Cloud Run 統合)  │
│  POST /api/internal/dispatch/run-completion-notifications│
│                                                     │
│  ① OIDC verify (audience match)                     │
│  ② super_dispatch_runs/{runId} create (run lock)    │  ← FR-11 新規
│  ③ super_dispatch_settings/global 読み取り          │
│  ④ enabled & スケジュール JST 一致判定              │
│  ⑤ テナント走査 (直列)                              │
│  ⑥ users 走査 (並列度 8)                            │
│  ⑦ published コース全件母集合で 100% 判定           │  ← FR-4 改訂
│  ⑧ completion_notifications/{userId} reserve        │  ← FR-7 改訂
│      (Firestore transaction、create-if-not-exists)  │
│  ⑨ PDF 生成 (既存 ProgressPdfDocument 流用、30 秒) │
│  ⑩ Gmail 送信 (DWD なりすまし、専用 client)         │  ← NFR-9 改訂
│  ⑪ completion_notifications を sent に更新          │
│  ⑫ super_dispatch_audit_logs 書込 (PII sanitize 済) │
│  ⑬ super_dispatch_runs を completed に更新          │
└─────────────────────────────────────────────────────┘
                    │ DWD JWT (subject=DXCOLLEGE_DISPATCH_SUBJECT 実 mailbox、scope=gmail.send)
                    │ MIME From=DXCOLLEGE_SENDER_EMAIL (SendAs 経由)
                    ▼
┌─────────────────────────────────────────────────────┐
│        Gmail API                                    │
│  gmail.users.messages.send                          │
└─────────────────────────────────────────────────────┘
```

### 3.2 cron スケジュール戦略

Cloud Scheduler は固定で JST 毎時 00 分起動 (`time-zone: Asia/Tokyo`)。配信スケジュールの**柔軟性は DB 設定で実現**:

| 種類 | 値 | 説明 |
|---|---|---|
| Cloud Scheduler cron | `0 * * * *` + `time-zone: Asia/Tokyo` | 起動間隔は変更しない |
| `scheduleDaysOfWeek` | `number[]` (0-6) | DB で曜日を指定 |
| `scheduleHourJst` | `number` (0-23) | DB で時刻 (時単位、HH:00) を指定 |
| 一致判定 | API 内で実装 | 起動時刻 (JST) と DB 値を比較 |

これにより Cloud Scheduler を頻繁にいじる必要がなく、UI から柔軟にスケジュール変更可能。

### 3.3 並列度と Cloud Run 制限

| 階層 | 並列度 | 根拠 |
|---|---|---|
| テナント間 | 直列 | 現状 2 テナント、ログ可読性優先 |
| テナント内 user | 8 | 既存 `progress-pdf.ts` `LESSON_FETCH_CONCURRENCY` と同値、Firestore quota 配慮 |
| user 内 (PDF 生成 + Gmail send) | 順次 | 依存関係あり |

Cloud Run 実行制限は 300 秒。テナント数・user 数増加でこの制限に近づいたら、**Critical-1 race を増幅するため `super_dispatch_runs` の lease + checkpoint** で `runId` 単位の resume 可能設計に拡張する (Phase 1 では非対応、将来課題)。

### 3.4 サービス配置

既存 `services/api` に統合 (新規サービス分離せず)。将来 SLA 分離が必要になれば `services/notification-dispatch` への切り出しを検討。

---

## 4. データモデル

### 4.1 新規 / 拡張 Firestore コレクション

#### 4.1.1 `super_dispatch_settings/global` (新規、固定 doc id)

```typescript
{
  enabled: boolean;                            // kill switch
  scheduleDaysOfWeek: number[];                // 0-6 (日-土)
  scheduleHourJst: number;                     // 0-23
  signatureName: string;                       // default: "DXcollege運営スタッフ"
  completionMessageBody: string;               // default: 「受講お疲れ様でした。…」
  updatedAt: Timestamp;
  updatedBy: string;                           // superAdmin email (raw、監査責任明示)
  version: number;                             // 楽観的ロック
}
```

#### 4.1.2 `tenants/{tenantId}` (既存、フィールド追加)

```typescript
{
  // ... 既存フィールド (name, ownerEmail, etc.)
  notificationCcEmails: string[];              // 追加 CC、上限 10 件、空配列なら CC = ownerEmail のみ
  completionNotificationEnabled: boolean;      // テナント単位の有効化フラグ、default true
}
```

#### 4.1.3 `tenants/{tenantId}/completion_notifications/{userId}` (新規 sub-collection、改訂)

```typescript
{
  userId: string;

  // === reservation state (Codex Critical-1+3) ===
  status: "reserved" | "sent" | "failed_permanent" | "manual_review_required";
  runId: string;                               // 予約した cron 実行 ID
  reservedAt: Timestamp;                       // reserve 時刻
  leaseExpiresAt: Timestamp;                   // reservedAt + 10 分。期限切れで manual_review に降格

  // === sent state (status=sent のみ) ===
  notifiedAt: Timestamp | null;
  messageId: string | null;                    // Gmail API レスポンス

  // === failed state (status=failed_permanent のみ) ===
  errorCode: string | null;                    // sanitized
  errorMessage: string | null;                 // sanitized (Codex Important-7)
  failedAt: Timestamp | null;

  // === snapshot (Codex Important-5) ===
  progressSnapshot: {
    completedLessons: number;
    totalLessons: number;
    coursesCompleted: number;
    coursesTotal: number;
  };
  courseIdsSnapshot: string[];                 // 通知時点の published course ID 一覧
  publishedCourseCount: number;                // courseIdsSnapshot.length と同値、検索高速化用

  // === PII 最小化 (ADR-034 踏襲) ===
  recipientToHash: string;                     // sha256
  recipientCcHashes: string[];                 // sha256 配列
  pdfSizeBytes: number | null;
}
```

#### 4.1.4 `super_dispatch_runs/{runId}` (新規、run-level lock)

```typescript
{
  runId: string;                               // uuid v4
  triggeredAt: Timestamp;                      // cron 起動時刻
  status: "running" | "completed" | "timeout" | "aborted";
  leaseExpiresAt: Timestamp;                   // triggeredAt + 280 秒 (Cloud Run 300 秒に余裕)
  processedTenants: number;
  sent: number;
  skipped: number;
  failed: number;
  abortedReason: string | null;                // 403 全体中断時の理由等
  ttlExpireAt: Timestamp;                      // triggeredAt + 365 days
}
```

#### 4.1.5 `super_dispatch_audit_logs/{auditId}` (新規、グローバル collection)

```typescript
{
  runId: string;
  runStartedAt: Timestamp;
  eventType: "run_started" | "run_completed" | "run_aborted"
           | "user_reserved" | "user_notified" | "user_skipped"
           | "user_failed_transient" | "user_failed_permanent"
           | "manual_review_required"
           | "settings_updated" | "test_send" | "dry_run"
           | "orphan_send";                    // 二重送信リスク発生
  tenantId: string | null;
  userId: string | null;
  errorCode: string | null;
  errorMessage: string | null;                 // sanitizeErrorForAudit() 済み (NFR-11)
  durationMs: number | null;
  createdAt: Timestamp;
  ttlExpireAt: Timestamp;                      // createdAt + 365 days、Firestore TTL Policy
}
```

### 4.2 受講者通知の状態遷移 (改訂)

```
[None] (completion_notifications/{userId} 不在)
   │
   ├─ 100% 未達 → スキップ (状態変化なし)
   │
   ├─ 100% 達成 → [Reserved] (status=reserved, runId, leaseExpiresAt セット)
   │      transaction で create-if-not-exists
   │      取得失敗 (既に Reserved/Sent) → スキップ
   │
   │  [Reserved] からの遷移:
   │      ├─ Gmail 送信成功 → [Sent] (status=sent, notifiedAt, messageId)
   │      ├─ Gmail 送信 transient 失敗 → [Reserved] 維持 (次回 cron で再試行可能、leaseExpiresAt まで)
   │      ├─ Gmail 送信 permanent 失敗 (宛先固有) → [FailedPermanent]
   │      └─ lease 期限切れ (Cloud Run timeout 等) → [ManualReviewRequired]
   │            (cron では再送しない、人手介入必要)
   │
   ├─ [Sent] は終端、再送しない (idempotency)
   ├─ [FailedPermanent] は終端、手動 doc 削除で再試行可能
   └─ [ManualReviewRequired] は終端、scripts/recover-manual-review.ts で個別判断
```

### 4.3 「後からコース追加」時の振る舞い

brainstorm Phase 3-1 確定 + Codex Important-5: **案 C (全コース完了で 1 回、以降のコース追加は無視) + courseIdsSnapshot 保存**

- マスター講座配信で新規コースが追加されても、`completion_notifications/{userId}` が存在する受講者には再判定しない
- ただし `courseIdsSnapshot` に通知時点の published course を記録するため、問い合わせ時に「どの時点の全コースか」が説明可能
- 再送したい場合は script (`scripts/clear-failed-notification.ts` 拡張または別 script) 経由で手動 doc 削除

---

## 5. インターフェース (API・関数境界)

### 5.1 新規 API エンドポイント

#### 5.1.1 内部 API (Cloud Scheduler 専用)

| メソッド | パス | 認証 | 入出力 |
|---|---|---|---|
| POST | `/api/internal/dispatch/run-completion-notifications` | OIDC ID Token | 入力なし / 出力 `{ runId, processedTenants, sent, skipped, failed, manualReviewRequired }` |

#### 5.1.2 スーパー管理者 API (既存 super-admin auth、Firebase Bearer Token、CSRF 不要)

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/v2/super/dispatch/settings` | 設定取得 (senderEmail は env から読み取り) |
| PUT | `/api/v2/super/dispatch/settings` | 設定更新 (楽観的ロック、version 不一致で 409) |
| GET | `/api/v2/super/dispatch/audit-logs` | 履歴取得 (フィルタ: tenantId, userId, eventType, from, to) |
| GET | `/api/v2/super/dispatch/runs` | 過去の run 履歴取得 |
| GET | `/api/v2/super/tenants/:tenantId/notification-cc-emails` | テナント CC 設定取得 |
| PUT | `/api/v2/super/tenants/:tenantId/notification-cc-emails` | テナント CC 設定更新 |
| POST | `/api/v2/super/dispatch/dry-run` | 次回 cron で送信される対象一覧返却 (送信なし) |
| POST | `/api/v2/super/dispatch/test-send` | スーパー管理者自身宛に**固定ダミーデータ**でテスト送信 (添付なし、1 日 50 件レート制限) |

### 5.2 モジュール構成 (新規ファイル)

```
services/api/src/
  routes/
    internal/
      dispatch.ts                          # 内部 endpoint
    super/
      dispatch-settings.ts                 # GET/PUT settings
      dispatch-audit-logs.ts               # GET audit_logs
      dispatch-runs.ts                     # GET runs (NEW)
      tenant-notification-cc.ts            # GET/PUT tenant の CC 設定
      dispatch-dry-run.ts                  # POST dry-run
      dispatch-test-send.ts                # POST test-send (固定ダミー)
  services/
    dispatch/
      run-completion-notifications.ts      # メインロジック (Reservation 方式)
      schedule-matcher.ts                  # JST 時刻と settings の照合
      completion-eligibility.ts            # published コース全件母集合判定 (Critical-2)
      completion-notification-mail.ts      # 完了通知メール本文テンプレート
      cc-email-validator.ts                # CC 配列の個別 validation + 重複排除 (Important-6)
      gmail-client.ts                      # getGmailClientForSender (Important-1)、Phase 1 で dispatch/ 配下に確定 (2026-05-22 改訂)
      gmail-dwd-send.ts                    # DWD なりすまし送信
      dispatch-audit.ts                    # audit_logs 書き込み
      dispatch-error-sanitizer.ts          # sanitizeErrorForAudit (Important-7)
      dispatch-403-classifier.ts           # 403 reason 分類 (Important-4)
      reservation.ts                       # pre-send reservation transaction (Critical-1+3)
      run-lock.ts                          # super_dispatch_runs lock (FR-11)
    oidc-verify.ts                         # OIDC token middleware

packages/shared-types/src/
  dispatch.ts                              # 設定・履歴・dry-run の DTO 型

web/app/super/dispatch-settings/
  page.tsx
  components/
    ScheduleEditor.tsx
    TenantCcEditor.tsx                     # chips UI、上限 10 件
    MessageBodyEditor.tsx                  # プレビュー付き
    AuditLogTable.tsx
    RunHistoryTable.tsx                    # run 単位の履歴 (NEW)
    DryRunPanel.tsx
    TestSendButton.tsx                     # 固定ダミーで送信
```

### 5.3 既存ファイルへの変更 (Codex Important-1 反映)

| ファイル | 変更内容 |
|---|---|
| `services/api/src/services/google-auth.ts` | 共通 `SCOPES` は**非変更** (Important-1 維持)。Phase 1 で `GCP_PROJECT_ID` / `DWD_SECRET_NAME` を export 化のみ追加 (2026-05-22)、`dispatch/gmail-client.ts` から DRY で参照させ、プロジェクト名/Secret 名変更時の同期漏れを排除 |
| `services/api/src/services/dispatch/gmail-client.ts` (新規) | `getGmailClientForSender(subjectEmail, fromEmail)`: 専用 JWT (`subject=subjectEmail` 実 mailbox)、scope=`gmail.send` のみ、cache key=`(subject, scope)`。`fromEmail` は MIME From ヘッダ用、SendAs 検証は呼び出し側で実施 (ADR-037 案 X)。`dispatch/` 配下に配置することで他経路 (Drive/Docs/Sheets 等) からの誤利用を構造的に防止 (Important-1 強化、2026-05-22 改訂) |
| `packages/shared-types/src/index.ts` | dispatch types のエクスポート追加 |
| (firestore.rules) | (現状未確認、必要に応じて新規 collection の rules 追加) |

### 5.4 既存 PR #434 への影響: **ゼロ**

`services/api/src/routes/super/progress-pdf-draft.ts` および `services/api/src/services/gmail-draft.ts` には**一切変更を加えない**。新機能は完全に別レーンで実装される。

---

## 6. エラー処理

### 6.1 エラー分類と遷移先

| エラー種別 | 遷移先 | 再試行 | 通知レベル |
|---|---|---|---|
| OIDC verify NG | 401 即返却 | Cloud Scheduler 自動リトライ | access log |
| run lock 取得失敗 (重複起動) | 409 即返却 | Cloud Scheduler retry なし | access log |
| DWD トークン取得失敗 | 全体中断 500、run abort | 次回 cron | Error Reporting (critical) |
| Firestore 読み取り transient | テナント/user スキップ | 次回 cron | audit_logs (warning) |
| users.email 無効 | この user スキップ (Reservation せず) | 修正後の次回 cron | audit_logs + Error Reporting (warning) |
| PDF 生成失敗 / timeout 30s | この user の Reservation を transient_failed として維持 | 次回 cron で再試行可能 (leaseExpiresAt まで) | audit_logs + Error Reporting (warning) |
| **Gmail 401 (token 失効)** | DWD トークン再取得 → 1 回 retry → ダメなら **run 全体中断** | 次回 cron | Error Reporting (critical) |
| **Gmail 403 `insufficientPermissions`** | run 全体中断、未処理 user の Reservation も rollback | 次回 cron | **Error Reporting (critical)** (Codex Important-4) |
| **Gmail 403 `delegation_denied` / sender disabled** | run 全体中断、Reservation rollback | 次回 cron | **Error Reporting (critical)** |
| Gmail 403 宛先固有 | この user を failed_permanent | 再送しない | audit_logs + Error Reporting (warning) |
| Gmail 429/503/timeout | Reservation 維持 (transient_failed)、completion_notifications 残置 | 次回 cron で再試行 | audit_logs (transient) |
| Gmail 400/422 | failed_permanent 記録 | 再送しない | audit_logs + Error Reporting (warning) |
| Reservation transaction 失敗 (既存予約あり) | この user スキップ | 通常運用、エラーではない | audit_logs (skipped_already_reserved) |
| Reservation lease 期限切れ | manual_review_required に降格 | cron では再送しない | audit_logs + Error Reporting (warning) |
| super_dispatch_audit_logs 書き込み失敗 | 警告ログのみ、レスポンスをブロックしない | なし | logger.warn |

### 6.2 二重送信防止の設計 (Reservation 方式、Codex Critical-1+3)

`~/.claude/rules/error-handling.md` §1「状態復旧 > ログ記録 > 通知」に従い、**送信前** に reservation を transaction で書く。これにより複数 worker が同時に「未通知」と判定して並列送信することを防止する。

```typescript
// 擬似コード (services/dispatch/reservation.ts)
async function tryReserveOrSkip(
  tenantId: string,
  userId: string,
  runId: string,
): Promise<{ reserved: boolean; reason?: string }> {
  const docRef = db.doc(`tenants/${tenantId}/completion_notifications/${userId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (snap.exists) {
      const data = snap.data();
      // 既に Sent / FailedPermanent / ManualReview なら通常スキップ
      if (data.status === "sent") return { reserved: false, reason: "already_sent" };
      if (data.status === "failed_permanent") return { reserved: false, reason: "failed_permanent" };
      if (data.status === "manual_review_required") return { reserved: false, reason: "manual_review_required" };
      // Reserved だが lease 期限切れの場合は manual_review_required に降格
      if (data.status === "reserved") {
        const expired = data.leaseExpiresAt.toMillis() < Date.now();
        if (expired) {
          tx.update(docRef, { status: "manual_review_required", failedAt: Timestamp.now() });
          return { reserved: false, reason: "lease_expired_promoted_to_manual_review" };
        }
        return { reserved: false, reason: "currently_reserved_by_other_run" };
      }
    }
    // 新規予約
    tx.set(docRef, {
      userId,
      status: "reserved",
      runId,
      reservedAt: Timestamp.now(),
      leaseExpiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000), // 10 分
      // ... その他のフィールドは送信成功後にセット
    });
    return { reserved: true };
  });
}
```

送信フロー:

```typescript
const { reserved, reason } = await tryReserveOrSkip(tenantId, userId, runId);
if (!reserved) {
  await recordAuditLog({ eventType: "user_skipped", tenantId, userId, errorMessage: reason });
  return;
}

try {
  const messageId = await gmailDwdSend({ ... });
  await docRef.update({
    status: "sent",
    notifiedAt: Timestamp.now(),
    messageId,
    courseIdsSnapshot,
    publishedCourseCount,
    progressSnapshot,
    recipientToHash,
    recipientCcHashes,
    pdfSizeBytes,
  });
  await recordAuditLog({ eventType: "user_notified", ... });
} catch (err) {
  const classification = classifyGmailError(err);  // transient | permanent | scope_revoked
  if (classification === "scope_revoked") {
    throw new RunAbortError("Gmail scope revoked, aborting run");  // run 全体中断
  }
  if (classification === "permanent") {
    await docRef.update({
      status: "failed_permanent",
      errorCode: sanitizeErrorCode(err),
      errorMessage: sanitizeErrorForAudit(err),
      failedAt: Timestamp.now(),
    });
    await recordAuditLog({ eventType: "user_failed_permanent", ... });
  } else {
    // transient: Reservation 維持。次回 cron で再判定 (leaseExpiresAt まで再試行可)
    await recordAuditLog({ eventType: "user_failed_transient", ... });
  }
}
```

### 6.3 run-level lock (FR-11、Codex Important-3)

`super_dispatch_runs/{runId}` を transaction で create し、同時実行を防ぐ:

```typescript
async function acquireRunLock(): Promise<{ runId: string } | null> {
  const runId = crypto.randomUUID();
  const docRef = db.doc(`super_dispatch_runs/${runId}`);

  // 直近 30 秒以内に他の running があれば実行拒否 (Cloud Scheduler 重複起動対策)
  const recentRunningSnap = await db.collection("super_dispatch_runs")
    .where("status", "==", "running")
    .where("leaseExpiresAt", ">", Timestamp.now())
    .limit(1).get();
  if (!recentRunningSnap.empty) return null;

  await docRef.set({
    runId,
    triggeredAt: Timestamp.now(),
    status: "running",
    leaseExpiresAt: Timestamp.fromMillis(Date.now() + 280 * 1000),
    processedTenants: 0, sent: 0, skipped: 0, failed: 0,
    abortedReason: null,
    ttlExpireAt: Timestamp.fromMillis(Date.now() + 365 * 24 * 60 * 60 * 1000),
  });
  return { runId };
}
```

### 6.4 403 reason 分類 (Codex Important-4 + PR #442 review Critical 4+5)

**入力前提**: HTTP 403 専用。429/503/timeout/401 は呼び出し側で別経路に流す。403 以外で呼ぶと例外 throw。

**全体中断対象 reason (`scope_revoked`)** — 設計仕様書管理下の確定リスト:
- `insufficientPermissions`: DWD scope 未反映 / 認可不足
- `delegationDenied`: なりすまし送信が拒否された (subject 設定ミス等)
- `userRateLimitExceeded`: sender 単位の制限超過 (実質 sender disabled)

上記以外 (`recipientRejected` / `forbidden` / `messageRejected` / 未知 reason) は宛先固有 (`user_permanent`)。
仕様書未記載の reason を独断追加することは AI 駆動開発 4 原則 §1 違反のため、変更時は spec 改訂 → 本田様承認 → 実装の順を厳守する。

```typescript
// services/dispatch/dispatch-403-classifier.ts
const SCOPE_REVOKED_REASONS = new Set<string>([
  "insufficientPermissions",
  "delegationDenied",
  "userRateLimitExceeded",
]);

function classifyGmail403(err: unknown): "scope_revoked" | "user_permanent" {
  // PR #442 review Critical 5: HTTP 403 ガード (呼び出し側のバグを早期検知)
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status !== 403) {
    throw new Error(`classifyGmail403 called for non-403 (status=${status ?? "unknown"})`);
  }
  // PR #442 review Critical 4: errors 配列を全件走査 (1 番目だけ見ない)
  const errors = (err as { response?: { data?: { error?: { errors?: Array<{ reason?: unknown }> } } } })
    ?.response?.data?.error?.errors ?? [];
  const hasScopeRevoked = errors.some(
    (e) => typeof e.reason === "string" && SCOPE_REVOKED_REASONS.has(e.reason),
  );
  return hasScopeRevoked ? "scope_revoked" : "user_permanent";
}
```

### 6.5 PII sanitize (NFR-11、Codex Important-7 + PR #442 review Critical 2)

対象 PII / トークン (取りこぼし防止のため広めに redaction):
- email (ASCII 一般形式)
- access token (`ya29.<...>`)
- JWT 3-part (`eyJ<...>.<...>.<...>`) — ID token / Bearer 中身
- refresh token (`1//<...>`)
- API key (`AIza<35 chars>`)
- `Authorization: Bearer <token>`
- MIME headers (`To`/`Cc`/`Bcc`/`From`/`Reply-To`/`Sender`、folded continuation 含む)

UTF-8 マルチバイト境界を割らないよう、置換後に Array.from で grapheme 単位で truncate する。

```typescript
// services/dispatch/dispatch-error-sanitizer.ts
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ACCESS_TOKEN_RE = /ya29\.[A-Za-z0-9_.-]+/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const REFRESH_TOKEN_RE = /1\/\/[A-Za-z0-9_-]+/g;
const API_KEY_RE = /AIza[0-9A-Za-z_-]{35}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9_.-]+/g;
const MIME_HEADER_RE =
  /(?:To|Cc|Bcc|From|Reply-To|Sender):\s*[^\r\n]+(?:\r?\n[ \t][^\r\n]*)*/gi;

function safeTruncate(s: string, maxLength: number): string {
  if (s.length <= maxLength) return s;
  return Array.from(s).slice(0, maxLength).join(""); // UTF-8 safe
}

export function sanitizeErrorForAudit(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // 置換順序: MIME ヘッダ → Bearer → JWT → access_token → refresh_token → API key → email
  // (Bearer の中身が JWT / ya29 の場合があるため Bearer を先に処理)
  const sanitized = raw
    .replace(MIME_HEADER_RE, "[MIME_HEADER]")
    .replace(BEARER_RE, "[BEARER]")
    .replace(JWT_RE, "[JWT]")
    .replace(ACCESS_TOKEN_RE, "[ACCESS_TOKEN]")
    .replace(REFRESH_TOKEN_RE, "[REFRESH_TOKEN]")
    .replace(API_KEY_RE, "[API_KEY]")
    .replace(EMAIL_RE, "[EMAIL]");
  return safeTruncate(sanitized, 1024);
}
```

**scripts/smoke-dwd-gmail-send.ts も同 sanitizer を経由して error を出力する** (workflow ログから PII を排除、PR #442 review Critical 3)。

### 6.6 permanent_failed / manual_review_required の手動復旧フロー

permanent_failed / manual_review_required は再送されない終端状態。手動復旧手順:

1. スーパー管理者が UI で対象 user の audit_log と run 履歴を確認
2. 根本原因 (例: 受講者 email 不正、Cloud Run timeout 等) を修正
3. `scripts/clear-failed-notification.ts` (新規) を **workflow_dispatch + WIF 認証** 経由で実行
4. 次回 cron で再評価される (Reservation が削除されるため)

UI からの直接削除ボタンは提供しない (誤操作リスク回避、`feedback_firestore_prod_admin_via_workflow.md` 整合)。

---

## 7. テスト戦略

### 7.1 テスト層別カバレッジ (ADR-028 InMemoryDataSource 中心の統合テスト)

#### Unit Tests (Jest mocks)

- `schedule-matcher.ts`: JST 時刻判定 (曜日・時刻一致 / 不一致 / 月跨ぎ / disabled 時)
- `completion-eligibility.ts`: published コース全件母集合判定 (course_progress 不在 / 一部完了 / 全完了 / lessonOrder.length と totalLessons の不一致)
- `completion-notification-mail.ts`: 件名・本文構築 (CC 配列、署名挿入、文言テンプレート、CRLF サニタイズ、空 CC 配列)
- `cc-email-validator.ts`: CC 配列の個別 validation、重複排除、ownerEmail 重複処理
- `gmail-dwd-send.ts`: DWD JWT 生成、MIME 組立 (添付込み、CC 配列、`To`/`Cc` ヘッダ)、retry on 429
- `gmail-client.ts`: 専用 client のキャッシュ key 分離 (subject, scope ベース)
- `oidc-verify.ts`: OIDC token verify (valid / invalid / wrong audience / expired)
- `reservation.ts`: transaction 競合シナリオ (新規予約 / 既存 sent / 既存 reserved (lease 内) / 既存 reserved (lease 期限切れ) / 既存 failed_permanent)
- `run-lock.ts`: 同時起動拒否、lease 期限切れ後の取得成功
- `dispatch-403-classifier.ts`: insufficientPermissions / delegationDenied / userRateLimitExceeded / その他の分類
- `dispatch-error-sanitizer.ts`: email / access_token / Bearer / MIME headers の除去
- `dispatch-audit.ts`: audit_logs 書き込み (event_type 別、TTL field セット、PII ハッシュ化)

#### Integration Tests (InMemoryDataSource)

- `run-completion-notifications` 本体: 100% 完了者のみ送信 / 未通知のみ送信 / transient 失敗で reservation 維持 / permanent 失敗で failed_permanent 記録 / 二重実行で idempotent / kill switch / スケジュール不一致 / run lock 重複起動拒否 / lease 期限切れで manual_review_required
- 各 super-admin API endpoint: 楽観的ロック (409) / 入力 validation / audit_logs 書き込み / レート制限
- 内部 API: OIDC 認証必須、Cloud Scheduler SA のみ許可
- test-send: ダミーデータ固定、添付なし、To = superAdmin.email 強制
- dry-run: 送信せず対象一覧返却、Reservation も書かない

#### E2E Tests (Playwright)

- スーパー管理者で `/super/dispatch-settings` アクセス
- 設定変更 → audit_logs 反映
- dry-run 実行 → 一覧表示
- test-send 実行 → mock で確認 (Gmail API は完全 mock、O-1)

### 7.2 Acceptance Criteria

> **番号の付け方**: AC は **5 ブロック (機能 / Reservation・Race / Run Lock・403 / エッジケース / セキュリティ)** に区分し、ブロックの境界で番号を切る (AC-1〜9 機能、AC-10〜15 Reservation、AC-16〜18 Run Lock・403、AC-19〜25 エッジケース、AC-30〜34 セキュリティ)。AC-26〜29 は意図的に欠番として将来追加用に確保 (Codex Minor-2 反映)。

#### 機能 AC

- **AC-1**: published コース全件母集合に対して、`course_progress.isCompleted=true` かつ `totalLessons === lessonOrder.length` の全件達成かつ未通知の受講者のみが Gmail に送信される (Critical-2 反映)
- **AC-2**: 既通知 (Reserved / Sent / FailedPermanent / ManualReviewRequired) の受講者には二度と Gmail 送信されない (idempotency)
- **AC-3**: 送信元 `From:` ヘッダが `DXCOLLEGE_SENDER_EMAIL` (初期値 `dxcollege@279279.net`) に一致。DWD subject は `DXCOLLEGE_DISPATCH_SUBJECT` (初期値 `system@279279.net`) を実 mailbox として用い、SendAs 経由で From を偽装する (ADR-037)
- **AC-4**: `To:` = 受講者本人、`Cc:` = `ownerEmail` + 個別 validate 済 `notificationCcEmails` 配列 (重複排除)
- **AC-5**: 完了通知本文に `completionMessageBody` 設定値 + `signatureName` 設定値が含まれる
- **AC-6**: スケジュール曜日・時刻が現在 JST と一致しない時は何もしない
- **AC-7**: `enabled: false` で kill switch (cron 起動時に即時何もしない)
- **AC-8**: dry-run は 100% 完了対象を返すが Gmail 送信も Reservation も実行しない
- **AC-9**: test-send はスーパー管理者自身宛に**固定ダミーデータ + 添付なし**で送信、1 日 50 件レート制限 (Important-8 反映)

#### Reservation / Race AC (Codex Critical-1+3 反映)

- **AC-10**: Gmail 送信前に `completion_notifications/{userId}` を `reserved` 状態で create する transaction が実行される
- **AC-11**: 既に Reserved の user に対しては、lease 期限内なら Reservation 取得失敗・スキップ
- **AC-12**: lease 期限切れ Reserved は `manual_review_required` に降格し、自動再送されない
- **AC-13**: Gmail 送信成功後、`status: "sent"` に更新、`messageId`/`notifiedAt`/`courseIdsSnapshot`/`publishedCourseCount` がセットされる
- **AC-14**: Gmail 送信 transient 失敗 (429/503) 時、Reservation は維持されるが status は "reserved" のまま (次回 cron で再試行)
- **AC-15**: Gmail 送信 permanent 失敗 (400/422 宛先固有) 時、`status: "failed_permanent"` に更新、再送しない

#### Run Lock / 403 AC (Codex Important-3, Important-4 反映)

- **AC-16**: 同一時刻に複数の cron 起動が来た場合、最初の 1 つだけが lock を取得、他は 409 で即終了
- **AC-17**: Gmail 403 `insufficientPermissions` / `delegationDenied` / sender disabled は run 全体中断、後続 user の Reservation は rollback、Error Reporting critical
- **AC-18**: Gmail 403 宛先固有は user を failed_permanent、run は継続

#### エッジケース AC

- **AC-19**: users.email 空 / CRLF / format violation → スキップ (Reservation せず) + Error Reporting
- **AC-20**: ownerEmail null + notificationCcEmails 非空 → CC は notificationCcEmails のみ
- **AC-21**: notificationCcEmails 空 → CC は ownerEmail のみ
- **AC-22**: 後からマスター講座配信でコース追加 → 既通知者は通知済みなので再送されない (案 C) + `courseIdsSnapshot` で当時の状態追跡可能
- **AC-23**: 設定 version 不一致 → 409、UI で警告 + 現在値 reload
- **AC-24**: notificationCcEmails 11 件以上の入力 → 400 (上限超過)
- **AC-25**: notificationCcEmails 内に CRLF / カンマ / 制御文字 → 400、個別 validation で拒否

#### セキュリティ AC

- **AC-30**: 内部 endpoint は OIDC ID Token 必須、audience 不一致で 401
- **AC-31**: スーパー管理者 API は既存 super-admin auth (Firebase Bearer) で保護、CSRF 不要 (cookie 非使用)
- **AC-32**: recipient email は sha256 で保存、raw は Firestore に保存されない
- **AC-33**: errorMessage は `sanitizeErrorForAudit()` で email / access_token / Bearer / MIME headers が除去された後に保存
- **AC-34**: 共通 `SCOPES` (drive/docs/sheets) には `gmail.send` を追加しない、専用 client `getGmailClientForSender` のみが gmail.send scope を使用

---

## 8. インフラ作業 (本田様作業含む)

### 8.1 GCP 側準備 (実装前)

| 作業 | 担当 | 内容 |
|---|---|---|
| **DWD scope 拡張** | **本田様** | ✅ 完了 (2026-05-20)。Google Workspace 管理コンソールで `dwd-workspace-key` SA の DWD 認可に `https://www.googleapis.com/auth/gmail.send` を追加 |
| **Gmail Group エイリアス smoke check** | エンジニア | ✅ 完了 (2026-05-21)。`dxcollege@279279.net` Group エイリアスへの DWD impersonation は不可と確定。**ADR-037 案 X (SendAs) を採用**して OQ-2 解決 |
| **SendAs 設定 (新規、本田様作業)** | **本田様** | `system@279279.net` の Gmail 設定 → アカウント → 「他のメールアドレスを追加」→ `dxcollege@279279.net` を SendAs 登録 (ADR-037 §実装方針 4) |
| **SendAs 実機 send smoke (新規)** | エンジニア | SendAs 設定完了後、`mode=send` で smoke を実行し From ヘッダが `dxcollege@279279.net` で配送されるか実機確認 |
| Gmail API 有効化 | エンジニア | `gcloud services enable gmail.googleapis.com` |
| Cloud Scheduler API 有効化 | エンジニア | `gcloud services enable cloudscheduler.googleapis.com` |
| Cloud Scheduler SA 作成 | エンジニア | `dxcollege-scheduler@lms-279.iam.gserviceaccount.com` を作成、Cloud Run invoker 権限付与 |
| **Cloud Run env 設定 (改訂)** | エンジニア | `DXCOLLEGE_SENDER_EMAIL=dxcollege@279279.net` (MIME From) + **`DXCOLLEGE_DISPATCH_SUBJECT=system@279279.net` (DWD subject、ADR-037)** を追加 |
| Cloud Scheduler job 作成 | エンジニア | cron `0 * * * *` + `time-zone Asia/Tokyo` + OIDC token + audience 設定 |
| Firestore TTL Policy 設定 | エンジニア | `super_dispatch_audit_logs.ttlExpireAt` + `super_dispatch_runs.ttlExpireAt` フィールドに TTL Policy |
| Firestore index | エンジニア | `super_dispatch_audit_logs` のフィルタ用 composite index、`super_dispatch_runs.status + leaseExpiresAt` の index |

### 8.2 Workspace 側準備 (本田様作業詳細)

#### 8.2.1 DWD scope 拡張手順 ✅ 完了 (2026-05-20)

1. Google Workspace 管理コンソール (admin.google.com) にログイン
2. セキュリティ → アクセスとデータ管理 → API の制御 → ドメイン全体の委任を管理
3. 既存の `dwd-workspace-key` SA のクライアント ID (`118098709021350891398`) を選択
4. スコープ追加: `https://www.googleapis.com/auth/gmail.send`
5. 保存

#### 8.2.2 SendAs 設定手順 (新規、ADR-037 案 X)

`system@279279.net` の Gmail で `dxcollege@279279.net` を SendAs エイリアスとして登録する:

1. https://mail.google.com に `system@279279.net` でログイン
2. 設定 (歯車) → 「すべての設定を表示」→ 「アカウントとインポート」タブ
3. 「他のメール アドレスを追加」をクリック
4. 入力:
   - 名前: `DXcollege運営スタッフ`
   - メールアドレス: `dxcollege@279279.net`
   - エイリアスとして扱う: チェック ON
5. 「次のステップ」→ Workspace 内部送信なので SMTP 認証は不要、そのまま完了
6. 確認: 「メール送信時のデフォルトの返信アドレス」を `dxcollege@279279.net` に設定 (任意、本機能では MIME From で直接指定するため必須ではない)

#### 8.2.3 反映確認

SendAs 設定は即時反映。設計仕様書 §8.1 の **「SendAs 実機 send smoke」** で `mode=send` smoke を実行し、受信側で From ヘッダが `dxcollege@279279.net` で表示されるか確認する。失敗時は ADR-037 §「再評価条件」に従い案 Y (実 User 化) への移行を検討。

---

## 9. スコープ外 / 将来課題

| 項目 | 理由 |
|---|---|
| **bounce 検知** | Phase 1 では非対応。受信側 reject の検知は Postmaster Tools or Gmail API polling が必要、運用課題化したら Phase 2 |
| **テナント管理者向け CC 設定 UI** | スーパー管理者のみ編集、テナント側公開は誤操作リスクのため見送り |
| **完了通知以外の自動メール** (例: 受講開始通知、期限切れ警告) | 同じ Dispatch 基盤に乗せられるが、Phase 1 では完了通知のみ |
| **配信スケジュールの「分」単位指定** | 60 分間隔起動のため HH:00 単位のみ |
| **複数言語対応 (i18n)** | 完了通知本文・UI は日本語固定。テナント単位の locale 未対応を UI 上の運用制約として明示 (Codex Minor) |
| **メール開封率トラッキング** | プライバシー観点で見送り |
| **A/B テスト** | 文面 A/B テストは将来課題 |
| **rate limit 集計の可視化** | test-send レート制限の残数表示は将来課題 |
| **resumable run (checkpoint)** | Cloud Run timeout 後の resume。Phase 1 では `super_dispatch_runs` lock のみ実装、checkpoint 復帰は将来課題 |

---

## 10. Open Questions (実装着手前にクリアすべき)

| ID | 質問 | 解決手段 |
|---|---|---|
| **OQ-1** | Gmail API が `lms-279` プロジェクトで有効化済みか | `gcloud services list --enabled --project=lms-279 \| grep gmail` |
| **OQ-2** | ~~`dxcollege@279279.net` が Google Group の場合、DWD subject として `gmail.users.messages.send` が成功するか~~ | ✅ **RESOLVED (2026-05-21)**: smoke check 3 回 (run #26166362814 / #26186034548 / #26186218233) で Group エイリアスへの DWD impersonation 不可と確定。**ADR-037 案 X (SendAs) を採用**。新たに「SendAs 実機 send smoke」を OQ-X として後続 |
| **OQ-3** | DWD scope 追加 (gmail.send) の Workspace 管理コンソール作業は本田様が実施可能な権限を持つか | ✅ **RESOLVED (2026-05-20)**: 本田様が Workspace 管理コンソールで `gmail.send` scope を追加完了、smoke 3 回目で動作確認済 |
| **OQ-4** | Cloud Run 実行制限 300 秒で全テナント全 user の走査が完了するか | 現状 2 テナント × user 数で実測 |
| **OQ-5** | 既存 `tenants/{tenantId}` ドキュメントへのフィールド追加は backfill 不要か | Firestore は欠損フィールドを `undefined` 扱い、`sanitizeForUpdate` で対応 |
| **OQ-6** | Cloud Scheduler の OIDC token audience は Cloud Run service URL でよいか | `services/api` の URL を使用 |
| **OQ-7 (新規)** | **既存 super-admin auth middleware の認証方式は Firebase Bearer Token か (cookie 不使用か)** (Codex Important-9) | 実装着手前に既存コード確認、Bearer なら CSRF 対策不要を AC-31 で明示済 |
| **OQ-8 (新規)** | **`super_dispatch_audit_logs` の 1 年 TTL が法務・契約上の保持期間と一致するか** (Codex Minor) | privacy policy / 受講契約と照合、必要に応じて TTL 調整 |
| **OQ-9 (新規)** | **Reservation の lease 期限 10 分が現実の Gmail send 所要時間と適合するか** | 実装後に実測、必要に応じて調整 |
| **OQ-X (新規、2026-05-21)** | **SendAs 設定後に Gmail API `users.messages.send` が `From: dxcollege@279279.net` を受理して配送するか** (ADR-037 §Open Questions) | 本田様が `system@279279.net` の Gmail で `dxcollege@279279.net` を SendAs 登録 → smoke `mode=send` で実機検証。失敗時は ADR-037 §「再評価条件」に従い案 Y 移行 |

---

## 11. 関連リソース

- 処理フロー図: [2026-05-20-completion-notification-flow.mmd](./2026-05-20-completion-notification-flow.mmd)
- ADR-026: Google Workspace 連携 (DWD)
- ADR-029: タイムゾーン基準 (JST 表示)
- ADR-034: Phase 2 Gmail 下書き (PII ハッシュ化、CRLF 防御のパターン)
- PR #434: 受講者進捗 PDF Gmail 下書き作成 (本機能と独立)
- `~/.claude/rules/error-handling.md`: エラー処理ルール
- `~/.claude/rules/production-data-safety.md`: 本番データ保護ルール
- Codex セカンドオピニオン: 2026-05-20 実施、Critical 3 件 / Important 9 件 / Minor 4 件すべて反映

---

## 12. brainstorm Phase 4-5 承認サマリ + Codex 反映状況

| セクション | 確定セット |
|---|---|
| 1. アーキテクチャ | 60 分起動 / OIDC / 並列度 8 / 既存 services/api 統合 |
| 2. データモデル | Firestore TTL Policy / version 楽観ロック / ADR-034 PII ハッシュ化踏襲 + **Reservation 方式追加** |
| 3. API・関数境界 | settings 競合は警告 reload / CC 入力は chips UI 上限 10 件 / test-send 1 日 50 件 + **dummy data 固定** |
| 4. エラー処理 | script 復旧 / permanent と orphan_send は critical / PDF 30 秒 timeout + **403 reason 分類 / PII sanitize / run-level lock** |
| 5. テスト戦略 | Cloud Scheduler 自体はテストせず + Gmail API 完全 mock + PII fixtures + **Reservation race scenario 追加** |

### Codex セカンドオピニオン反映状況

| Codex 指摘 | 反映状況 |
|---|---|
| Critical-1+3: Reservation 方式 | ✅ FR-7 / NFR-3 / §4.1.3 / §4.2 / §6.2 / AC-10〜15 |
| Critical-2: published コース全件母集合 | ✅ FR-4 / `completion-eligibility.ts` / AC-1 |
| Important-1: DWD scope 分離 | ✅ NFR-9 / `gmail-client.ts` / AC-34 |
| Important-2: Google Group smoke check | ✅ §8.1 / OQ-2 RESOLVED 2026-05-21 (ADR-037 案 X 採用) |
| Important-3: run-level lock | ✅ FR-11 / §4.1.4 / `run-lock.ts` / §6.3 / AC-16 |
| Important-4: 403 reason 分類 | ✅ §6.4 / `dispatch-403-classifier.ts` / AC-17, AC-18 |
| Important-5: courseIdsSnapshot 保存 | ✅ FR-12 / §4.1.3 / §4.3 / AC-22 |
| Important-6: CC 個別 validation | ✅ FR-6 / `cc-email-validator.ts` / AC-25 |
| Important-7: PII sanitize | ✅ NFR-11 / `dispatch-error-sanitizer.ts` / §6.5 / AC-33 |
| Important-8: test-send dummy data | ✅ NFR-7 / AC-9 |
| Important-9: CSRF 認証方式明記 | ✅ NFR-2 / AC-31 / OQ-7 |
| Minor-1: API path 表記統一 | ✅ `run-completion-notifications` で統一 |
| Minor-2: AC 番号欠番 | ✅ AC-1〜AC-34 連番に再整理 |
| Minor-3: TTL 法務確認 | ✅ OQ-8 |
| Minor-4: i18n 運用制約明記 | ✅ §9 |
