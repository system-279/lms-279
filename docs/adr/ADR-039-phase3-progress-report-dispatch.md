# ADR-039: 進捗レポート 定期自動配信 (Phase 3) のレーン分離・冪等設計・テナント opt-out 分離

- Status: **Accepted**
- Date: 2026-06-01
- Deciders: 開発者, system-279
- 関連: ADR-032 (super-admin 進捗 PDF), ADR-034 (Phase 2 Gmail draft), ADR-037 (完了通知 sender impersonation), 設計仕様書 `docs/specs/2026-06-01-progress-report-dispatch-design.md`, Issue #346 (Phase 3 候補先送り記録), Session 52 ハンドオフ (`docs/handoff/archive/2026-06-01-session-52.md`)

## Context

Session 52 で業務スーパー管理者から受領したフィードバックで、業務スーパー管理者が期待する「自動配信」(受講中の全ユーザーへ進捗レポートを定期配信) と、既存の自動配信レーン (完了通知 = 100% 完了者のみ・1 度きり) との認識ずれが判明した。

時系列:
- ADR-032 (2026-05-13): 進捗 PDF を 2 Phase 分割、「将来テナント管理者へ自動送信する余地を残す」と記載
- Issue #346 (起票時): Phase 2 は手動ボタン押下→確認モーダル承認、末尾に「**スコープ外 (将来 Phase 3 候補): 定期自動送信 (Cloud Scheduler)**」と明記
- ADR-033 (Rejected): SMTP relay 自動送信案 → Gmail API 一択を維持
- ADR-034 (2026-05-14): Phase 2 を手動 Gmail 下書きに再定義 (= Image #4)
- 完了通知 spec (2026-05-20): 自動配信レーンは「全コース 100% 完了者のみ・1 度だけ」と明確にスコープ
- Session 52 (2026-06-01): 業務スーパー管理者フィードバックで認識ずれ判明、Phase 3 として実装を**開発者判断で決定**

Phase 3 設計では複数の設計判断が必要で、Plan stage で Codex セカンドオピニオン (CRITICAL 4 件 / HIGH 5 件) を取得して反映した。本 ADR はその判断記録を残す。

### Plan stage で取得した Codex セカンドオピニオンの要点

| 観点 | Codex 指摘 |
|---|---|
| CRITICAL-1 | `runId=randomUUID()` では Cloud Scheduler at-least-once delivery の retry を冪等化できない |
| CRITICAL-2 | `tx.create()` のみでは PDF 生成中・Gmail 送信直後の crash で「sent か未送信か判定不能」な orphan が残る |
| CRITICAL-3 | run-lock に `laneId` 条件を追加するだけでは既存 query→set の best-effort race を解消できない |
| CRITICAL-4 | 同期一括処理 + 280s lease は受講者数次第で timeout する。最大規模の確定が必要 |
| HIGH-1 | `listNotificationTargetUsers` の `role=student` フィルタだけでは退会・期限切れ・未着手 0% が混入する |
| HIGH-2 | テナント単位 opt-out を完了通知と共有すると「完了通知だけ止めたい」「進捗だけ止めたい」が UI で表現できない |
| HIGH-3 | Gmail API quota より Workspace 送信上限 2,000 msg/day/user (rolling 24h) が先に効く |
| HIGH-4 | settings 全体上書き PUT で、PR 3a→3d の間に旧 UI 経由で `progressReport` が消える可能性 |
| HIGH-5 | MIME 添付の filename dual-form 標準は RFC 5987 (HTTP header 用) ではなく RFC 2231 |

## Decision

進捗レポート 定期自動配信を **完了通知レーンと並走する別レーン** として実装する。以下の 8 つの設計判断を採用する。

### D-1. レーン分離 (別 endpoint + 別 Cloud Scheduler job)

- 新規 endpoint: `POST /api/v2/internal/dispatch/run-progress-reports`
- 新規 Cloud Scheduler job: `dxcollege-progress-reports` (完了通知 job と **30 分ずらす**)
- 完了通知 (`run-completion-notifications.ts`) のロジックは変更せず、Phase 3 用に新規ファイル `run-progress-reports.ts` を作成
- 共通ヘルパー (OIDC verify / schedule-matcher / CC validator / completion-eligibility / progress-pdf 集約・PDF・メールテンプレ) は完全流用

**採用理由**: 障害切り分けが独立 (一方の不具合が他方に波及しない)、スケジュール独立、kill switch 独立、監査ログでの区別が明確、Codex 推奨。

**不採用案**: 同一 endpoint 拡張 (run-completion-notifications.ts に進捗レポート処理を追加)。理由: 障害切り分けが難化、片方の修正で両方をテストする必要が出る、設計対称性が崩れる。

### D-2. 冪等性キーは `occurrenceId` を分離 (Cloud Scheduler at-least-once 対応)

- `occurrenceId` = sha256(`laneId` + `X-CloudScheduler-ScheduleTime`) を first-class identifier として扱う
- `runId` (UUID) は HTTP attempt 単位の監査用に限定
- recipient claim の doc ID = `{occurrenceId}__{userId}`
- Cloud Scheduler が同 scheduled execution を retry すると同 occurrenceId が来るため、recipient claim で天然に重複拒否される

**採用理由**: Cloud Scheduler は at-least-once delivery で、同 scheduled execution が retry されると現行設計 (`runId=randomUUID()`) では新 UUID が発行されて重複送信される (Codex CRITICAL-1)。Cloud Scheduler は `X-CloudScheduler-ScheduleTime` ヘッダを RFC3339 で付与するため、これを first-class identifier として使うのが堅牢。

**不採用案**: `runId` だけで claim キーにする (現行 plan の旧案)。理由: Scheduler retry で重複送信が起きる、手動再実行の意味論も曖昧。

### D-3. Recipient state machine: pending → sent/failed/manual_review_required

- claim 時点で `status=pending` doc を create (lease 10 min、ttlExpireAt も同時設定)
- 既存 doc 不在: pending claim
- 既存 pending + lease 有効: 他 worker 処理中 → skip
- 既存 pending + lease 切れ: `manual_review_required` に降格 + skip (自動再送せず)
- 既存 sent / failed: skip
- Gmail 受理 → `markProgressRecipientSent` で finalize
- permanent error → `markProgressRecipientFailed` で finalize

**採用理由**: `tx.create()` のみでは PDF 生成中・Gmail 送信直後の crash で「sent か未送信か判定不能」な orphan が残る (Codex CRITICAL-2)。pending state を持たせて lease + finalize モデルにすることで、crash 後に自動再送しない (manual_review_required) 安全策が取れる。Gmail 送信と Firestore finalize は atomic にできないため、orphan_send (Gmail 受理済だが finalize 失敗) は audit で運用検出する設計とする。

**不採用案**: append-only (sent/failed のみ)。理由: claim 直後の crash 後に「未送信」判定で次 retry が重複送信する。

### D-4. Lane lock を `super_dispatch_lane_locks/{laneId}` 別 doc + transactional 取得

- 新規 collection `super_dispatch_lane_locks/{laneId}` (laneId 別 doc)
- 取得経路: Firestore transaction で `tx.get(lockRef)` → lease 判定 → `tx.set(lockRef)`
- `super_dispatch_runs/{runId}` は監査用に runId / laneId / occurrenceId を記録
- 既存 `super_dispatch_runs` doc に `laneId` フィールドを追加 (欠落時は `"completion"` 扱いで後方互換)
- 完了通知レーンの既存 `run-lock.ts` は Phase 3 で破壊せず、Phase 4 で lane-lock に統合検討

**採用理由**: 既存 run-lock の query→set は best-effort で race を完全排除できない (Codex CRITICAL-3)。lane 別 lock doc + transaction で取り直すことで Firestore レベルの排他保証が得られる。将来 lane が N 個に増えても lock doc 追加だけで済む拡張性も得られる。

**不採用案**: 既存 `run-lock.ts` に `laneId` 引数を追加するだけ。理由: query→set best-effort のため同 lane 並行 request の race が残る。

### D-5. 受講中フィルタは 4 軸 (active student + tenant active + 期限内 + 1% 以上進捗) ※Plan A 採用

**当初決定**: active student + enrollment 存在 + 不退会 + videoAccessUntil 期限内 + 1% 以上進捗 (5 軸厳密)

**改訂後 (PR 3a 実装着手時、2026-06-03)**: 4 軸に簡素化:
1. role=student (既存 `listNotificationTargetUsers` 同等)
2. tenant.status === "active"
3. videoAccessUntil > now (`TenantEnrollmentSetting._config` の tenant-wide 設定、既存 `checkVideoAccess()` 同等)
4. 合計 progressRatio >= 1% (全コース合計、`PROGRESS_REPORT_MIN_PROGRESS_PERCENT/100`)

新規関数 `listProgressReportTargetUsers(now: Date)` を `tenant-data-loader.ts` に追加。

**改訂理由 (Plan A 採用)**: PR 3a 着手時の Firestore schema 調査で以下が判明:
- 「不退会」判定軸 不在: `users/{uid}` schema に `status` / `withdrawn` / `deletedAt` 等の退会 field が存在しない (`services/api/src/types/entities.ts:10-18`)
- 「enrollment 存在」判定軸 不在: `TenantEnrollmentSetting` は `tenants/{tid}/enrollment_settings/_config` の **tenant-wide 1 doc** で、user-level の enrollment 存否を表現する collection / field が無い

→ 「不退会」「enrollment 存在」を本 PR で実装するには User schema 拡張 (`users.status` 等) が必要で、PR 3a の本来スコープ (shared-types + storage 層) を大きく超える。CLAUDE.md「設計仕様書未記載の列挙値・分類を実装で独断追加しない」原則に基づき、AskUser で 4 軸への簡素化を本田様判断で確認 → Plan A 採用。

「不退会」「enrollment 存在」判定は将来の別 PR で User schema 拡張とセットで対応 (再評価条件: 退会ユーザーへの誤配信報告 or 業務スーパー管理者からの要望)。本 PR 期間中の運用は、tenant active + 期限内 + 1% 進捗の 3 軸で「事実上アクティブな受講者」をカバーできると判断 (本番 ON 前にこれら 3 軸で十分か運用評価する)。

**Codex HIGH-1 (退会・期限切れ・0% 混入リスク) への対応状況**:
- 期限切れ: ✅ videoAccessUntil で対応
- 未着手 0%: ✅ 1% threshold で対応
- 退会: ⚠️ Plan A では未対応、将来の User schema 拡張 PR で再対応

**確定済 OQ**: §確定済 OQ #7 → 当初「厳密」採用 → 実装着手で schema gap 判明 → 本田様判断で Plan A 採用 (2026-06-03)。

### D-6. テナント単位 opt-out を分離 (`progressReportEnabled` 新規フィールド)

- 新規フィールド `tenants/{tid}.progressReportEnabled?: boolean` (default false、optional)
- 既存 `tenants/{tid}.completionNotificationEnabled` とは独立
- Phase 3a で migration なし (optional、既存テナントは undefined のまま動く)
- 親スイッチ (`dispatchEnabled`) は導入せず、将来必要になったら追加

**採用理由**: 共有だと「完了通知だけ止めたい」「進捗レポートだけ止めたい」が UI で表現できない (Codex HIGH-2)。最初から分離する方が将来 migration コストよりも安い。default false (opt-in) にすることで、業務スーパー管理者がテナントごとに決裁・設定するプロセスを runbook で明示できる。

**不採用案**: `completionNotificationEnabled` 共有。理由: 上記 HIGH-2 のとおり、後付け migration コストが高い。

### D-7. 受講者最大規模 < 500 名前提で同期バッチ維持

- Phase 3 着手時点での想定: 全テナント合計 < 500 名
- 同期一括処理 (Cloud Run endpoint で tenant 走査 + user 並列度 8) を採用
- 280s timeout に収まる規模を runbook で監視
- scale trigger: 全テナント合計 300 名超で Cloud Tasks 移行を Phase 4 OQ として登録

**採用理由**: Cloud Tasks 採用は初期実装コスト +30% で、< 500 名規模ではメリットが小さい (Codex CRITICAL-4 緩和)。Workspace 送信上限 2,000 msg/day/user (rolling 24h) に対しても、500 名 × CC 1 名 = 1,000 件/週 で余裕 (Codex HIGH-3)。完了通知 sender (`system@279279.net`、ADR-037) と進捗レポート sender が同一の場合は両レーン合計を 2,000 で抑える必要があるため、cron を 30 分ずらす対策と合わせて運用する。

**確定済 OQ**: §確定済 OQ #8 (decision-maker 承認済) で「< 500 名 / 同期バッチ」を選択。

**再評価条件**: 全テナント合計 300 名超 (runbook 監視) または Workspace 送信上限抵触で Cloud Tasks 移行を検討。

### D-8. RFC 2231 filename dual-form (RFC 5987 ではない)

- 添付ファイル名 (進捗 PDF は日本語含む) の MIME header は **RFC 2231** に準拠
- `Content-Disposition: attachment; filename="..."; filename*=UTF-8''<percent-encoded>` の dual-form
- 既存 `gmail-draft.ts:buildFilenameParam` のロジックを参考に `gmail-dwd-send.ts` 内でローカル実装 (Phase 4 で `mime-utils.ts` 共通化を検討)
- Phase 3e smoke で Gmail / Outlook365 / Apple Mail での実デコード確認

**採用理由**: RFC 5987 は HTTP header の標準で、メール MIME attachment parameter の根拠ではない (Codex HIGH-5)。spec / コード / コメントで RFC 2231 と記載することで、将来「規格根拠を確認したい」となった際の調査ミスを防ぐ。

### Settings PUT を patch semantics に変更 (Codex HIGH-4)

D-1〜D-8 の前提として、`DispatchSettings` PUT を **patch semantics** に変更する (in-memory / firestore 両実装で対応)。storage 層で undefined フィールドを既存値で保持し、FE は always-send-all 戦略。これにより PR 3a→3d の間に旧 UI 経由で `progressReport` が消失する事故を防ぐ。

### 不採用案 (横断)

#### 案 A: 完了通知の reservation モデル流用

`completion_notifications/{userId}` (userId 単位・永続) を進捗レポートにも流用する案。

- **不採用理由**: 完了通知は「1 人 1 回限り」、進捗レポートは「定期的に毎回送る」で意味論が真逆。流用すると全ユーザーの再送が永続ブロックされる。

#### 案 B: append-only collection (pending state なし)

`progress_report_sends/{occurrenceId}__{userId}` に status を持たせず sent/failed のみ。

- **不採用理由**: Codex CRITICAL-2 のとおり crash 後 orphan を扱えない。pending state は Phase 3 の最小限の安全策。

#### 案 C: Cloud Tasks による recipient 分割

各 recipient を Cloud Tasks の単位に分割して並列処理する案。

- **不採用理由**: 受講者 < 500 名規模で同期バッチが timeout しないため初期実装コスト ROI ナシ。300 名超で再評価する。

#### 案 D: 完了通知レーン本体の改造 (`100% フィルタを外す`)

`run-completion-notifications.ts` の 100% フィルタを外して進捗レポートも兼ねる案。

- **不採用理由**: 完了通知の reservation モデル (1 人 1 回) と進捗レポートの定期送信が両立しない。両レーン独立の D-1 と矛盾。

## Consequences

### 良い影響

- 完了通知レーンと進捗レポートレーンが完全独立化 → 障害・設定・監査の切り分けが明確
- Cloud Scheduler at-least-once delivery + crash シナリオの両方に対して堅牢な冪等性 (D-2 + D-3)
- Firestore レベルの transactional lane lock で race condition を構造的に排除 (D-4)
- 受講中フィルタ (Plan A 4 軸) により「期限切れに進捗レポート」「未着手 0% に進捗レポート」の運用事故を防ぐ (D-5、退会判定は将来の User schema 拡張 PR で追加対応)
- テナント単位 opt-out が分離されているため、業務的に「完了通知だけ ON / 進捗レポートだけ ON」が表現できる (D-6)
- patch semantics 化で旧 UI 経由の設定消失事故を防ぐ
- 既存 `progress-pdf.ts` / `ProgressPdfDocument` / `buildMailTemplate` が完全流用できるため、進捗レポートの中身は手動レーン (ADR-034) と同一体験

### 受容するトレードオフ

- ADR-034 (Phase 2 手動 Gmail 下書き) と Phase 3 (定期自動配信) で「同じ進捗レポートを送る経路が 2 つある」状態。混乱を runbook で明示する必要あり。
- `system@279279.net` (ADR-037) の Workspace 送信上限 2,000 msg/day を完了通知と進捗レポートの両レーンで共有。受講者数規模に応じた監視が必要 (300 名超で再評価)。
- pending state machine + transactional lane lock の導入で Phase 3c の Integration テストが大規模 (25 シナリオ)。Evaluator 分離プロトコル + Codex review のセカンドオピニオン併用が必須。
- 旧 `run-lock.ts` と新 `lane-lock.ts` の 2 機構が並存する期間が発生 (Phase 4 で統合検討)。
- テナント単位 `progressReportEnabled=true` の設定が opt-in (default false) のため、業務スーパー管理者が各テナントについて決裁・設定する作業が発生する (runbook で cutover step として明示)。

### 既存実装への影響

- `dispatch-storage.ts` interface 拡張 + in-memory / firestore 両実装に 7 メソッド追加 → Phase 3a で破壊的変更ナシで対応 (新規メソッド追加のみ)
- `gmail-dwd-send.ts` に `buildMessageMime` 新 export + 既存 `buildCompletionMime` を薄い wrapper にリファクタ → byte-for-byte 回帰テストで後方互換保証
- `DispatchSettings` PUT を patch semantics に変更 → Phase 3a で既存 PUT 経路の挙動を保ったまま実装 (旧 UI でフィールド全件送信されている挙動も維持)
- `super_dispatch_runs/{runId}` の `laneId` フィールド追加 → 既存 doc は欠落時 `"completion"` 扱いで後方互換
- `tenants/{tid}.progressReportEnabled?: boolean` 追加 → optional でマイグレーション不要

### 再評価条件 / 将来 OQ

- 全テナント合計 300 名超: Cloud Tasks 移行を検討 (D-7 再評価)
- Workspace 送信上限抵触: 30 分ずらした cron でも足りなければ Cloud Tasks 必須
- 完了通知 + 進捗レポートの両方を一括 ON/OFF したい運用要件: 親スイッチ `dispatchEnabled` 追加を検討
- 進捗レポートの件名・本文をテナント単位に変更したい要件: 設定 UI 拡張 + DispatchSettings に template フィールド追加
- pending lease 切れの `manual_review_required` 件数が多い (Cloud Run 不安定): heartbeat lease 更新 / Cloud Tasks 移行

## References

- 設計仕様書: `docs/specs/2026-06-01-progress-report-dispatch-design.md`
- 実装計画: `docs/specs/2026-06-01-progress-report-dispatch-impl-plan.md`
- フロー図: `docs/specs/2026-06-01-progress-report-dispatch-flow.mmd`
- Plan ファイル (Plan stage 議論記録): `~/.claude/plans/eager-jumping-hoare.md`
- Codex セカンドオピニオン thread ID: `019e82e8-4228-79c1-a63a-d3c4e7359731` (Plan stage 取得、PR 3c で継続利用)
- Cloud Scheduler at-least-once delivery: https://docs.cloud.google.com/scheduler/docs/reference/rest/v1/projects.locations.jobs
- Gmail Workspace 送信上限: https://support.google.com/a/answer/166852
- RFC 2231 (MIME parameter value extensions): https://www.rfc-editor.org/rfc/rfc2231
