# Session Handoff — 2026-04-22 (Session 7)

## TL;DR

**ADR-031 Phase 3 (GCIP マルチテナント移行) 着手 + 2 Sub-Issue 連続 merge**。Issue #272 Phase 3 の実装計画を `/impl-plan` で策定し、9 Sub-Issue に分解。完全独立な Sub-Issue A (Tenant スキーマ拡張) と Sub-Issue C (UID 紐付け原子性 CAS) を並行実装、両方 merge 完了。Quality Gate は **5-6 層検証プロトコル** (impl-plan → simplify → safe-refactor → Evaluator → review-pr 6 並列 → codex review) で、Evaluator REQUEST_CHANGES + Codex APPROVE_WITH_REVISIONS の指摘をすべて反映 or follow-up Issue 化。

- **マージ完了** (今セッション): PR #314, PR #315
- **新規 Issue**: 3 件 (#312 Sub-Issue A / #313 Sub-Issue C / #316 Codex follow-up)
- **Close**: 2 件 (#312, #313)
- **Issue Net**: +1（#316 のみ残存、全起票 triage 基準該当）
- **Open 推移**: Session 6 末 7 件 → Session 7 末 8 件 (P0:1 / P1:1 / P2:6)

## 🚀 次セッション開始時の必読手順

```bash
# 1. 状況復元
cat docs/handoff/LATEST.md

# 2. 現在の OPEN Issue（P0: 1 / P1: 1 / P2: 6）
gh issue list --state open --limit 15

# 3. main CI が緑であることを確認
gh run list --branch main --limit 3

# 4. 次セッション候補 Issue のコンテキスト
gh issue view 316  # Sub-Issue C follow-up (最優先候補)
gh issue view 272  # Phase 3 親 Issue (進捗トラッキング)
```

---

## セッション成果物 (2026-04-22 Session 7)

### マージ完了 PR

| # | Issue | Title | Merge Commit |
|---|-------|-------|-------------|
| #314 | #312 | feat(tenant): Tenant スキーマに gcipTenantId + useGcip 追加 | `a7b9116` |
| #315 | #313 | feat(auth): findOrCreateTenantUser の UID 紐付け原子性 CAS 化 | `24b49b6` |

### 起票 Issue

| # | Title | Label | 起票理由（triage 基準） |
|---|-------|-------|----------------------|
| #312 | Sub-Issue A: Tenant スキーマ拡張 (gcipTenantId + useGcip) | P1 | **#5 ユーザー明示指示**（`/impl-plan` で分解 + 並行実装合意） |
| #313 | Sub-Issue C: UID 紐付け原子性 (CAS + 監査) | P1 | **#5 ユーザー明示指示**（同上） |
| #316 | Sub-Issue C follow-up: 初回 create 経路の並行 race 対応 | P1 | **#4 Codex review rating 7 + confidence 80**（PR #315 レビュー時に発見、ADR-031 §UID保持戦略の未対応部分） |

### 主要変更の要点

#### PR #314 (Sub-Issue A: Tenant スキーマ拡張)
- `TenantMetadata` + `SuperTenantListItem` に `gcipTenantId: string | null` + `useGcip: boolean` 追加
- 新規テナント作成時の初期値は `{null, false}`（非 GCIP でカナリア展開前）
- `PATCH /super/tenants/:id` で 2 フィールド更新可能（super-admin のみ）:
  - 整合性ガード: `useGcip=true` は `gcipTenantId !== null` を要求（400 `gcip_tenant_id_required`）
  - 前後空白は自動 trim、空文字/whitespace-only は 400 `invalid_gcip_tenant_id`
  - **Firestore 内一意性検証**: 他テナント重複時 409 `gcip_tenant_id_conflict`（Codex BLOCKING 指摘対応、ADR-031 認証サイロ分離原則）
- `parseTenantGcipFields` helper で default 値読み取りを 4 箇所で統一（/simplify 指摘反映）
- 11 テスト追加（バリデーション 4 + POST 初期値 1 + PATCH 正常系 3 + 一意性 2 + Partial Update 1）

#### PR #315 (Sub-Issue C: UID 紐付け原子性 CAS)
- `DataSource.setUserFirebaseUidIfUnset` を I/F + Firestore (`runTransaction`) + InMemory の 3 実装で追加
- `SetFirebaseUidResult` discriminated union (4 状態: updated / already_set_same / conflict / not_found)
- `tenant-auth.ts` の email fallback で `updateUser({firebaseUid})` を CAS 呼び出しに置換
  - `status: conflict` → 403 `uid_reassignment_blocked`（既存 UID と異なる UID は silent 上書きしない）
  - `status: not_found` → 403 `uid_cas_user_not_found`（稀: 並行 DELETE）
  - `TenantAccessDenialReason` union に 2 reason 追加
- UID 紐付けインシデントは `platform_auth_error_logs` にも tenant 横断で記録（super-admin 監視用、Evaluator BLOCKING 指摘対応）
- 型不整合 `firebaseUid` 検知 throw + 空文字引数 precondition throw（silent-failure-hunter 指摘反映）
- `assertCasSuccessOrThrow` + `persistPlatformUidConflictLog` helper 抽出（code-simplifier 指摘反映）
- 12 テスト追加（DataSource CAS 7 + tenant-auth 5）

### Quality Gate 検証結果

| ゲート | #314 | #315 |
|-------|------|------|
| `/simplify` (reuse/quality/efficiency 3 並列) | ✅ helper 抽出 / 整合性コメント強化 | ✅ helper 抽出 / 型不整合 guard |
| `/safe-refactor` (型安全性・エラー処理) | ✅ gcipTenantId trim 追加 | ✅ 独立 try/catch 確認 |
| **Evaluator 分離** (5 ファイル+ 新機能) | ✅ APPROVE_WITH_REVISIONS → 反映 | ✅ REQUEST_CHANGES → 反映 |
| `/review-pr` 6 エージェント並列 | ✅ Critical 2 + Important 2 反映 | ✅ Important 6 反映 |
| `/codex review` セカンドオピニオン | ✅ BLOCKING 1 (gcipTenantId 一意性) 反映 | ✅ IMPORTANT 1 (初回 create race) → #316 follow-up |
| CI (Build / Lint / Test / Type Check) | ✅ 全 PASS | ✅ 全 PASS |

### レビュー対応サマリ

#### PR #314 の BLOCKING / Critical 対応
1. **Evaluator BLOCKING**: AC#7 統合テスト 5 パターン不整合（「true 正常」「Partial Update 保持」未テスト） → 正常系 3 テスト追加
2. **Evaluator IMPORTANT**: gcipTenantId trim なし保存 → Phase 3 照合整合性のため自動 trim 追加
3. **comment-analyzer Critical**: PATCH ガード「ケース a」コメント誤記 → 修正
4. **pr-test-analyzer Critical (rating 8)**: Case (b) 未テスト → 拒否テスト追加
5. **Codex BLOCKING (REJECT)**: gcipTenantId 一意性制約未実装 → PATCH で Firestore query + 409 拒否 + 2 テスト

#### PR #315 の BLOCKING / Important 対応
1. **Evaluator BLOCKING**: AC#4 `platform_auth_error_logs` 未記録 → `handleTenantAccessDenied` に platform 書き込み追加
2. **Evaluator Critical**: `not_found` 時の reason 誤マップ → `uid_cas_user_not_found` 専用 reason 追加
3. **silent-failure-hunter I-2**: 型不整合 firebaseUid の silent 受け入れ → throw + logger.error
4. **type-design #2 / pr-test #1**: firebaseUid 空文字引数 + テスト → precondition throw + 2 テスト追加
5. **pr-test #2**: platform 書き込み失敗時の main フロー継続テスト追加
6. **code-simplifier HIGH**: `assertCasSuccessOrThrow` + `persistPlatformUidConflictLog` helper 抽出

## 品質ゲート結果 (最終)

| ゲート | 結果 |
|--------|------|
| `npm run lint` | ✅ PASS |
| `npm run type-check` (全 4 workspace) | ✅ PASS |
| `npm test -w @lms-279/api` (sequential) | ✅ 583 passed (既存 571 + 新規 12 for PR #315、PR #314 merge 後の main は別計測) |
| main CI (PR #314 / #315 両 push 時) | ✅ 全 SUCCESS (Build 53s / Lint 36-38s / Test 55-59s / Type Check 39-42s) |

**Known issue**: ローカル並列テスト実行は flaky (Issue #308 の CI 遅延と同根)。sequential (`--fileParallelism=false`) または単独ファイル実行で全 PASS を確認。CI clean 環境では常時 PASS。

## main 現状

```
24b49b6 feat(auth): findOrCreateTenantUser の UID 紐付け原子性 CAS 化 (Issue #313) (#315)
a7b9116 feat(tenant): Tenant スキーマに gcipTenantId + useGcip 追加 (Issue #312) (#314)
fdbbdc8 docs(handoff): Session 6 (2026-04-22) ハンドオフ更新 (#311)
094ce4d feat(super-admin): platform_auth_error_logs 読み取り API 追加 (Issue #299) (#309)
```

- **working tree**: clean
- **残留 Node プロセス**: なし ✅
- **Deploy to Cloud Run**: PR #315 merge 時に自動実行中（次セッション開始時に CI 状態確認推奨）

## 次セッションの着手候補（優先度順）

### 🔴 P0 残

**Issue #272 Phase 3 (GCIP 移行本体)** — 引き続きクリティカルパス。Phase 1.1 + Phase 3 前提作業はユーザー側ブロッカー継続（下記）。

### 🟡 P1 候補 (Phase 3 Sub-Issue、着手可能)

| # | Sub-Issue | 内容 | 依存 |
|---|-----------|------|------|
| **#316** | Sub-Issue C follow-up | 初回 create 経路の並行 race 対応（sentinel doc / atomic `findOrCreateUserByEmailAndUid`） | Sub-Issue C (#313) マージ済（前提充足） |
| 未起票 | Sub-Issue B | Public tenant-info endpoint (認証不要、ログイン前テナント解決用) | Sub-Issue A (#312) マージ済 |
| 未起票 | Sub-Issue D | GCIP Tenant 作成スクリプト (scripts/create-gcip-tenants.ts) | Sub-Issue A (#312) マージ済 |
| 未起票 | Sub-Issue E | BE GCIP 経路の tenant 整合性チェック (`decodedToken.firebase.tenant` 検証) | Sub-Issue A + C マージ済 |
| 未起票 | Sub-Issue F | FE `auth.tenantId` + ログイン前テナント解決 | Sub-Issue B |
| 未起票 | Sub-Issue G | tenant 作成時の GCIP 自動化 | Sub-Issue A + E |
| 未起票 | Sub-Issue H | Staging + カナリア + 全テナント移行 | 全 Sub-Issue |

**推奨**: 次セッションは **#316 → Sub-Issue B/D 並行 → Sub-Issue E** の順で着手。依存グラフ上のクリティカルパス順。

### 🟢 P2 残 (Phase 3 と並行可)

- **#308**: E2E CI リクエスト遅延 7-9 秒/request 根本調査（CLAUDE.md Debug Protocol 3 件目警告対象）
- **#310**: platform_auth_error_logs 読み取り時の transient/permanent 分離 (503 vs 500)
- **#281**: allowed_emails 監査 CLI refactor
- **#274 / #275 / #276**: Phase 5 allowed_emails 運用改善 (可視化 / UX / セッション失効)

## ブロッカー / ユーザー側タスク（継続）

| 項目 | 内容 | 影響 |
|------|------|------|
| GCP Console: OAuth 同意画面 External 化 | Issue #272 Phase 1.1 | sayori-maeda@kanjikai.or.jp 再ログイン復旧 + Phase 3 前提 |
| 本番 `normalize-users-email.ts` dry-run / execute | PR #287 マージ済（Session 5）、Phase 3 移行前に推奨 | users.email 大文字/空白混入の正規化 |
| GCP Identity Platform Essentials+ Tier 有効化 + 費用試算 | Sub-Issue H (Staging) の前提 | MAU 次第で数千円〜数万円/月 |
| Staging 環境の Identity Platform 有効化 | Sub-Issue H の staging 検証の前提 | - |

## ADR / ドキュメント状態

- **ADR-031** As-Is 表更新済み（本 handoff PR で更新）:
  - 「UID 紐付けの原子性」行: 🟡 → ✅（Issue #313 / PR #315 で対応済み、#316 で follow-up 明記）
  - 「Tenant スキーマ拡張」行: Sub-Issue A 対応済み（PR #314 で追加）
- **docs/handoff/LATEST.md**: 本ファイル更新 (Session 7)
- **handoff サイズ**: 本ファイル（500 行以下目標 OK）

## Issue Net 変化（CLAUDE.md KPI）

```
Close 数: 2 件 (#312, #313)
起票数: 3 件 (#312, #313, #316)
Net: +1 件 (#316 のみ残存)
```

**Net +1 の正当性**:
- **#312, #313** は同セッション内で起票 → 実装 → close のサイクル完結。`/impl-plan` 分解の成果物として必須の Issue 化（triage #5）
- **#316** (Codex review IMPORTANT): triage #4 (rating ≥ 7 かつ confidence ≥ 80) 該当。Sub-Issue C スコープ外の新規発見で、ADR-031 §UID保持戦略 の未対応部分を明示化。本来 ADR-031 に暗黙的に含まれていた要件を Issue tracker 上で可視化した形

**rating 5-6 の review agent 提案は全て PR コメント / follow-up タスク / 本 handoff に吸収**:
- type-design-analyzer Important #1 (exhaustiveness check): 5 状態未満で ROI 低、別 PR
- silent-failure-hunter I-1 (transient/permanent 分類): 既存 PATCH 全体の課題、ADR 横断対応
- silent-failure-hunter I-3 (構築/書き込み区別): 運用影響軽微、Phase 5 cleanup
- pr-test-analyzer Gap #3-5 (rollback / dev モード non-CAS / UID hit 経路): regression 発生頻度低、必要時に後続 PR
- code-reviewer Important #1 (runTransaction retry JSDoc): doc 追加のみ、別 PR

## 作業ブランチ状態

```
main: 24b49b6 (#315 merged) / a7b9116 (#314 merged)

docs/handoff-session-7-2026-04-22 (本ファイル更新用、PR 作成予定)
```

main 直接 push なし、destructive 操作なし、残留 Node プロセスなし ✅。

## 参考: 今セッションで使った規範 / スキル

### 新規に活用した規範・スキル
- **`/impl-plan`**: Issue #272 Phase 3 を 9 Sub-Issue に分解 + 依存グラフ + AC 策定（本セッションで一番インパクトのあった skill 起動）
- **`/codex review` (MCP 版)**: PR #314 / #315 両方でセカンドオピニオン取得、実際に BLOCKING 発見（gcipTenantId 一意性、初回 create race）→ 単独 review では見つからない盲点をカバー
- **Evaluator 分離プロトコル** (`rules/quality-gate.md`): 両 PR で REQUEST_CHANGES / APPROVE_WITH_REVISIONS を受け、すべて反映

### 繰り返し活用した規範
- **`/review-pr`** 6 エージェント並列: code-reviewer / pr-test-analyzer / silent-failure-hunter / type-design-analyzer / comment-analyzer / code-simplifier
- **`/simplify`** 3 並列 (reuse / quality / efficiency): helper 抽出の判断に活用
- **`feedback_pr_merge_authorization.md`**: PR 番号単位で明示認可（#314 / #315 個別に承認取得）
- **`feedback_issue_triage.md`**: Net +1 だが全起票が triage 基準該当、rating 5-6 は吸収

### 学び / 次セッションへの引き継ぎ
- **pre-push hook flaky**: Issue #308 既知の並列実行 flaky が pre-push quality check でも block 発生。single fork 実行 or retry で解消可能だが、恒久対応は #308 で
- **ADR-031 As-Is 表の並行更新**: 同じ行を触る PR 複数並行 (A + C) は conflict リスクあり → C 側は ADR 更新を見送り、handoff PR で一括更新のパターンが実用的
- **Codex セカンドオピニオンの価値**: 5 層レビュー後でも新しい BLOCKING を発見（Sub-Issue A で gcipTenantId 一意性、Sub-Issue C で初回 create race）。大規模 PR では必須と再確認
