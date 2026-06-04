# Phase 4 PR α-7 実装計画: dry-run UI 両レーン化

OQ #16 (採用決定 2026-06-03、`docs/specs/2026-06-03-phase-4-progress-report-followups.md`) の実装計画。

## ⚠️ PR #490 撤廃理由の解消 (2026-06-03、必読)

**PR #490 (2026-05-24、merged)** で同じ dry-run UI が同一開発者の判断で撤廃された経緯あり。本セッションで「前提変化として再導入」を決裁 (4 原則 §1 decision-maker 判断、2026-06-03)。

### 前提変化

| 観点 | 過去 (PR #490) | 今回 (α-7) |
|---|---|---|
| フェーズ | 完了通知レーン単独の cutover 検証段階 (テスト的) | 進捗レポートの本格 cutover + 業務スーパー管理者の自律運用 |
| 運用主体 | AI 主導 (workflow_dispatch) で開発者が代行 | 業務スーパー管理者本人が自律判断 |
| UI 必要性 | テスト段階のため UI 不要 | 本番運用の自律判断のため UI 必須 |

### 過去撤廃理由とその解消方針 (impl-plan で必ず守る)

| 過去撤廃理由 (PR #490) | 今回の解消方針 (本 impl-plan で必須) |
|---|---|
| 「test-send / dry-run は本番運用では常用不要」 | 本番運用段階で業務スーパー管理者の自律的事前確認が必要に (前提変化、開発者決裁済) |
| 「むだな UI を増やさない」 | 「自律性のために必須な UI」として位置付け、過剰機能は禁止 |
| **「UI に残すと誤操作リスク (誤って本番受講者へ test-send 等)」** | **test-send 機能は再導入しない (本 PR では絶対に追加しない)**。dry-run viewer のみ |
| 「AI 代替経路 (workflow_dispatch) で十分」 | 業務スーパー管理者が AI 経由なしで自律判断する設計、workflow_dispatch は AI / 開発者用途で並存 |
| 「`enabled=true` 切替を AI が誤って操作するリスク」 | 本機能は **read-only viewer のみ**、settings 更新 endpoint は触らない (既存 PUT は不変) |
| 「dry-run と settings 編集 UI が混在する誤操作リスク」 | dry-run viewer は **タブ分離** で settings 編集と視覚的にも分離 (AC-α7-12 で必須化) |

### 過去撤廃の影響を受けるファイル (再作成 or 流用判断)

| ファイル | 過去 PR #490 での扱い | 今回 α-7 での扱い |
|---|---|---|
| `services/api/src/routes/super/dispatch-dry-run.ts` | 削除 | **新規作成** (read-only、両レーン対応、過去より厳格な single-flight + limiter) |
| `services/api/src/routes/super/__tests__/dispatch-dry-run.test.ts` | 削除 | **新規作成** (両レーン + regression test 強化) |
| `web/app/super/dispatch-settings/components/DryRunPanel.tsx` | 削除 | **新規作成** (`_components/DryRunPreview.tsx` として、過去と異なり両レーン discriminated 設計) |
| `services/api/src/routes/super/dispatch-test-send.ts` | 削除 | **再導入しない** (本 PR スコープ外、永久撤廃方針) |
| `web/app/super/dispatch-settings/components/TestSendButton.tsx` | 削除 | **再導入しない** (本 PR スコープ外、永久撤廃方針) |
| `services/api/src/middleware/rate-limiter.ts` (`testSendLimiter`) | 削除 | **再導入しない**。代わりに **新規 `dispatchDryRunLimiter`** を作成 (testSendLimiter とは別名・別設計) |
| `packages/shared-types` の `DryRunResponse` / `DryRunTarget` | 削除 | **新規追加** (`DispatchDryRunResult` discriminated union として、過去型より厳格) |

> 過去撤廃された型を **そのままの名前で復活させない**。名前重複で git log 検索性が崩れるため、新規名前 (`DispatchDryRunResult` / `DryRunPreview` / `dispatchDryRunLimiter`) を採用。

## Codex セカンドオピニオン反映 (2026-06-03)

Codex (thread `019e8fc7-441b-7653-9983-f5f4b6c2f251`) の独立観点レビューを反映済。主要指摘:

| 優先度 | 指摘 | 反映先 |
|---|---|---|
| **High** | `DryRunResult` は optional だらけの lane-neutral ではなく **discriminated union** で厳密化 | §3 タスク B + §5 AC + §推奨 DTO 例 |
| **High** | dry-run endpoint 専用の **連打防止 / レート制限 / single-flight** を AC 化 | §3 タスク C + §5 AC-α7-12 |
| **High** | 完了通知 regression は CLI smoke だけに依存せず **service/endpoint test** を追加 | §3 タスク C3 + §5 AC-α7-07 強化 |
| **Medium** | 規模見積もりを **~1,500-2,000 LOC** に更新、BE PR が +600 LOC 超で 3 PR 分割条件追記 | §3 タスク詳細 + §3 PR 分割 |
| **Medium** | AC に **a11y / responsive / empty state / data freshness** 追加 | §5 AC-α7-09 〜 13 |
| **Medium** | 性能 AC「5 秒以内」を flaky な絶対条件ではなく **p95 / timeout / 表示方針込み** に修正 | §5 AC-α7-08 |
| **Low** | 既存 router / page の旧コメント更新を E1 に含める | §3 タスク E1 |

## 1. ゴール

業務スーパー管理者が **「誰に / 何通 / どれくらいの規模で」配信されるかを画面で事前確認** し、開発者経由なしに本番有効化を判断できる状態を作る。両レーン (進捗レポート + 完了通知) で UX を統一する。

成功定義:
- super-admin 画面に「配信前プレビュー」タブが両レーンに存在
- 業務スーパー管理者が画面操作のみで dry-run 結果 (対象者一覧 + 推定通数 + 規模試算 + skip 理由内訳 + scaleTrigger 警告) を取得できる
- cutover runbook の Step 4-5 (dry-run 取得 + 対象一覧レビュー) を画面操作に置換できる

## 2. スコープ

### 含むもの
- BE: 既存 CLI ロジックの共有 module 化 + super-admin HTTP endpoint 追加 (両レーン)
- FE: super-admin 画面に共通 dry-run viewer コンポーネント追加 (両レーン)
- shared-types: dry-run DTO の lane-neutral 化と export
- cutover runbook の Step 4-5 を画面操作版に更新
- 既存 CLI / workflow_dispatch の入出力互換維持 (regression 回避)

### スコープ外 (Phase 4 別 OQ で扱う)
- dry-run 結果の Firestore キャッシュ / 履歴保持 (毎回オンザフライ実行)
- 完了通知レーンの既存挙動・既存 endpoint の変更 (read-only 追加のみ)
- α-1 (#10 / #13 silent fail 強化)、α-2 (DRY 集約)、α-3〜α-6 の改善
- 業務スーパー管理者向けのチュートリアル動画 / 文書 (別タスク)

### 永久に再導入しない (PR #490 撤廃方針を維持)
- **test-send 機能** (実際にメール送信する機能、PR #490 撤廃理由「誤って本番受講者へ送信リスク」)
- `dispatch-test-send.ts` route / `TestSendButton.tsx` / `testSendLimiter` / `TestSendResponse` / `TEST_SEND_DAILY_LIMIT` 等の関連シンボル
- 過去型 `DryRunResponse` / `DryRunTarget` の **同名復活** (新型 `DispatchDryRunResult` を採用)

### 将来の拡張
- dry-run 結果の CSV エクスポート
- 「特定テナントのみ」絞り込みプレビュー
- PDF サイズ実測 (現状は経験値レンジ)

## 3. タスクグラフ

### 依存関係図
```
A1: BE 共有 module 化 (progress)
A2: BE 共有 module 化 (completion)
B:  shared-types DTO 追加 (lane-neutral) ← A 完了後
C1: BE endpoint 新規 (両レーン) ← A1, A2, B 完了後
C2: BE router mount + auth 統合 ← C1 完了後
C3: BE integration test ← C1, C2 完了後
A3: CLI スクリプトを薄い wrapper に書き換え ← A1, A2 完了後
D1: FE 共通コンポーネント DryRunPreview ← B 完了後
D2: FE dispatch-settings 統合 ← D1 完了後
D3: FE データ取得 hook + loading/error state ← D1 完了後
E1: cutover runbook 更新 ← C, D 完了後
E2: Quality Gate 5 段階 ← E1 完了後
```

### 実行順序
1. **PR α-7-BE**: A1 + A2 + B + C1 + C2 + C3 + A3 (BE 完結、merge 可能、CLI 互換維持)
2. **PR α-7-FE**: D1 + D2 + D3 + E1 + E2 (FE 統合 + runbook + Quality Gate)

> 2 PR 分割の根拠: 単一 PR (~500-800 LOC) は review-pr 5 agents の負荷が高い。BE merge → FE merge で半分ずつにし、各 PR で Quality Gate 5 段階を独立実施。BE 単独 merge 時点では UI 未提供だが既存挙動は不変。

### タスク詳細

| タスク | 概要 | 影響ファイル | 推定規模 | 並列可否 |
|---|---|---|---|---|
| **A1** | progress-report-dry-run-cli.ts から純粋ロジック分離 | `services/api/src/services/dispatch/dry-run/progress-report-dry-run.ts` (新) | 中 (~200 LOC) | ○ (A2 と並列) |
| **A2** | dispatch-dry-run-cli.ts から純粋ロジック分離 | `services/api/src/services/dispatch/dry-run/completion-notification-dry-run.ts` (新) | 中 (~180 LOC) | ○ (A1 と並列) |
| **B** | shared-types に **discriminated union** `DispatchDryRunResult = ProgressDryRunResult \| CompletionDryRunResult` + 共通 base + DryRunTenantSummary + DryRunSkipReason 追加。lane 別フィールド (進捗: estimatedPdfSizeKbRange / scaleTriggerExceeded / 完了: wouldNotify / mimePreview) は厳密に分離 (optional 大量化禁止、§推奨 DTO 例参照) | `packages/shared-types/src/dispatch.ts` | 中 (~120 LOC) | × (A 後) |
| **C1** | BE endpoint 新規: GET `/api/v2/super/dispatch/dry-run/progress` + `/completion` + **専用 limiter (10 req/min/superAdminEmail)** + **single-flight 制御** (同一 lane 実行中の重複リクエストは 429 or 進行中結果共有) | `services/api/src/routes/super/dispatch-dry-run.ts` (新)、`services/api/src/middleware/dispatch-dry-run-limiter.ts` (新) | 中 (~200 LOC) | × (A,B 後) |
| **C2** | dispatch-super-router.ts に dispatch-dry-run router mount + super-admin auth 適用 + 専用 limiter wire | `services/api/src/routes/super/dispatch-super-router.ts` | 小 (~15 LOC) | × (C1 後) |
| **C3** | BE integration test 強化: 両 endpoint × 200/403/429/500、InMemoryDataSource、ADR-028。**完了通知 regression を CLI smoke だけに依存せず service/endpoint level で確認** (既通知除外 / tenant disable / invalid email / no published courses / MIME preview の全パスを test 化) | `services/api/src/routes/super/__tests__/dispatch-dry-run.test.ts` (新)、`services/api/src/services/dispatch/dry-run/__tests__/*.test.ts` (新) | 大 (~400 LOC) | × (C1, C2 後) |
| **A3** | CLI 2 本を共有 module を呼ぶ薄い wrapper に書き換え (入出力互換 + smoke 維持) | `scripts/progress-report-dry-run-cli.ts`, `scripts/dispatch-dry-run-cli.ts`, `scripts/__tests__/*` | 小 (~60 LOC) | × (A 後) |
| **D1** | 共通 DryRunPreview コンポーネント (props: lane, result, isLoading, error) | `web/app/super/dispatch-settings/_components/DryRunPreview.tsx` (新) | 中 (~200 LOC) | × (B 後) |
| **D2** | dispatch-settings/page.tsx の両レーンセクションにプレビュータブ統合 | `web/app/super/dispatch-settings/page.tsx`, `_components/TenantCcEditor.tsx` (既存) | 中 (~120 LOC) | × (D1 後) |
| **D3** | データ取得 hook (`useDryRun(lane)`) + loading / error / retry UI + **自動連打防止 (初回表示で自動取得しない、明示再取得ボタンのみ、実行中は同 lane disabled)** | `web/app/super/dispatch-settings/_hooks/useDryRun.ts` (新) | 中 (~120 LOC) | × (D1 後) |
| **E1** | cutover runbook Step 4-5 を画面操作版に置換 + **「α-7 FE merge 前後は同時に配信設定を編集しない」運用ロック注記** (α-5 未実施の lost update リスク回避) + 既存 router / page の旧コメント更新 | `docs/runbook/dxcollege-progress-report-cutover.md`, `docs/runbook/dxcollege-completion-notification-cutover.md`, `services/api/src/routes/super/dispatch-super-router.ts`, `web/app/super/dispatch-settings/page.tsx` (コメント更新のみ) | 小 (~80 LOC) | × (D 後) |
| **E2** | Quality Gate 5 段階 × 2 PR | (全 PR) | - | - |

**合計規模見積もり (Codex 反映後更新)**: **~1,500-2,000 LOC** + test。production ~850-1,100 LOC、test ~650-900 LOC。Codex 指摘:
- A3 「薄 wrapper 60 LOC」は低すぎる可能性 → 100-150 LOC に上振れ想定
- C3 「両 endpoint × 状態 × 両レーン差分」は 250 LOC では不足 → 400 LOC に拡大
- FE は Playwright + component + hook test 込みで 300-500 LOC

### PR 分割の発動条件 (Codex 反映)

- 基本: **2 PR** (α-7-BE → α-7-FE)
- **3 PR 化発動条件**: BE PR が **+600 LOC 超** または CLI 出力互換テストが大幅追加になった場合、`α-7-BE-foundation` (A1 + A2 + B + A3 + service-level test) + `α-7-BE-endpoint` (C1 + C2 + C3 endpoint test) + `α-7-FE` (D + E) の 3 PR 化を許容
- 判断は α-7-BE 実装中に LOC 計測時点で決裁

## 4. 統合影響分析 (Phase 2.5)

### 4.1 関連既存機能

#### 依存する既存機能
- `FirestoreDispatchStorage` / `FirestoreTenantDataLoader`: dry-run ロジックの read 源
- `super-admin auth middleware` (`services/api/src/middleware/super-admin.ts`): 新規 endpoint も適用
- `progress-pdf` モジュール: PDF サイズ推定の経験値 (実 generation はしない)
- `dispatch.ts` 既存型 (`DispatchSettings` / `DispatchLane`): lane-neutral 設計の前提
- `ADR-028 InMemoryDataSource`: BE integration test の中心

#### 依存される可能性がある機能
- 既存 `progress-report-dry-run.yml` / `dispatch-dry-run.yml` workflow: CLI 入出力互換が保たれる限り影響なし (A3 で確認)
- 既存 super-admin 画面の他セクション (dispatch-runs / audit-logs): 影響なし (別タブ・別 endpoint)
- cutover runbook Step 4-5: 操作手順が画面化される (E1 で更新)

#### 関連 ADR / 仕様書
- ADR-028 (InMemoryDataSource 中心の統合テスト): ✅ 踏襲
- ADR-039 (Phase 3 進捗レポート): ✅ 整合
- `docs/specs/2026-06-01-progress-report-dispatch-design.md`: dry-run 仕様の根拠
- `docs/specs/2026-05-20-completion-notification-design.md`: 完了通知 dry-run 仕様

### 4.2 E2E フロー

#### メインフロー (本機能で実現したいもの)
1. 業務スーパー管理者が `/super/dispatch-settings` を開く
2. 「進捗レポート 定期配信」セクションの「配信前プレビュー」タブをクリック
3. → FE が `GET /api/v2/super/dispatch/dry-run/progress` を叩く
4. → BE が tenants/* + super_dispatch_settings/global を read、dry-run 結果を返却 (write なし)
5. FE が結果表示 (対象者一覧 / 推定通数 / 推定処理時間 / scaleTrigger 警告 / skip 理由内訳)
6. 業務スーパー管理者が内容確認 → 問題なければメインスイッチを ON
7. → 既存 PR 3d のスイッチ ON フロー (`progressReport.enabled=true`) → 次の cron で送信開始

#### 完了通知レーン版フロー
1-5 と同じ、対象 endpoint = `/api/v2/super/dispatch/dry-run/completion`

### 4.3 検証計画

| レベル | 対象 | 必須 |
|---|---|---|
| 単体 | dry-run service module (A1, A2)、DryRunPreview コンポーネント (D1) | ✅ |
| 統合 | BE endpoint × 認証 × InMemoryDataSource (C3) | ✅ |
| E2E (Playwright) | dispatch-settings 画面でプレビュータブ → 表示 → メインスイッチ ON | ✅ (関連機能 2+ で必須) |
| Regression | CLI 入出力互換 (A3 smoke 維持)、既存 workflow_dispatch dry-run 動作 | ✅ |

## 5. Acceptance Criteria (Phase 2.7)

### AC-α7-01 (機能)
- **Given**: 業務スーパー管理者が認証済 / 進捗レーンの settings が存在
- **When**: `/super/dispatch-settings` 画面で「進捗レポート 定期配信」セクションの「配信前プレビュー」タブをクリック
- **Then**: dry-run 結果が表示される (対象者一覧 / 推定通数 / 推定処理時間 / 全テナント totalWouldSendCount)
- **検証**: Playwright

### AC-α7-02 (機能、完了通知レーン)
- **Given**: AC-α7-01 と同条件、完了通知レーン側
- **When**: 「完了通知メール」セクションの「配信前プレビュー」タブをクリック
- **Then**: 完了通知レーンの dry-run 結果が表示される (同じ UI コンポーネントが使われる)
- **検証**: Playwright

### AC-α7-03 (UI: scale warning)
- **Given**: dry-run 結果に `scaleTriggerExceeded=true` (>300 名超)
- **When**: プレビュータブを開く
- **Then**: 警告バナーが表示される (色 / アイコン / 文言: "受講者数 N 名は規模が大きいため、段階的な配信をご検討ください")
- **検証**: Playwright + unit test

### AC-α7-04 (UI: skip 理由内訳)
- **Given**: tenantsSummary の少なくとも 1 件で `skipped=true`
- **When**: プレビュータブを開く
- **Then**: skip 理由 (progress_report_disabled / no_published_courses / tenant_not_active / tenant_doc_not_found) が表示される (テナント別、内訳件数付き)
- **検証**: Playwright + unit test

### AC-α7-05 (API: 認証)
- **Given**: super-admin 以外の認証ユーザー or 未認証
- **When**: `GET /api/v2/super/dispatch/dry-run/{progress|completion}` を叩く
- **Then**: 403 Forbidden (super-admin only)
- **検証**: integration test

### AC-α7-06 (API: read-only 保証、PR #490 撤廃理由解消)
- **Given**: dry-run endpoint を任意のタイミングで叩く
- **When**: BE 処理完了
- **Then**:
  - Firestore **write** / Gmail **send** / PDF **generation** はすべて発生しない (CLI と同じく read-only)
  - **test-send 機能は含まない** (実際に受講者へメール送信する経路は本 endpoint に存在しない、PR #490 撤廃理由「誤って本番受講者へ送信リスク」の解消)
  - dispatch-settings PUT 経路への影響なし (`progressReport.enabled` 等の書き換えは別 endpoint で既存運用維持)
- **検証**:
  - integration test (Firestore write 監視 + Gmail send mock fail-on-call + PDF generation mock fail-on-call)
  - grep で `test-send` / `TestSend` / `testSendLimiter` の本 PR への混入を否定
  - 実装レビュー (D1 / C1 で `enabled` 更新経路が存在しないことを確認)

### AC-α7-07 (Regression: CLI 互換 + 完了通知 service-level、Codex 反映で強化)
- **Given (CLI 互換)**: 既存 `progress-report-dry-run.yml` / `dispatch-dry-run.yml` workflow の入力
- **When**: A3 で書き換えた CLI を実行
- **Then**: 出力 JSON 構造 / 値 / artifact フォーマットが書き換え前と一致
- **検証 (CLI 互換)**: smoke test (既存 `scripts/__tests__/progress-report-dry-run-cli.smoke.ts` の値域不変)
- **Given (完了通知 service regression)**: 完了通知レーンの dry-run service module を直接呼ぶ
- **When**: 以下の各パスを実行 — (a) 既通知ユーザー除外、(b) tenant disable、(c) invalid email reject、(d) no published courses skip、(e) MIME preview 生成
- **Then**: いずれも書き換え前の挙動と一致 (output 値同値、副作用なし)
- **検証 (完了通知)**: service-level test (`services/api/src/services/dispatch/dry-run/__tests__/completion-notification-dry-run.test.ts` 新規)

### AC-α7-08 (Performance、Codex 反映で flaky 化回避)
- **Given**: テナント数 10、各テナント 100 名想定の Firestore
- **When**: dry-run endpoint を叩く
- **Then**:
  - p95 目標 **5 秒以内** (絶対条件ではない)
  - **10 秒超** で UI に「集計に時間がかかっています」表示
  - FE timeout **30 秒** (タイムアウト時は明示 error + retry ボタン)
- **検証**: integration test (p95 ベンチマーク 50 回 sampling、failure threshold p95 > 8s) + Playwright (10s/30s 表示)

### AC-α7-09 (Accessibility、Codex 反映で追加)
- **Given**: dry-run プレビュータブ
- **When**: keyboard 操作 (Tab / Shift+Tab / Enter / Space) のみで操作
- **Then**:
  - すべてのインタラクティブ要素 (タブ / 再取得ボタン / 警告バナーのリンク) に focus が当たる
  - 各要素に `aria-label` または可視ラベル
  - focus visible (outline) が CSS で表示される
  - 警告バナーは `role="alert"` (or `role="status"`)
- **検証**: Playwright (keyboard navigation テスト) + axe-core (a11y violations)

### AC-α7-10 (Responsive、Codex 反映で追加)
- **Given**: 画面幅 **375px** (iPhone SE 想定)
- **When**: dry-run プレビュータブを開く
- **Then**:
  - 対象者一覧 / skip 内訳 / 警告バナーが横崩れしない
  - 長い email / tenantId は折り返し or `text-overflow: ellipsis` で省略
  - タブ切替が縦並びに崩れず操作可能
- **検証**: Playwright (375px viewport、768px viewport)

### AC-α7-11 (Empty / Disabled State、Codex 反映で追加)
- **Given**: 以下の状態のいずれか
  - (a) 対象者 0 件 (totalWouldSendCount=0)
  - (b) settings 未保存 (settingsLoaded=false)
  - (c) lane disabled (進捗: progressReportEnabled=false / 完了: completionNotificationEnabled=false)
  - (d) scheduleDaysOfWeek=[] (進捗の空配列)
- **When**: プレビュータブを開く
- **Then**: 非エンジニア向け文言で各状態を説明
  - (a) "配信対象の受講者がいません"
  - (b) "配信設定がまだ保存されていません。曜日と時刻を設定してください。"
  - (c) "このレーンは現在 OFF です"
  - (d) "配信曜日が選択されていません"
- **検証**: Playwright + component unit test

### AC-α7-12 (Request Control、Codex 反映で追加)
- **Given**: super-admin がプレビュータブを開く
- **When**: タブを開く / 再取得を試行
- **Then**:
  - 初回表示で自動連打しない (明示「再取得」ボタンで取得開始)
  - 取得実行中は同 lane の再取得ボタン disabled
  - BE 専用 limiter (10 req/min/superAdminEmail) を super-admin 単位で適用
  - 同一 lane の同時実行は single-flight (重複は進行中結果共有 or 429)
- **検証**: Playwright (連打防止) + integration test (limiter / single-flight)

### AC-α7-13 (Data Freshness、Codex 反映で追加)
- **Given**: dry-run 結果取得後
- **When**: プレビュータブを表示
- **Then**:
  - `evaluatedAt` (取得時刻、JST 表示) を画面表示
  - 5 分以上経過した場合「結果が古い可能性があります」インフォメッセージ
  - cutover runbook Step 5 認可時刻と紐付けるための時刻表記が明示
- **検証**: Playwright + component unit test

## 6. 実行戦略 (Phase 3)

### 6.1 並列化判断

- **A1 と A2**: 並列実装可 (異なるファイル、異なるレーン)
- **D1 と D3**: D1 が型・骨格、D3 が hook 実装、D1 完了後に D3 を進める
- **BE PR (A,B,C,A3) と FE PR (D,E)**: 順次 (BE merge 待ち)
- **Quality Gate 5 段階**: 各 PR 内で逐次

### 6.2 エージェント活用

| 段階 | エージェント |
|---|---|
| 詳細仕様確認 (A1/A2 実装前) | Explore (CLI 既存ロジック調査) |
| 実装 (A1, A2 並列) | general-purpose |
| BE endpoint 実装 (C1, C2) | general-purpose |
| Test 実装 (C3) | general-purpose |
| FE 実装 (D1, D2, D3) | general-purpose |
| Quality Gate Evaluator (5+ ファイル + 新機能発動条件 ✅) | evaluator |
| Codex セカンドオピニオン (3+ ファイル / 200+ 行) | Codex |
| review-pr (5 agents 並列) | pr-review-toolkit:review-pr |

### 6.3 品質ゲート (大規模)

- PR α-7-BE: Lint + Type Check + Test + Build + `/safe-refactor` + `/code-review high` + Evaluator + Codex + `/pr-review-toolkit:review-pr`
- PR α-7-FE: 同上 + Playwright E2E
- 各 PR で AC-α7-01〜08 のうち該当する基準を検証

### 6.4 cutover との関係

- **cutover Step 1, 2** (テナント opt-in + 配信曜日・時刻初期化、業務スーパー管理者作業) は **本 PR と並行可** (進捗レーンは `enabled=false` の間 no-op、完了通知レーンは既稼働)
- **cutover Step 3** (cron no-op 確認、AI 主導) も並行可
- **cutover Step 4, 5** (dry-run + 認可) は **PR α-7-FE merge 後に画面操作化**
- **cutover Step 6** (本番有効化) は **PR α-7-FE merge 後**

## 7. リスクと緩和 (Codex 反映で強化)

| リスク | 緩和策 |
|---|---|
| 完了通知レーン側で regression | endpoint は新規追加のみ、既存 endpoint 変更なし、**CLI 互換 (A3 smoke) + service-level test (C3) の 2 層** で守る (CLI smoke だけに依存しない、Codex High 指摘) |
| dry-run の Firestore read 量増加で課金影響 | **1 回 dry-run で複数 Firestore read** が発生 (settings 1 + tenant docs N + users / course / progress / notification reads)。専用 limiter (10 req/min/superAdmin) + FE 自動連打防止 (明示再取得 + 実行中 disabled) + single-flight。Codex 高優先指摘 |
| dry-run endpoint への DoS / 誤操作 | super-admin 限定だが誤操作・ブラウザ再試行・複数タブで read 蓄積。**専用 limiter (10 req/min/superAdminEmail) + lane 単位 single-flight** を AC-α7-12 で必須化 |
| 業務スーパー管理者が UI を見ても判断できない | scaleTrigger 警告 + skip 理由内訳 + テナント別件数を明示。**AC-α7-11 (empty/disabled state) を非エンジニア向け文言で必須**。文言調整は E1 で実機確認 |
| BE PR と FE PR の merge 順序遵守失敗 | BE PR を merge → FE PR は BE PR の commit を含む状態で開く |
| Phase 4 OQ α-2 (DRY 集約) との競合 | α-7 は新規ファイル中心。**過度な共通化を避け、α-2 に再集約余地を残す** (Codex 指摘)。α-7 の共有 module は「両 CLI を呼ぶ純粋ロジック分離」に留め、lane-common 統合は α-2 に委ねる |
| Phase 4 OQ α-1 (#10 / #13 silent fail) の先送りリスク | α-7 実装中に dispatch-settings PUT (#10) や TTL setup (#13) を触るなら、**α-1 を先行 or 同時実装** (Codex 指摘)。α-7 が触らないなら α-7 → α-1 で OK |
| 完了通知レーンの A3 CLI 抽出による既存 workflow 影響 | 本番稼働中のため、CLI extraction の regression テストを **CLI smoke + service-level test の 2 層** で厚く守る |
| **α-5 未実施の lost update リスク (Codex 指摘)** | dispatch-settings PUT は always-send-all 戦略で version 管理なし。α-7 FE 開発 / 確認と業務スーパー管理者の Step 1, 2 操作が重なる時間帯は **「同時編集しない」運用ロックを runbook E1 で注記** |
| 設計判断の落とし穴: optional 大量化 | shared-types DryRunResult は **discriminated union** で厳密化 (Codex High 指摘)。lane 別 detail は subcomponent で受ける (§推奨 DTO 例) |
| **PR #490 撤廃 UI 再導入の整合性** (2026-05-24 同一開発者判断との一見の矛盾) | 「前提変化」を decision-maker が決裁済 (2026-06-03)。本 impl-plan §「PR #490 撤廃理由の解消」で過去理由 6 件 × 解消方針を 1:1 マッピング。前提変化の継続性は cutover 後 3 ヶ月で再評価 (運用実績との整合確認) |
| **test-send 機能の誤復活リスク** (実装中に「ついでに」復活させない) | スコープ外明示 + AC-α7-06 で grep 検証 + PR review で「test-send / TestSend / testSendLimiter / TEST_SEND_DAILY_LIMIT の本 PR への混入を否定」を必須化 |
| 過去シンボル復活で git log 検索性低下 | 過去型 `DryRunResponse` / `DryRunTarget` の同名復活禁止。新規シンボル `DispatchDryRunResult` / `DryRunPreview` / `dispatchDryRunLimiter` を採用 |

## 8. 推奨 DTO 例 (Codex 提供、High 指摘の具体化)

shared-types に追加する型は **discriminated union** で厳密化。optional 大量化を避け、UI 側で判断材料が薄まらないようにする。

```ts
// packages/shared-types/src/dispatch.ts (タスク B で追加)

export type DispatchDryRunResult = ProgressDryRunResult | CompletionDryRunResult;

export interface DryRunBase {
  lane: DispatchLane; // 既存型を活用
  evaluatedAt: string; // ISO8601、AC-α7-13 で UI 表示
  settingsLoaded: boolean;
  tenantsScanned: number;
  tenantsSummary: DryRunTenantSummary[];
}

export interface ProgressDryRunResult extends DryRunBase {
  lane: "progress";
  totalWouldSendCount: number;
  totalCcCount: number;
  estimatedDurationMs: number;
  estimatedPdfSizeKbRange: { min: number; typical: number; max: number };
  scaleTriggerExceeded: boolean; // AC-α7-03 警告バナー条件
}

export interface CompletionDryRunResult extends DryRunBase {
  lane: "completion";
  wouldNotifyCount: number;
  wouldNotify: CompletionDryRunTarget[]; // 既存 DryRunTargetCli を移管
  mimePreview: DryRunMimePreview[]; // 既存型を移管
}

// 共通フィールドのみ持つ TenantSummary (lane に依らない)
export interface DryRunTenantSummary {
  tenantId: string;
  skipped: boolean;
  skipReason?: DryRunSkipReason;
  usersScanned: number;
  // 以下は lane で意味が異なる場合は lane 別型に移すべき
  // 進捗: candidateCount / invalidEmailCount / completedCount / wouldSendCount / ccCount
  // 完了: wouldNotifyCount のみ
  // → さらに分離する場合は ProgressDryRunTenantSummary / CompletionDryRunTenantSummary に discriminated union 化
}

export type DryRunSkipReason =
  | "tenant_doc_not_found"
  | "tenant_not_active"
  | "progress_report_disabled"     // progress lane 専用
  | "completion_notification_disabled" // completion lane 専用
  | "no_published_courses";
```

**FE コンポーネント設計**:
- 共通 shell: `DryRunPreview` (tabs, retry button, evaluatedAt 表示, error / loading state, AC-α7-12 連打防止)
- lane 別 detail: `ProgressDryRunDetail` (scaleTrigger 警告 + PDF 試算 + 推定時間) / `CompletionDryRunDetail` (MIME preview + wouldNotify table)
- 過剰共通化は禁止 (Codex 指摘): 完全共通 table に寄せると、完了通知の MIME preview と進捗の PDF/scale 試算のどちらかが薄くなる

## 9. 関連リソース

- Phase 4 OQ spec: `docs/specs/2026-06-03-phase-4-progress-report-followups.md` (OQ #16)
- Phase 3 設計仕様: `docs/specs/2026-06-01-progress-report-dispatch-design.md`
- Phase 3 完了通知設計: `docs/specs/2026-05-20-completion-notification-design.md`
- cutover runbook (進捗): `docs/runbook/dxcollege-progress-report-cutover.md`
- cutover runbook (完了通知): `docs/runbook/dxcollege-completion-notification-cutover.md`
- 既存 dry-run CLI: `scripts/progress-report-dry-run-cli.ts`, `scripts/dispatch-dry-run-cli.ts`
- shared-types: `packages/shared-types/src/dispatch.ts`
- 既存 super-admin route: `services/api/src/routes/super/dispatch-super-router.ts`
- 既存 dispatch-settings 画面: `web/app/super/dispatch-settings/page.tsx`
