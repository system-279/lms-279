# Session Handoff — 2026-04-23 (Session 9)

## TL;DR

**ADR-031 Phase 3 Sub-Issue B 完了**。認証不要 Public tenant-info endpoint `GET /api/v2/public/tenants/:tenantId` を新設。FE が GCIP 経路のログイン前に `auth.tenantId` へ `gcipTenantId` をセットするための入口。Quality Gate 6 層（impl-plan / simplify / safe-refactor / Evaluator / review-pr 6エージェント / codex review）を通過し、`/review-pr` で検出された**情報漏洩リスク**（`name` 露出で顧客名 enumeration 可能）を初期実装から除去。Issue net **0** (#320 起票→同 PR で close、Session 7/8 合意の「実装直前起票」方針を継続)。Codex 最終判定 BLOCKING なし、merge 可能水準。

- **マージ完了** (今セッション): PR #321
- **新規 Issue**: 1 件 (#320 実装直前起票、同 PR でクローズ)
- **Close**: 1 件 (#320)
- **Issue Net**: **0** (実装直前起票パターンにつき scope bloat ではない)
- **Open 推移**: Session 8 末 7 件 → Session 9 末 7 件 (P0:1 / P2:6)

## 🚀 次セッション開始時の必読手順

```bash
# 1. 状況復元
cat docs/handoff/LATEST.md

# 2. 現在の OPEN Issue（P0: 1 / P2: 6）
gh issue list --state open --limit 15

# 3. main CI が緑であることを確認
gh run list --branch main --limit 3

# 4. 次セッション最優先候補 (ADR-031 Phase 3 残 Sub-Issue)
gh issue view 272  # Phase 3 親 Issue
# Sub-Issue D/E/F/G/H は実装直前に起票（Net KPI 維持方針）
```

---

## セッション成果物 (2026-04-23 Session 9)

### マージ完了 PR

| # | Issue | Title | Merge Commit |
|---|-------|-------|-------------|
| #321 | #320 | feat(public): 認証不要 Public tenant-info endpoint 追加 (Sub-Issue B) | `2cb7c23` |

### 起票 Issue

| # | 状態 | タイトル | 理由 |
|---|------|---------|------|
| #320 | CLOSED (同 PR で完結) | [P1][Phase 3] Sub-Issue B: Public tenant-info endpoint (ADR-031) | Session 7/8 合意の「実装直前起票」。triage 基準 #5（ユーザー明示）準拠 |

### 主要変更の要点 (PR #321)

- **新規 endpoint** (`services/api/src/routes/public.ts`): `GET /api/v2/public/tenants/:tenantId`（認証不要）
  - 認証なしで FE が `{ id, status, gcipTenantId, useGcip }` を取得
  - **初期実装にあった `name` フィールドは `/review-pr` の security 指摘で除去**（enumeration 成功時の顧客名漏洩防止）
  - `authLimiter` 流用（10 req/min/IP）、`/api/v2/public/*` 配下にマウント
- **共有型** (`packages/shared-types/src/tenant.ts`):
  - `PublicTenantInfo` (id / status / gcipTenantId / useGcip)
  - `PublicTenantInfoResponse` ({ tenant })
  - JSDoc に threat model（何を意図的に除外するか）を明記
- **セキュリティ設計**:
  - **Enumeration 防止**: 未登録 / RESERVED_TENANT_IDS / 不正フォーマットは全て同一の 404 + 同一 Cache-Control
  - **fail-closed status**: `"active"` / `"suspended"` 以外の値は `suspended` に強制（active 漏洩防止）
  - **HTTP キャッシュ**: 200 / 404 とも `public, max-age=60`（header 差分で存在有無の識別を防止）、503 は `no-store`
  - stale-while-revalidate は不採用（super-admin の suspend 操作が SWR 期間分遅延するのを回避）
- **観測性**:
  - Firestore エラーは `logger.error` で `errorType: "public_tenant_firestore_error"` + `firestoreErrorCode` / `errorMessage` / `stack` を構造化 → IAM regression を Cloud Logging alert で page 可能
  - status / name / gcipTenantId / useGcip の不正値は `logger.warn` で観測化
- **response 構築の単一化**: `toPublicTenantInfo()` helper に集約し「外に出してよいフィールド」を single audit point で管理
- **テスト追加** (21 件、`routes/__tests__/public.test.ts`):
  - 正常系 3 / 情報漏洩防止 1 / 404 経路完全等価性 1（回帰防止） / 503 系 1 / データ正規化 4 / HTTP キャッシュ 1 / 観測性 logger spy 2 / authLimiter wiring 1
- **ドキュメント更新** (`docs/api.md`): 公開テナント情報セクション追加、セキュリティ設計の threat model 明記

### Quality Gate 検証結果

| ゲート | 結果 |
|-------|------|
| `/impl-plan` (3+ ステップ + 5+ ファイル) | ✅ AC 10 件策定、Phase 2.7 完了 |
| `/simplify` (reuse + quality + efficiency 3 並列) | ✅ HIGH 2 件（parseTenantGcipFields 再利用、fail-closed status）+ MEDIUM 2 件（sendNotFound helper、Cache-Control）反映 |
| `/safe-refactor` (3+ ファイル) | ✅ 冗長型キャスト削除 |
| **Evaluator 分離** (5+ ファイル + 新機能) | ✅ APPROVE_WITH_REVISIONS → MEDIUM 2 件（503 no-store、name invalid warn）+ LOW 1 件（コメント）反映 |
| `/review-pr` 6 エージェント並列 | ✅ **Critical 4 件**（`name` 削除 = 顧客名 enumeration 漏洩防止 / 503 logger.error 昇格 / Cache-Control 統一 / 404 完全等価性テスト）+ **Important 4 件**（warn spy / authLimiter wiring / task-tracking 参照削除 / mapper 集約）反映 |
| `/codex review` セカンドオピニオン | ✅ **BLOCKING なし**、全 4 焦点（name 削除後の残存リスク / Cloud Logging alert / Cache-Control 副作用 / fail-closed 一貫性）で OK / NICE-TO-HAVE のみ |
| CI (Build / Lint / Test / Type Check) | ✅ 全 PASS（API 629 テスト、うち public 21 件） |

### `/review-pr` の重要な発見

**初期実装から `name` フィールドを削除した判断**が本セッションで最も重要な修正。security レビューエージェントが以下を指摘:

- tenantId の enumeration（timing / Cache-Control 差分で可能）に加えて `name` が返ると「顧客名の列挙」が成立
- FE のログイン前処理に必要なのは `gcipTenantId` / `useGcip` / `status` のみで、`name` は UX 向け add-on
- `name` 露出は ADR-031 の threat model（ホワイトリスト主義 + ゼロトラスト）と不整合

対応として `PublicTenantInfo` から `name` を除去し、FE は login 前は汎用的な welcome 画面、login 後に personalize する運用とした。`/codex review` のセカンドオピニオンでも "`name` 削除により 'knowing tenantId への状態開示' のみが残り、enumeration 成功時の実害が大幅低下" として妥当性を追認。

### 却下した指摘（エージェント提案の triage）

`/review-pr` と security エージェントから多数の提案があったが、以下は triage 基準（rating ≥ 7 + confidence ≥ 80 + 実害あり）不満たしで本 PR 内修正せず:

| 提案 | 却下理由 |
|---|---|
| jitter による timing attack 対策 | `name` 削除で enumeration の実害低下、over-engineering |
| 専用 `publicTenantLookupLimiter` (5 req/min) | 既存 `authLimiter` で実運用 OK、ROI 低 |
| CORS `credentials: false` on `/api/v2/public` | pre-existing 全エンドポイント共通パターン、本 PR 責任外 |
| zod ランタイム検証 | 4 フィールド DTO にはオーバーエンジニアリング |
| length boundary / path-traversal テスト | 既存 regex で防御済み、suggestion レベル |
| `id` も削除 | REST convention / FE keying を考慮し保持 |

### Defer 項目 (本 PR スコープ外、handoff へ)

- **`rate-limiter.ts` の 429 応答形式が ADR-010 に非準拠**: pre-existing 問題。`{ error: { code, message } }` のネスト形式で返却中。本 PR では endpoint 固有の 200/404/503 のみフラット化。対応 triage は別 Issue 候補（rating 7 相当、ただし既知の仕様）
- **Firestore エラーの transient / permanent 分類**: silent-failure エージェントの I1 指摘。現状は全て 503 を返すが `permission-denied` は 500 相当、`unavailable` は 503 + Retry-After が理想。#310 (platform_auth_error_logs の transient / permanent 分離) と同系統の運用課題

---

## 残タスク

### 🔴 P0 残

**Issue #272 Phase 3 (GCIP 移行本体)** — 引き続きクリティカルパス。Phase 1.1 (OAuth External 化) + Phase 3 後半 (Identity Platform 有効化) はユーザー側 GCP Console 作業の継続ブロッカー。

### 🟡 Phase 3 残 Sub-Issue (実装直前起票方針で defer 中)

| Sub-Issue | 内容 | 依存 | 備考 |
|-----------|------|------|------|
| **D** | GCIP Tenant 作成スクリプト (`scripts/create-gcip-tenants.ts`) | Sub-Issue A (#312) マージ済 | GCP Identity Platform 未有効化でも dry-run 動作確認可 |
| **E** | BE GCIP 経路の tenant 整合性チェック (`decodedToken.firebase.tenant` 検証) | Sub-Issue A + #316 マージ済 | code-only、本 PR の public endpoint と独立 |
| **F** | FE `auth.tenantId` + ログイン前テナント解決 | **Sub-Issue B ✅ (本 PR #321 完了)** | 本 PR の endpoint を FE から呼び出す |
| **G** | tenant 作成時の GCIP 自動化 | Sub-Issue A + E | E 完了後 |
| **H** | Staging + カナリア + 全テナント移行 | 全 Sub-Issue | GCP 操作ブロッカー解消後 |

**推奨**: 次セッションは **D / E 並行 → F** の順。D/E は code-only かつ相互独立、F は本 PR の endpoint を FE に組み込む。

**Sub-Issue H tasks.md 明記事項** (Session 8 PR #318 由来、継続):
- ABORTED (transaction retry 上限超過) 時の HTTP 応答を **401 で許容するか、503 + Retry-After に変更するか** を Staging 環境で明示判断
- `user_email_locks` への書き込み権限 (`roles/datastore.user`) を Admin SDK 経由で確認
- 同一 email 並行 5 transaction → user 1 件検証
- 既存重複 user (PR #318 以前の race で発生したもの) の audit script 実装

### 🟢 P2 残 (Phase 3 と並行可)

- **#308**: E2E CI リクエスト遅延 7-9 秒/request 根本調査 (#305/#307 で 2 件連続暫定対処済。Debug Protocol 「同一機能 3 件連続 → 元 PR 再レビュー」発動候補)
- **#310**: platform_auth_error_logs 読み取り時の transient/permanent 分離 (503 vs 500)
- **#281**: allowed_emails 監査 CLI refactor
- **#274 / #275 / #276**: Phase 5 allowed_emails 運用改善 (可視化 / UX / セッション失効)

## ブロッカー / ユーザー側タスク（継続）

| 項目 | 内容 | 影響 |
|------|------|------|
| GCP Console: OAuth 同意画面 External 化 | Issue #272 Phase 1.1 | sayori-maeda@kanjikai.or.jp 再ログイン復旧 + Phase 3 前提 |
| 本番 `normalize-users-email.ts` dry-run / execute | PR #287 マージ済、Phase 3 移行前に推奨 | users.email 大文字/空白混入の正規化 |
| GCP Identity Platform Essentials+ Tier 有効化 + 費用試算 | Sub-Issue H (Staging) の前提 | MAU 次第で数千円〜数万円/月 |
| Staging 環境の Identity Platform 有効化 | Sub-Issue H の staging 検証の前提 | - |

## ADR / ドキュメント状態

- **ADR-031** は Session 8 時点で最新（Sub-Issue H Staging 検証スコープに ABORTED HTTP 応答判断追加済）。本 PR #321 は Sub-Issue B 実装のため As-Is 表に追加の更新なし（Sub-Issue B は ADR-031 移行戦略 Step 5 の一部で、As-Is 表のマトリクスには現れない）
- **docs/api.md**: 本 PR で公開テナント情報セクション追加
- **docs/handoff/LATEST.md**: 本ファイル更新 (Session 9)
- **handoff サイズ**: 本ファイル約 200 行、500 行目標内

## Issue Net 変化（CLAUDE.md KPI）

```
Close 数: 1 件 (#320)
起票数: 1 件 (#320、実装直前起票)
Net: 0 件
```

**Net 0 の解釈**:
- **scope bloat ではない**: #320 は Session 7/8 で合意した「Sub-Issue B/D/E は実装直前に起票」方針に従い、実装着手時に起票 → 同 PR 内で完結
- **CLAUDE.md「ユーザーから複数タスクを明示指示された場合のみ個別 Issue 化（triage #5）」に該当**: 本セッション冒頭で「#272 Phase 3 優先 → Sub-Issue B 先行実装」を明示承認いただいた
- **実質は進捗 +1 件**: Sub-Issue B 実装完遂、Sub-Issue F の前提解消
- 通常の triage 基準違反（review agent rating 5-6 提案の起票）はゼロ。`/review-pr` の提案 8 件は全て PR 内修正 or defer で吸収

**補足**: Session 8 handoff の「Sub-Issue B/D/E は次セッション実装直前起票で defer」方針を本セッションで実行した形。今後 D/E/F も同パターンで「起票 → 実装 → close」を単一 PR 内で完結させる想定。

## 作業ブランチ状態

```
main: 2cb7c23 (#321 merged)

docs/handoff-session-9-2026-04-23 (本ファイル更新用、PR 作成予定)
```

main 直接 push なし、destructive 操作なし、残留 Node プロセスなし ✅。

## 参考: 今セッションで使った規範 / スキル

### 新規に活用した規範・スキル

- **`/review-pr` の security エージェントによる情報漏洩検知**: `PublicTenantInfo.name` の enumeration 攻撃面を検出し初期実装から除去。Sub-Issue 発注時の「最小限の情報開示」原則を実装時も徹底する必要性を再確認。security エージェント単独でなく code-reviewer / type-design-analyzer / comment-analyzer / silent-failure-hunter / pr-test-analyzer の並列で多面的に検証する価値を実感
- **`toPublicTenantInfo()` helper パターン**: 外部公開する response shape の構築を single audit point に集約することで、`TenantMetadata` に将来追加されるフィールドが silent に漏洩しない構造にした

### 繰り返し活用した規範

- **`/impl-plan`**: Issue #320 の AC 10 件策定 + 5+ ファイル変更 → Evaluator 発動を事前明示
- **`/codex review` (MCP 版)**: BLOCKING なし、NICE-TO-HAVE のみで最終承認。4 焦点の残存リスク評価を独立して実施
- **Evaluator 分離プロトコル** (`rules/quality-gate.md`): APPROVE_WITH_REVISIONS で MEDIUM 2 件（503 no-store / name invalid warn）を反映
- **feedback_issue_triage.md**: `/review-pr` で出た rating 5-6 提案（jitter、専用 limiter、CORS、zod 等）を Issue 化せず PR 内修正 / defer で吸収

### 継続的に意識した規範

- **CLAUDE.md「3+ ステップ → /impl-plan」+「5+ ファイル → Evaluator」**: 両方発動
- **CLAUDE.md「API 境界変更 → 対向側必ず確認」**: Sub-Issue F (FE 実装) が後続で本 endpoint を呼ぶことを handoff に明記
- **rules/production-data-safety.md**: 本 PR は read-only endpoint のため該当せず、但し `data.status` の fail-closed 判定で「DB 破損耐性」の原則を踏襲
- **feedback_pr_merge_authorization.md**: PR #321 マージ時に番号単位の明示認可を取得
