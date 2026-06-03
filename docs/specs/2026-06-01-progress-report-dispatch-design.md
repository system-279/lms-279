# 進捗レポート 定期自動配信 (Phase 3) 設計仕様書

| 項目 | 値 |
|---|---|
| 起票日 | 2026-06-01 |
| 起票者 | 開発者 (要件) / system-279 (設計) |
| 関連 ADR | ADR-032 (super-admin 進捗 PDF) / ADR-034 (Phase 2 Gmail 下書き) / ADR-037 (sender impersonation) / **ADR-039 (Phase 3 進捗レポート 定期自動配信、本仕様の判断記録)** |
| 関連 spec | `2026-05-20-completion-notification-design.md` (完了通知レーン、本仕様の対称設計参考) |
| 関連 Issue | #346 (Phase 2 起票時に Phase 3 候補として先送り記録) |
| 関連 PR | #434 (Phase 2 Gmail 下書き、本仕様と独立) |
| Plan stage 議論記録 | `~/.claude/plans/eager-jumping-hoare.md` |
| Codex セカンドオピニオン | thread `019e82e8-4228-79c1-a63a-d3c4e7359731` |
| 処理フロー図 | [`2026-06-01-progress-report-dispatch-flow.mmd`](./2026-06-01-progress-report-dispatch-flow.mmd) |
| 実装計画 | [`2026-06-01-progress-report-dispatch-impl-plan.md`](./2026-06-01-progress-report-dispatch-impl-plan.md) |

---

## 1. 概要 / 動機

### 1.1 背景

業務スーパー管理者からのオーダー: 受講中の全ユーザーに進捗レポートメール (PDF 添付) を曜日・時刻スケジュールで自動配信したい。Session 52 で判明したのは、業務スーパー管理者が期待する「自動配信」と既存の自動配信レーン (完了通知 = 100% 完了者のみ・1 度きり) との認識ずれ。途中経過の進捗レポートの定期自動配信は Issue #346 で「Phase 3 候補」として明示的に先送りされていた機能。

詳細な経緯は ADR-039 §Context を参照。

### 1.2 目的

既存の完了通知レーン (`run-completion-notifications.ts`) を変更せず、並走する別レーンとして「**進捗レポート 定期自動配信**」を新設する。受講中の active 受講者に、手動レーン (ADR-034 / Image #4) と同等の進捗レポートメール (件名・本文・PDF 添付) を、受講者本人 (To) + テナント担当者 (CC) へ自動送信する。

### 1.3 既存機能との関係

```
[既存 Phase 2] スーパー管理者が画面でボタン → Gmail 下書き (個人 OAuth, gmail.compose)  ← 維持
[既存 完了通知] Cloud Scheduler → 100% 完了者のみ・1 回限り (修了メール、PDF 添付なし)  ← 維持
[新規 Phase 3] Cloud Scheduler → active 受講者の定期配信 (進捗レポート、PDF 添付あり) ← 追加
```

3 機構は全て独立。一方の不具合が他方に波及しない設計とする。

---

## 2. 用語

| 用語 | 定義 |
|---|---|
| 進捗レポート | 受講者の進捗率・受講期限・推奨ペースを記載したメール本文 + PDF 添付 (ADR-034 と同じ中身) |
| 配信レーン | Cloud Scheduler → endpoint → 受信者群へメール送信 の 1 系統 |
| 完了通知レーン | 既存。`run-completion-notifications.ts` 経由、100% 完了者・1 回限り |
| 進捗レポートレーン | 新規。`run-progress-reports.ts` 経由、active 受講者・定期送信 |
| occurrenceId | 1 回の scheduled execution を識別する key。`sha256(laneId + X-CloudScheduler-ScheduleTime)`。冪等性キーとして使用 |
| runId | 1 回の HTTP attempt を識別する UUID。監査用 |
| pending | recipient claim 直後の状態。lease 10 min + ttlExpireAt 設定 |
| manual_review_required | pending lease 切れの降格状態。自動再送せず手動確認 |

---

## 3. 機能要件 / 確定済 OQ

| # | 項目 | 決定 | 根拠 |
|---|---|---|---|
| 1 | 配信頻度・スケジュール | 完了通知と同一構造 (`scheduleDaysOfWeek[]` + `scheduleHourJst`、独立設定) | decision-maker 承認 |
| 2 | PDF 添付 | あり (手動レーンと同等。multipart/mixed に拡張) | decision-maker 承認 |
| 3 | 実行レーン | 別 endpoint + 別 Cloud Scheduler ジョブ | ADR-039 D-1 |
| 4 | 100% 完了者の扱い | 除外 (`skipCompletedUsers=true` 固定、設定 UI で切替不可) | decision-maker 承認 |
| 5 | PR 分割粒度 | 5 PR (3a / 3b / 3c / 3d / 3e) | decision-maker 承認 |
| 6 | Firestore TTL | 90 日 | decision-maker 承認 |
| 7 | 「受講中」定義 | **Plan A 4 軸**: role=student + tenant active + videoAccessUntil 期限内 + 進捗 ≥ 1% (ADR-039 D-5 改訂 2026-06-03、退会・enrollment は Firestore schema 不在のため将来 PR で対応) | ADR-039 D-5 |
| 8 | 受講者最大規模 | < 500 名 / 全テナント合計 (同期バッチ維持) | ADR-039 D-7 |
| 9 | テナント単位 opt-out | 分離: `tenants/{tid}.progressReportEnabled?: boolean` 新規 (default false) | ADR-039 D-6 |

---

## 4. アーキテクチャ

詳細は [`2026-06-01-progress-report-dispatch-flow.mmd`](./2026-06-01-progress-report-dispatch-flow.mmd) 参照。

### 4.1 構成

```
Cloud Scheduler (新規 job: dxcollege-progress-reports, cron 完了通知と 30 分ずらし, tz=Asia/Tokyo)
  ↓ OIDC ID Token + X-CloudScheduler-ScheduleTime ヘッダ
POST /api/v2/internal/dispatch/run-progress-reports (services/api)
  → oidc-verify → occurrenceId 算出 → runId 採番
  → acquireLaneLock (lane_locks/progress, transactional)
  → schedule-matcher (progressReport sub-schedule)
  → tenant 直列走査 (active + progressReportEnabled=true)
  → user 並列度 8 (listProgressReportTargetUsers)
    eligibility 判定: 100% 完了 → skip
    tryClaimProgressRecipient(occurrenceId, userId) → pending claim
    buildProgressPdfData → ProgressPdfDocument → renderToBuffer (PDF 5MB 上限)
    buildMailTemplate (件名・本文) + validateAndDedupeCcEmails
    sendProgressMail (multipart/mixed, RFC 2231 filename) via Gmail DWD SendAs
    markProgressRecipientSent / Failed (finalize)
  → completeLaneLock / abortLaneLock
```

### 4.2 主要設計判断 (ADR-039 サマリ)

- **D-1**: レーン分離 (別 endpoint + 別 Cloud Scheduler job)
- **D-2**: 冪等性キー `occurrenceId` を分離 (Cloud Scheduler at-least-once 対応)
- **D-3**: Recipient state machine `pending → sent / failed / manual_review_required`
- **D-4**: Lane lock を別 doc + transactional 取得
- **D-5**: 受講中フィルタ 4 軸 (Plan A 採用、ADR-039 D-5 改訂)
- **D-6**: テナント単位 opt-out を分離 (`progressReportEnabled`)
- **D-7**: < 500 名前提で同期バッチ維持
- **D-8**: RFC 2231 filename dual-form

---

## 5. データモデル

### 5.1 新規 Firestore collections

**`super_dispatch_lane_locks/{laneId}`** (lane 別排他)
```typescript
{
  laneId: "completion" | "progress";
  ownerRunId: string;
  occurrenceId: string;
  leaseExpiresAt: Timestamp;
  acquiredAt: Timestamp;
  updatedAt: Timestamp;
}
```

**`tenants/{tenantId}/progress_report_sends/{occurrenceId}__{userId}`** (recipient state)
```typescript
{
  occurrenceId: string;
  runId: string;
  userId: string;
  status: "pending" | "sent" | "failed" | "manual_review_required";
  claimedAt: Timestamp;
  leaseExpiresAt: Timestamp;     // pending 時のみ
  sentAt: Timestamp | null;      // sent 時のみ
  messageId: string | null;
  pdfSizeBytes: number | null;
  failedAt: Timestamp | null;    // failed 時のみ
  errorCode: string | null;      // sanitized
  errorMessage: string | null;   // sanitized
  promotedAt: Timestamp | null;  // manual_review 時のみ
  recipientToHash: string;       // sha256 (PII 最小化)
  recipientCcHashes: string[];
  ttlExpireAt: Timestamp;        // claim 時に claimedAt + 90 days
}
```

### 5.2 既存 Firestore コレクション拡張

**`super_dispatch_runs/{runId}`** (既存): `laneId` / `occurrenceId` フィールド追加。既存 doc は `laneId` 欠落時 `"completion"` 扱い (後方互換)。

**`tenants/{tenantId}`** (既存): `progressReportEnabled?: boolean` 追加 (default false、optional)。

### 5.3 DTO 拡張 (`packages/shared-types/src/dispatch.ts`)

```typescript
export interface ProgressReportSettings {
  enabled: boolean;
  scheduleDaysOfWeek: number[];  // 0-6
  scheduleHourJst: number;       // 0-23
}

export interface DispatchSettings {
  // ... 既存 fields
  progressReport?: ProgressReportSettings;  // optional, undefined で disable と同等
}

export interface RunProgressReportsResponse {
  runId: string;
  occurrenceId: string;
  processedTenants: number;
  sent: number;
  skipped: number;
  failed: number;
  pendingPromotedToManualReview: number;
  laneLockContention: boolean;
}
```

**Settings PUT は patch semantics**: storage 層で undefined フィールドを既存値で保持 (Codex HIGH-4 反映)。FE は always-send-all 戦略。

---

## 6. 既存コードからの再利用

### 6.1 完全流用 (変更なし)

| 機構 | パス |
|---|---|
| OIDC 検証 | `services/api/src/services/dispatch/oidc-verify.ts` |
| schedule 判定 | `services/api/src/services/dispatch/schedule-matcher.ts` |
| CC validator | `services/api/src/services/dispatch/cc-email-validator.ts` |
| 100% 判定 (除外フィルタ用) | `services/api/src/services/dispatch/completion-eligibility.ts` |
| 進捗データ集約 | `services/api/src/services/progress-pdf.ts` (`buildProgressPdfData`) |
| メール件名・本文 | `services/api/src/services/progress-pdf-mail-template.ts` (`buildMailTemplate`) |
| PDF 生成 | `services/api/src/services/progress-pdf-document.tsx` (`ProgressPdfDocument`) |

### 6.2 拡張 / 新規

| 区分 | パス | 内容 |
|---|---|---|
| 新規 | `services/api/src/services/dispatch/lane-lock.ts` | transactional 取得、laneId 別 doc |
| 新規 | `services/api/src/services/dispatch/run-progress-reports.ts` | メインフロー |
| 新規 | `services/api/src/services/dispatch/progress-report-recipient.ts` | state machine |
| 新規 | `services/api/src/services/dispatch/progress-mime-builder.ts` | multipart/mixed 組立 |
| 新規 | `services/api/src/routes/internal/progress-reports.ts` | endpoint |
| 拡張 | `services/api/src/services/dispatch/gmail-dwd-send.ts` | 新 export `buildMessageMime`、既存 `buildCompletionMime` を wrapper にリファクタ |
| 拡張 | `services/api/src/services/dispatch/dispatch-storage.ts` + 両実装 | 7 メソッド追加、settings patch semantics |
| 拡張 | `services/api/src/services/dispatch/tenant-data-loader.ts` | `listProgressReportTargetUsers()` + `getTenantInfo()` |
| 拡張 | `services/api/src/services/dispatch/dispatch-audit.ts` | eventType 9 種追加 |
| 拡張 | `packages/shared-types/src/dispatch.ts` + `tenant.ts` | DTO 拡張 |
| 拡張 | `web/app/super/dispatch-settings/page.tsx` | 新セクション + テナント opt-in トグル |

---

## 7. セキュリティ / 認可

- 内部 endpoint (`/api/v2/internal/dispatch/run-progress-reports`) は OIDC 検証必須 (Cloud Scheduler の SA トークン以外は 401)
- super-admin 設定 endpoint (`/api/v2/super/dispatch-settings`、`/api/v2/super/tenants/{tid}`) は既存の super-admin middleware で保護
- recipient sub-collection は生 email を保存せず sha256 hash のみ (PII 最小化、NFR 準拠)
- audit log の error message は sanitize (token, email, PII の除去)
- Gmail DWD 送信は ADR-037 採用方式 (`subject=system@279279.net` + SendAs で `From: dxcollege@279279.net`)

---

## 8. 運用 (cutover / kill switch / 再評価)

詳細は実装計画 [`2026-06-01-progress-report-dispatch-impl-plan.md`](./2026-06-01-progress-report-dispatch-impl-plan.md) §運用 を参照。

主要ポイント:
- cutover step 1: 各テナント `progressReportEnabled=true` を業務スーパー管理者が決裁・設定 (default false 前提)
- kill switch: `progressReport.enabled=false` で即時停止 (完了通知への影響なし)
- 受講者規模監視: 全テナント合計 300 名超で Cloud Tasks 移行検討 (Phase 4 OQ)
- Workspace 送信上限監視: `system@279279.net` の rolling 24h 2,000 件を完了通知 + 進捗レポートで共有

---

## 9. Open Questions (Phase 3 中・終了後の再評価)

| OQ | 内容 | 再評価条件 |
|---|---|---|
| OQ-1 | 受講者規模拡大 | 全テナント合計 300 名超 |
| OQ-2 | 親スイッチ `dispatchEnabled` | 完了通知 + 進捗の一括 ON/OFF 要望 |
| OQ-3 | 件名・本文テナント別カスタマイズ | テナント別文面要望 |
| OQ-4 | heartbeat lease 更新 / Cloud Tasks | pending lease 切れ多発 |
| OQ-5 | `mime-utils.ts` 共通化 | Phase 4 リファクタ |

---

## 10. 参考

- 完了通知 spec (対称設計参考): `docs/specs/2026-05-20-completion-notification-design.md`
- 手動進捗レポート: `services/api/src/routes/super/progress-pdf-draft.ts` (ADR-034)
- Plan stage 議論記録: `~/.claude/plans/eager-jumping-hoare.md`
- Cloud Scheduler at-least-once delivery: https://docs.cloud.google.com/scheduler/docs/reference/rest/v1/projects.locations.jobs
- Workspace Gmail 送信上限: https://support.google.com/a/answer/166852
- RFC 2231 (MIME parameter value extensions): https://www.rfc-editor.org/rfc/rfc2231
