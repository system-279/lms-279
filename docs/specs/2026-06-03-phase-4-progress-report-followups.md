# Phase 4 進捗レポート follow-up OQ 整理 (試案)

Phase 3 全 5 PR (#506 / #509 / #511 / #512 / #514 / #515) の Quality Gate 5 段階で発見された改善候補 15 件を **impl-plan 反映前の試案** として整理。

優先度 (HIGH / MEDIUM / LOW) は AI 試案。**最終的な優先度・着手順は開発者決裁** (4 原則 §1)。

実装計画 (`docs/specs/2026-06-01-progress-report-dispatch-impl-plan.md`) §「Phase 4 OQ」への正式転記 / spec 新設は本ドキュメント決裁後に実施。

## TL;DR

- **16 件**: PR 3c 由来 7 件 (OQ-A〜OQ-G)、PR 3d 由来 5 件 (#8-12)、PR 3e 由来 3 件 (#13-15)、業務スーパー管理者連絡文案レビュー由来 1 件 (#16)
- **HIGH 確定 3 件** (#10、#13、**#16 採用決定**): silent fail 経路 + 業務安全性
- **MEDIUM 候補 10 件**: 設計品質 / DRY / 並行更新 / 型整合 / 仕様拡張
- **LOW 候補 3 件** (OQ-C / OQ-D / OQ-G): 命名 / 集約 / データ品質
- **着手戦略 (#16 採用後)**: **α-7 (dry-run UI 両レーン化) を最優先**、cutover Step 6 (本番有効化) 前に完了必須

## 採用決定 (2026-06-03、開発者決裁)

- **OQ #16 採用** = dry-run UI (両レーン化スコープ B)
  - 理由: 「今回の機能は安全性が重要」、寄与できる内容は積極導入の方針
  - スコープ: **進捗レーン + 完了通知レーンの両方を同時 UI 化** (UX 統一性 + 業務スーパー管理者の運用習熟負担最小化)
  - 着手順: **最優先**、cutover Step 6 (進捗レーン本番有効化) 前完了必須
  - 規模見積もり: ~500-800 LOC (FE viewer + BE endpoint × 2 レーン、共通コンポーネント化前提)
  - 完了通知レーン側のリスク: 既本番稼働中のため、追加 UI のみで既存挙動・既存 endpoint は変更しない (read-only viewer 追加のみ)

## OQ 一覧 (優先度試案付き)

| # | source | 内容 | 影響 | 優先度試案 | 集約 PR 案 |
|---|---|---|---|---|---|
| OQ-A | PR 3c code-review / Codex | `run-progress-reports.ts` ⇄ `run-completion-notifications.ts` の DRY 重複 (`sha256` / `runWithConcurrency` / `getHttpStatus` / `classifyAndRecord`) を `dispatch-lane-common.ts` に集約 | 保守性 | MEDIUM | PR α-2 |
| OQ-B | PR 3c code-review / Evaluator | AC-PR-13 `pdf_too_large` 専用 counter を `RunProgressReportsResponse.pdfTooLarge` フィールドとして shared-types に追加 | 観測性 | MEDIUM | PR α-4 |
| OQ-C | PR 3c code-review | lane name (`"completion"` / `"progress"`) の string が route 層と service 層で独立定義 → `computeOccurrenceId(laneId, scheduleTime)` を lane-neutral helper として共有化 | 設計整合 | LOW | PR α-2 |
| OQ-D | PR 3c code-review | `cc-email-validator.ts` の partial-invalid 反応を高位 helper (`validateCcAndAudit`) として両レーンから呼び出す形に統合 | DRY | LOW | PR α-2 |
| OQ-E | PR 3c code-review / 既存 OQ-5 | `gmail-dwd-send.ts` の MIME 構築部 (`buildMessageMime`) を `mime-builder.ts` に分離 (transport ⇄ encoding 分離) | 設計分離 | MEDIUM | PR α-3 |
| OQ-F | PR 3c Evaluator FAIL | AC-PR-20 「Retry-After 尊重」が `executeSendWithRetry` に未実装。500 名超で 429 多発時に不十分の可能性 | 本番安定性 (大規模) | MEDIUM (規模次第で HIGH) | PR α-4 |
| OQ-G | PR 3c Codex MEDIUM | `durationMs` の実処理時間化 (clock provider inject)。現状 `now - new Date(runStartedAt)` で同一 timestamp により基本 0ms | データ品質 | LOW | PR α-6 |
| #8 | PR 3d Codex MEDIUM | tenant CC API の always-send-all 戦略は version 管理なしで lost update リスク (現状 `completionNotificationEnabled` も同じ既存設計問題) | 並行更新 | MEDIUM | PR α-5 |
| #9 | PR 3d Codex MEDIUM | tenant-notification-cc PUT response が `existing` 由来で構築、並行更新時に stale 値返却 | 並行更新 | MEDIUM | PR α-5 |
| #10 | PR 3d silent-failure C-1 | PUT handler try-catch 欠落 + global error handler shape 不一致 (silent fail 経路) | **silent fail (本番)** | **HIGH** | PR α-1 |
| #11 | PR 3d silent-failure I-3 | `progressReport.enabled=true` + `scheduleDaysOfWeek=[]` の矛盾状態が save 可能で inline warning なし | 設定ミス検知 | MEDIUM | PR α-5 |
| #12 | PR 3d type-design Critical | 型の 3 役兼任 (`TenantNotificationCcConfig` が storage / wire response / wire request) + `progressReportEnabled?` の 2 義性 (省略=保持 / 明示=置換) | 設計品質 | MEDIUM | PR α-2 |
| #13 | PR 3e silent-failure I-2 | Firestore TTL Policy `already exists` skip がフィールド名不一致を hide (`ttlExpireAt` 以外の名前で既存 TTL 登録 → 90 日保持 AC-PR-17 破綻リスク) | **silent fail (AC 破綻)** | **HIGH** | PR α-1 |
| #14 | PR 3e silent-failure I-5 | CLI tenant 走査の per-tenant error が全 tenant fail-stop + 失敗痕跡が tenantsSummary に残らないため debug 困難 | 可観測性 | MEDIUM | PR α-6 |
| #15 | PR 3e type-design Important 集約 | producer-side breakdown invariant assertion 不在 + `settingsLoaded` + `settingsSnapshot` redundant pair + `scaleTriggerExceeded` derived の同期問題 + PDF range ordering の型保証不在 | 型/不変条件 | MEDIUM | PR α-2 |
| #16 | 業務スーパー管理者連絡文案レビュー (本セッション、開発者指摘) | 配信前 dry-run (対象者一覧 + 推定通数 + 規模試算) を管理画面に表示する UI 追加。**両レーン (進捗 + 完了通知) 同時 UI 化**。現状 GitHub Actions workflow_dispatch でしか取得できず、業務スーパー管理者が画面で事前確認できない (Phase 3 設計時の見落とし) | **安全性 + 業務自律性 (運用影響大)** | **HIGH (採用決定)** | PR α-7 |

## 着手戦略試案 (8 PR 集約)

| PR 案 | 含む OQ | スコープ | 規模見積 | 優先順 |
|---|---|---|---|---|
| **PR α-1** (HIGH 集約) | #10、#13 | PUT handler error path 強化 + TTL Policy フィールド名検証 | 中規模 (~150-200 LOC) | **最優先** |
| **PR α-2** (設計品質集約) | OQ-A、OQ-C、OQ-D、#12、#15 | `dispatch-lane-common.ts` 新設 + lane-neutral helper + 型分解 | 大規模 (~400-600 LOC) | 2 番目 |
| **PR α-3** (MIME 分離) | OQ-E | `mime-builder.ts` 分離 | 中規模 (~150 LOC) | 3 番目 |
| **PR α-4** (AC 拡張) | OQ-B、OQ-F | `pdf_too_large` counter + Retry-After 尊重 (仕様改訂 + AC 追加検討) | 中-大規模 (~250-350 LOC + 仕様調整) | 4 番目 |
| **PR α-5** (dispatch-settings 整合性) | #8、#9、#11 | version 管理 (or optimistic lock) + PUT response 整合 + 矛盾 save 阻止 inline warning | 中規模 (~200-300 LOC) | 5 番目 |
| **PR α-6** (CLI 可観測性) | #14、OQ-G | per-tenant error 痕跡 + clock provider inject (durationMs 実処理時間化) | 中規模 (~150-200 LOC) | 6 番目 |
| **PR α-7** (dry-run UI 両レーン化) | #16 | super-admin 画面「ディスパッチ設定」に dry-run 結果表示 UI 追加 (対象者一覧 + 推定通数 + 規模試算 + skip 理由内訳 + scaleTrigger 警告)。**進捗 + 完了通知の両レーン同時 UI 化** (共通 viewer コンポーネント)。BE は既存 `progress-report-dry-run-cli.ts` / `dispatch-dry-run-cli.ts` の共通ロジックを HTTP endpoint 化 (read-only、既存挙動を変更しない) | 大規模 (~500-800 LOC、FE viewer + BE endpoint × 2 レーン) | **採用決定、最優先、cutover Step 6 前完了必須** |

> α-1 / α-2 は依存関係なし、α-2 → α-3 → α-4 → α-5 → α-6 は緩い順序 (α-2 で集約した lane-common module を α-3 以降で参照する形)。**α-7 は採用決定済、最優先着手**。他 PR と独立着手可、cutover Step 4 / Step 5 を画面化するため **本番有効化 (Step 6) 前完了必須** (= cutover 開始は α-7 マージ後)。

## 各 OQ の根拠リンク

### PR 3c 由来 (OQ-A 〜 OQ-G)
- archive: `docs/handoff/archive/2026-06-03-session-56.md` §「Phase 4 OQ 7 件」
- PR: #512 commit message + handoff

### PR 3d 由来 (#8-12)
- PR: #514 commit message (Codex MEDIUM 反映 + review-pr 反映)
- 詳細:
  - #8、#9: Codex セカンドオピニオン thread
  - #10: silent-failure-hunter Critical-1
  - #11: silent-failure-hunter Important-3
  - #12: type-design-analyzer Critical

### PR 3e 由来 (#13-15)
- PR: #515 commit message (Codex 反映 + review-pr 反映)
- 詳細:
  - #13: silent-failure-hunter Important-2
  - #14: silent-failure-hunter Important-5
  - #15: type-design-analyzer Important 集約

### 本セッション由来 (#16)
- 起点: 業務スーパー管理者連絡文案の改訂レビュー (2026-06-03)
- 開発者指摘: 「テナント opt-in / 配信曜日・時刻 / メインスイッチ ON はすべて画面で完結すべきで、開発者を経由する設計だと運用上不便」
- 検証で発覚: 配信前の対象者一覧確認 (dry-run) **のみ** GitHub Actions workflow_dispatch でしか取得できず、業務スーパー管理者の自律的運用に開発者経由が必要になる構造
- Phase 3 設計時 (`docs/specs/2026-06-01-progress-report-dispatch-design.md`) で UI 化スコープに含めなかった見落としを Phase 4 で補う形

## 開発者決裁ポイント (本ドキュメント承認時)

1. **優先度試案** (HIGH 2 件 / MEDIUM 10 件 / LOW 3 件) の妥当性
2. **OQ-F 優先度**: 受講者規模次第で HIGH 昇格を検討
   - 全テナント合計 < 300 名 → MEDIUM 維持で可
   - dry-run で 300 名近接 → HIGH 昇格
3. **PR 集約方針** (α-1 〜 α-6) の妥当性
   - 集約しすぎ ⇄ 細切れすぎのバランス
   - α-2 の規模 (~400-600 LOC) は review-pr 5 agents 対応上限近接
4. **着手順** (α-1 → α-2 → ... の順序)
   - 並行可: α-1 と α-2 は独立着手可
5. **impl-plan への反映タイミング**
   - 即時: `2026-06-01-progress-report-dispatch-impl-plan.md` §「Phase 4 OQ」を本表で置換
   - 別 spec: `docs/specs/2026-06-XX-phase-4-impl-plan.md` を新規作成 (impl-plan skill で正式化)
6. **cutover との関係**
   - α-1 (HIGH) は cutover 開始前に着手すべきか、cutover 後でも可か
   - #13 (TTL Policy フィールド名検証) は Step 0b 実施前に対応する方が安全
   - **α-7 (#16 dry-run UI)** は cutover Step 6 (本番有効化) 前に完了するのが望ましい (業務スーパー管理者の事前確認ステップを画面化、開発者経由を削減)
7. **OQ #16 (dry-run UI) のスコープ — 採用決定済**
   - 表示項目: 対象者一覧 / 推定通数 / 規模試算 / skip 理由内訳 / `scaleTriggerExceeded` 警告
   - データ取得経路: 既存 `progress-report-dry-run-cli.ts` + `dispatch-dry-run-cli.ts` を共有 module 化 + HTTP endpoint で UI に提供
   - 表示位置: super-admin「ディスパッチ設定」画面の各レーンセクション直下に "配信前プレビュー" タブ追加
   - 両レーン UI 化: 進捗 + 完了通知の両方を同時 UI 化、共通 `DryRunPreview` コンポーネントで UX 統一
   - 完了通知レーン側の保護: 既本番稼働中のため、追加 UI のみで既存 endpoint・既存挙動は変更しない (read-only viewer 追加のみ)
   - 課金影響: dry-run 自体は Gmail / Firestore write を伴わないため軽量だが、PDF 試算ロジックの read 量を確認

## Phase 4 OQ と postponed Issue の関係

postponed Issue 4 件 (#274 / #275 / #276 / #405) はすべて allowed_emails / Gmail draft 系で **本 Phase 4 OQ と独立**。本 spec の集約 PR に含めない。
