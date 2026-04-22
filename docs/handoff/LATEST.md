# Session Handoff — 2026-04-23 (Session 8)

## TL;DR

**ADR-031 Phase 3 前提条件 #316 完了**。`findOrCreateTenantUser` の「両方 miss → createUser」経路の並行リクエスト重複 user 作成 race を解消する `findOrCreateUserByEmailAndUid` を atomic 実装 (Firestore: sentinel doc + runTransaction、InMemory: 単一スレッド同期実行)。Quality Gate 5 層 + Codex で `/review-pr` が **Critical type error** (`userId` vs `knownUserId` mismatch) を発見し修正、Codex は IMPORTANT 2件 (ABORTED UX判定 + Firestore 仕様準拠コメント) を反映。Issue net **-1** (#316 close、起票 0)、CLAUDE.md KPI Net ≤ 0 達成。

- **マージ完了** (今セッション): PR #318
- **新規 Issue**: 0 件 (Sub-Issue B/D/E は次セッション「実装直前起票」方針で defer)
- **Close**: 1 件 (#316)
- **Issue Net**: **-1** ✅
- **Open 推移**: Session 7 末 8 件 → Session 8 末 7 件 (P0:1 / P2:6)

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
# Sub-Issue B/D/E は実装直前に起票（Session 7 末で合意の Net KPI 維持方針）
```

---

## セッション成果物 (2026-04-23 Session 8)

### マージ完了 PR

| # | Issue | Title | Merge Commit |
|---|-------|-------|-------------|
| #318 | #316 | feat(auth): findOrCreateTenantUser の初回 create race を atomic 化 | `4c2ecbd` |

### 起票 Issue

なし。Sub-Issue B/D/E は **実装直前に起票** する方針 (Session 7 末で合意) を維持。Session 8 はスコープを #316 単独に絞り Net KPI 達成。

### 主要変更の要点 (PR #318)

- **DataSource I/F**: `findOrCreateUserByEmailAndUid(email, firebaseUid, defaults)` 追加
  - 4 状態 discriminated union: `updated` / `already_set_same` / `conflict` / `created`
  - 構造上 `not_found` は発生しない (query miss なら同 transaction で create するため)
  - 新型 `FindOrCreateUserResult` / `FindOrCreateUserDefaults`
- **Firestore 実装** (`services/api/src/datasource/firestore.ts`):
  - `runTransaction` 内で sentinel doc `tenants/{tid}/user_email_locks/{sha256(email)}` + email query を `Promise.all` で並列 read
  - create path で sentinel + user を atomic set し、Firestore serializable isolation で並行 transaction を直列化
  - CAS path では lock doc を read のみで書かない (user doc 自体への `tx.update` が contention target)
- **InMemory 実装** (`services/api/src/datasource/in-memory.ts`):
  - メソッド body に `await` を一切置かず、async 関数の同期実行性質で原子化
  - 「将来 await を追加すると race 復活」の警告コメント明記
- **middleware/tenant-auth.ts**:
  - `findOrCreateTenantUser` の email fallback + 新規 create 経路を `findOrCreateUserByEmailAndUid` 単一呼び出しに統合
  - `assertCasSuccessOrThrow` を **generic assertion predicate** (`asserts result is Exclude<T, conflict|not_found>`) 化し、`SetFirebaseUidResult` / `FindOrCreateUserResult` 両方の失敗分岐を共通処理
  - super admin 経路: 既存 user に CAS、なければ virtual admin (新規 create はしない)
- **新規テスト**: 14 件
  - DataSource (`find-or-create-user-by-email-and-uid.test.ts`): 9 件 (4 状態 + precondition + 並行 race 3 パターン)
  - Middleware integration (`tenant-auth-atomic-create.test.ts`): 5 件 (初回ログイン / allowlist 未登録 / 異UID race / 同UID race / email 欠落)
- **ADR-031 As-Is 表更新** (`docs/adr/ADR-031-gcip-multi-tenancy.md` L68): UID 紐付け原子性 ✅ 完了 (Issue #313 + #316)、Sub-Issue H Staging で **ABORTED 時 HTTP 応答 (401 vs 503)** を明示判断するスコープを追加

### Quality Gate 検証結果

| ゲート | 結果 |
|-------|------|
| `/impl-plan` (3+ ステップ + 5+ ファイル) | ✅ AC 10件策定、Phase 2.7 完了 |
| `/simplify` (reuse + quality + efficiency 3 並列) | ✅ Quality #1 (assertion predicate) + Efficiency #3 (Promise.all) + Reuse minor (JSDoc 正規化責務) 反映 |
| `/safe-refactor` (型安全性・エラー処理) | ✅ 追加修正不要 |
| **Evaluator 分離** (5 ファイル+ 新機能) | ✅ APPROVE_WITH_REVISIONS → HIGH 2件 (assertion 順序、ABORTED 文書化) + MEDIUM 1件 (super admin 経路 `casResult.user` 統一) 反映 |
| `/review-pr` 6 エージェント並列 | ✅ **Critical 型エラー** (`userId` vs `knownUserId` mismatch — 4 エージェントが同指摘) 修正 + comment-analyzer 3件 (`not_found` 矛盾 JSDoc / 孤立 JSDoc / CAS path コメント補足) 反映 |
| `/codex review` セカンドオピニオン | ✅ BLOCKING なし、IMPORTANT 2件 (ABORTED UX 明示判断 + Firestore 仕様準拠コメント) 反映 |
| CI (Build / Lint / Test / Type Check) | ✅ 全 SUCCESS |

### レビュー対応サマリ

#### Evaluator HIGH/MEDIUM 反映
1. **HIGH-1 (assertion 順序問題)**: `userId` 算出を `observedUserId` 中間変数として可視化 → /review-pr で削除に再修正
2. **HIGH-2 (ABORTED 時 HTTP 応答未定義)**: ADR-031 As-Is 表に Sub-Issue H Staging 検証スコープを追記 (Codex IMPORTANT-1 でさらに強化)
3. **MEDIUM-4 (super admin 経路で `existingByEmail` 使用)**: `casResult.user` 採用に統一 (CAS 後の最新 user)

#### `/review-pr` Critical (4 エージェントが同指摘)
- **`userId` → `knownUserId` mismatch**: helper シグネチャ変更時に call site 2 箇所を更新漏れ → `tsc --noEmit` で即時 fail。修正 + `observedUserId` 変数削除 (helper 内 fallback に委譲)

#### `/review-pr` comment-analyzer 反映
- **C-2**: `interface.ts` の `not_found` 言及コメントを構造的除外文言に修正
- **I-1**: `findOrCreateTenantUser` 上部に孤立していた `buildAuthUser` 用 JSDoc を整理し、`findOrCreateTenantUser` 本体に早期 return 順序明記の JSDoc 追加
- **I-2**: `firestore.ts` CAS path に「lock doc を書かない理由」コメント追記

#### Codex IMPORTANT 反映
- **IMPORTANT-1 (ABORTED UX 分類が弱い)**: ADR-031 文言を「Sub-Issue H で 401 vs 503 を **明示判断**」に強化
- **IMPORTANT-2 (Firestore 仕様コメント)**: 「commit 時に optimistic lock conflict」→「serializable isolation / contention resolution」に正確化、公式 docs URL 追記

### Defer 項目 (本 PR スコープ外、handoff へ)

- **CAS body 4 重複** (`setUserFirebaseUidIfUnset` × 2 + `findOrCreateUserByEmailAndUid` × 2): 既存 `setUserFirebaseUidIfUnset` (#313 マージ済) も touch 必要 → 別 PR で extract
- **UID hit path (hot path) の `checkSuperAdmin` ∥ `ensureAllowlisted` 並列化**: 本 PR の diff 外 → 別 PR
- **lock doc TTL/cleanup 自動化**: Issue #276 (Phase 5)
- **既存重複 user 監査** (Codex SUGGESTION): Phase 3 前提作業として handoff で次セッション候補に追加
- **Sub-Issue H tasks.md 明記事項**: ABORTED 時 HTTP 応答判断 / lock doc 書き込み権限 / 同一 email 並行 5 transaction → user 1 件検証

## 品質ゲート結果 (最終)

| ゲート | 結果 |
|--------|------|
| `npm run lint` | ✅ PASS |
| `npm run type-check` (全 4 workspace) | ✅ PASS |
| `npm run test` (workspace 単位) | ✅ api 608/608 (既存 583 → 608、+25)、web 33/33 |
| main CI (PR #318 push 時) | ✅ 全 SUCCESS (Lint / Type Check / Test / Build) |

**Known issue**: ローカル並列テストは flaky (Issue #308 の CI 遅延と同根)。sequential (`--fileParallelism=false`) または workspace 単位実行で全 PASS。CI clean 環境では常時 PASS。

## main 現状

```
4c2ecbd feat(auth): findOrCreateTenantUser の初回 create 経路 race を atomic 化 (Issue #316) (#318)
50871e9 docs(handoff): Session 7 (2026-04-22) ハンドオフ更新 + ADR-031 UID 原子性対応済み反映 (#317)
24b49b6 feat(auth): findOrCreateTenantUser の UID 紐付け原子性 CAS 化 (Issue #313) (#315)
a7b9116 feat(tenant): Tenant スキーマに gcipTenantId + useGcip 追加 (Issue #312) (#314)
```

- **working tree**: clean (handoff PR ブランチのみ)
- **残留 Node プロセス**: なし ✅
- **Deploy to Cloud Run**: PR #318 merge 時に自動実行 (push 直後の E2E Tests も SUCCESS 確認可能)

## 次セッションの着手候補（優先度順）

### 🔴 P0 残

**Issue #272 Phase 3 (GCIP 移行本体)** — 引き続きクリティカルパス。Phase 1.1 (OAuth External 化) + Phase 3 後半 (Identity Platform 有効化) はユーザー側 GCP Console 作業の継続ブロッカー。

### 🟡 Phase 3 残 Sub-Issue (実装直前起票方針で defer 中)

| Sub-Issue | 内容 | 依存 |
|-----------|------|------|
| **B** | Public tenant-info endpoint (認証不要、ログイン前テナント解決用) | Sub-Issue A (#312) マージ済 |
| **D** | GCIP Tenant 作成スクリプト (`scripts/create-gcip-tenants.ts`) | Sub-Issue A (#312) マージ済 |
| **E** | BE GCIP 経路の tenant 整合性チェック (`decodedToken.firebase.tenant` 検証) | Sub-Issue A + #316 マージ済 |
| **F** | FE `auth.tenantId` + ログイン前テナント解決 | Sub-Issue B |
| **G** | tenant 作成時の GCIP 自動化 | Sub-Issue A + E |
| **H** | Staging + カナリア + 全テナント移行 | 全 Sub-Issue |

**推奨**: 次セッションは **Sub-Issue B / D 並行 → Sub-Issue E** の順。B/D は #312 のみが前提で完全独立、E は #316 完了で着手可能になった。

**Sub-Issue H tasks.md 明記事項** (本 PR / Codex IMPORTANT-1 由来):
- ABORTED (transaction retry 上限超過) 時の HTTP 応答を **401 で許容するか、503 + Retry-After に変更するか** を Staging 環境で明示判断
- `user_email_locks` への書き込み権限 (`roles/datastore.user`) を Admin SDK 経由で確認
- 同一 email 並行 5 transaction → user 1 件検証
- 既存重複 user (本 PR 以前の race で発生したもの) の audit script 実装

### 🟢 P2 残 (Phase 3 と並行可)

- **#308**: E2E CI リクエスト遅延 7-9 秒/request 根本調査 (#305/#307 で 2 件連続暫定対処済。Debug Protocol 「同一機能 3 件連続 → 元 PR 再レビュー」発動候補)
- **#310**: platform_auth_error_logs 読み取り時の transient/permanent 分離 (503 vs 500)
- **#281**: allowed_emails 監査 CLI refactor
- **#274 / #275 / #276**: Phase 5 allowed_emails 運用改善 (可視化 / UX / セッション失効)

## ブロッカー / ユーザー側タスク（継続）

| 項目 | 内容 | 影響 |
|------|------|------|
| GCP Console: OAuth 同意画面 External 化 | Issue #272 Phase 1.1 | sayori-maeda@kanjikai.or.jp 再ログイン復旧 + Phase 3 前提 |
| 本番 `normalize-users-email.ts` dry-run / execute | PR #287 マージ済 (Session 5)、Phase 3 移行前に推奨 | users.email 大文字/空白混入の正規化 |
| GCP Identity Platform Essentials+ Tier 有効化 + 費用試算 | Sub-Issue H (Staging) の前提 | MAU 次第で数千円〜数万円/月 |
| Staging 環境の Identity Platform 有効化 | Sub-Issue H の staging 検証の前提 | - |

## ADR / ドキュメント状態

- **ADR-031** As-Is 表更新済み (本 PR #318 内):
  - 「UID 紐付けの原子性」行: Issue #313 + #316 で完全対応済 ✅、Sub-Issue H Staging 検証スコープに ABORTED HTTP 応答判断追加
- **docs/handoff/LATEST.md**: 本ファイル更新 (Session 8)
- **handoff サイズ**: 本ファイル (300 行以下、500 行目標 OK)

## Issue Net 変化（CLAUDE.md KPI）

```
Close 数: 1 件 (#316)
起票数: 0 件
Net: -1 件 ✅
```

**Net -1 達成の要因**:
- Session 8 開始時にユーザーと「#316 単独完結 + Sub-Issue B/D/E は実装直前起票」スコープに合意 → 起票なしで close 1 を達成
- `/review-pr` で 6 エージェントが指摘した複数の suggestion (rating 5-6) は全て本 PR 内修正 / handoff defer / PR コメントで吸収、Issue 起票ゼロ
- `feedback_issue_triage.md` の triage 基準厳守 (Codex IMPORTANT も本 PR 内 ADR 文言追加で吸収)

## 作業ブランチ状態

```
main: 4c2ecbd (#318 merged)

docs/handoff-session-8-2026-04-23 (本ファイル更新用、PR 作成予定)
```

main 直接 push なし、destructive 操作なし、残留 Node プロセスなし ✅。

## 参考: 今セッションで使った規範 / スキル

### 新規に活用した規範・スキル
- **`/review-pr` 内の Critical type error 検知**: 4 エージェント (code-reviewer / type-design-analyzer / comment-analyzer / code-simplifier) が同じ `userId` vs `knownUserId` mismatch を独立に検出 → 並列レビューの価値を再確認
- **`assertCasSuccessOrThrow` の generic assertion predicate** (`asserts result is Exclude<T, conflict|not_found>`) 化: 2 つの異なる union 型 (SetFirebaseUidResult / FindOrCreateUserResult) を共通の失敗分岐 helper で扱う TypeScript パターンの実装

### 繰り返し活用した規範
- **`/impl-plan`**: Issue #316 の AC 10 件策定 + 5+ ファイル変更 → Evaluator 発動を事前明示
- **`/codex review` (MCP 版)**: BLOCKING はなかったが Firestore 仕様の正確性 (optimistic lock vs serializable isolation) と ABORTED UX 分類弱さを指摘
- **Evaluator 分離プロトコル** (`rules/quality-gate.md`): APPROVE_WITH_REVISIONS で HIGH 2 件 + MEDIUM 1 件を反映
- **`feedback_pr_merge_authorization.md`**: PR #318 を AskUserQuestion で個別承認取得後 squash merge
- **`feedback_issue_triage.md`**: rating 5-6 の review agent 提案 + Codex SUGGESTION を全て本 PR 内修正 / handoff defer / PR コメントに吸収、起票ゼロを実現

### 学び / 次セッションへの引き継ぎ
- **`/safe-refactor` 後でも `/review-pr` で型エラー発見**: helper シグネチャ rename (`userId` → `knownUserId`) 時に call site 2 箇所を更新漏れ。/safe-refactor 内の `npm run type-check` で本来検知できるはずだったが、ルートからの実行で workspace ごとの tsc が走らず素通り。今後 type-check は **workspace 内 (`cd services/api && npx tsc --noEmit`) で実行する** ことが必要
- **`/review-pr` の 6 エージェント並列の価値**: 4 エージェントが独立に同じ Critical を検出 → 並列レビューの "redundant by design" が真に効いた事例
- **Sub-Issue H Staging 検証の重要性**: ABORTED HTTP 応答判断 / lock doc 書き込み権限 / 既存重複 user audit を含めた Staging 検証スコープを次セッションで早めに固める必要
