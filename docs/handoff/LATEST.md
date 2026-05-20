# Session Handoff — 2026-05-20 (Session 38)

## TL;DR

**新機能「DXcollege 自動完了通知システム」着手セッション (brainstorm → impl-plan → Phase 1 着手 → smoke check 直前まで)。** 本田様要望の「受講進捗 PDF を指定曜日・時間で自動送信、テナント担当者 CC、100% 完了時のみ送信、完了通知後は送らない」を実現する新機能の **設計仕様書 (746 行 / AC 30 件) + 実装計画 (503 行 / Phase 0-8) + Phase 1 基礎 services (3 services + DTO 型、Unit Test 64 件) + smoke check workflow** を 2 PR (#442 #443) で main に投入完了。**Codex セカンドオピニオン (plan モード) + 6 エージェント並列 review** で Critical 5 件 / Important 17 件 / Minor 8 件を検出、Critical は全件本 PR 内で修正済み。**重要事案: AI 越権 (`forbidden` 独断追加) を 6 エージェント review で発見**し、memory に教訓追記。Phase 0-A-4 smoke check は CI SA の Secret Manager 権限不足で失敗、IAM 認可待ち。

- **Issue Net**: **0** (起票 0 件 / Close 0 件) ※ 新機能は impl-plan の Phase 0-8 で管理、Issue 化基準該当なし
- **Open 推移**: Session 37 末 9 件 → Session 38 末 **9 件** (active 5 / postponed 4、変化なし)
- **マージ済み PR**: #442 (Spec + Phase 1 + smoke + Critical 修正) / #443 (smoke workflow shared-types build step 追加)
- **本番反映**: 本機能はまだ自動配信パスを実行しない (`enabled=false` 等の初期化は Phase 7 デプロイで実施)
- **新 memory**: `feedback_spec_unwritten_addition_is_overreach.md` (仕様書未記載の列挙値を実装段階で独断追加するのは executor 越権)

## 🚀 次セッション開始時の必読手順

```bash
# 1. 状況復元
cat docs/handoff/LATEST.md

# 2. main 最新と CI 状況
git fetch origin main && git log --oneline -10 origin/main
gh run list --branch main --limit 5

# 3. 現在の OPEN Issue (9 件: active 5 / postponed 4、Session 37 から変化なし)
gh issue list --state open --limit 15

# 4. DXcollege 自動完了通知システムの再開ポイント (impl-plan Phase 0-A-4 でブロック中)
#    A. 【IAM 認可待ち】(decision-maker 領分):
#       CI SA に Secret Manager Accessor 追加要 (本田様判断):
#         gcloud secrets add-iam-policy-binding dwd-workspace-key \
#           --member=serviceAccount:github-actions@lms-279.iam.gserviceaccount.com \
#           --role=roles/secretmanager.secretAccessor --project=lms-279
#    B. 【DWD 反映待ち】2026-05-20 ~13:00 JST に gmail.send scope 追加、最大 24h 反映待ち
#       次セッション時刻によっては既に反映済み
#    C. 【TTL 法務確認】super_dispatch_audit_logs の 1 年 TTL が privacy policy / 受講契約と整合するか
#       (本田様確認中)

# 5. Phase 0-A-4 smoke 再実行手順 (A + B 解消後)
#    gh workflow run smoke-dwd-gmail-send.yml -f mode=dry-run -f to_email=system@279279.net
#    → dry-run 成功 → 本田様に send mode 認可をあらためて確認 → 実送信検証
#    → send 成功 = OQ-2 PASS → Phase 1 残部 + Phase 2 着手

# 6. 別系統の作業候補 (decision-maker 判断):
#    - 【新規 Issue 着手判断】#424 / #425 / #435 / #436 / #437 (Session 37 から変化なし)
#    - 【Important 8 件】Phase 2 着手前に別 PR で吸収予定 (下記)
#    - 【postponed・着手不可】#276 / #275 / #274 / #405
```

---

## セッション成果物 (2026-05-20 Session 38)

### 主要 PR (2 件、main マージ済み)

#### PR #442 (squash `94e5dfa`): Spec + Phase 1 services + smoke workflow + Critical 修正

**Phase 0/1 着手の基盤一式**:
- `docs/specs/2026-05-20-completion-notification-design.md` (748 行、AC 30 件)
- `docs/specs/2026-05-20-completion-notification-impl-plan.md` (503 行、Phase 0-8)
- `docs/specs/2026-05-20-completion-notification-flow.mmd` (Mermaid フロー図、Reservation 方式)
- `packages/shared-types/src/dispatch.ts` (DTO 型 320 行: Settings / Tenant CC / Notification / Run / Audit / DryRun / TestSend / Reservation / Gmail403)
- `services/api/src/services/dispatch/dispatch-error-sanitizer.ts` (PII sanitize、JWT/refresh_token/API key/folded MIME 対応)
- `services/api/src/services/dispatch/dispatch-403-classifier.ts` (Gmail 403 reason 分類、HTTP 403 ガード)
- `services/api/src/services/dispatch/schedule-matcher.ts` (JST 時刻照合)
- `scripts/smoke-dwd-gmail-send.ts` (DWD JWT + Gmail send smoke check)
- `.github/workflows/smoke-dwd-gmail-send.yml` (workflow_dispatch、dry-run/send mode 分離)

**Unit Test**: 64 件 (sanitizer 28 / 403-classifier 21 / schedule-matcher 15)、全 1048 件 PASS。

#### PR #443 (squash `445b1d8`): smoke workflow に shared-types build step 追加

PR #442 マージ後の smoke check 失敗 (`MODULE_NOT_FOUND @lms-279/shared-types/dist/index.js`) を修正。`npm run build -w @lms-279/shared-types` を `npm ci` 直後に追加。

### Codex セカンドオピニオン (plan モード)

設計仕様書を入力に **Critical 3 / Important 9 / Minor 4** 件の指摘を取得し、本 PR 内で**全件反映**:

| Codex 指摘 | 反映先 |
|---|---|
| Critical-1+3: pre-send Reservation 方式 | FR-7 / NFR-3 / §4.1.3 / §4.2 / §6.2 / AC-10〜15 |
| Critical-2: published コース全件母集合 | FR-4 / `completion-eligibility.ts` (Phase 2 着手予定) / AC-1 |
| Important-1: DWD scope 分離 | NFR-9 / `gmail-client.ts` (Phase 2 着手予定) / AC-34 |
| Important-2: Google Group smoke check | §8.1 / OQ-2 (Phase 0-A-4) |
| Important-3: run-level lock | FR-11 / §4.1.4 / `run-lock.ts` (Phase 2 着手予定) / §6.3 / AC-16 |
| Important-4: 403 reason 分類 | §6.4 / `dispatch-403-classifier.ts` / AC-17, AC-18 |
| Important-5: courseIdsSnapshot 保存 | FR-12 / §4.1.3 / §4.3 / AC-22 |
| Important-6: CC 個別 validation | FR-6 / `cc-email-validator.ts` (Phase 2 着手予定) / AC-25 |
| Important-7: PII sanitize | NFR-11 / `dispatch-error-sanitizer.ts` / §6.5 / AC-33 |
| Important-8: test-send dummy data | NFR-7 / AC-9 |
| Important-9: CSRF 認証方式明記 | NFR-2 / AC-31 / OQ-7 |
| Minor-1〜4: API path 統一 / AC 番号 / TTL 法務 / i18n | §12 / OQ-8 / §9 |

### 6 エージェント並列レビュー (PR #442 反映後)

| エージェント | Critical | Important | Minor | 総評 |
|---|---|---|---|---|
| code-reviewer | 2 | 7 | - | マージ可能、Critical 1 (forbidden) は要修正 |
| pr-test-analyzer | 5 | 5 | - | Phase 1 完了判断に足る、Rating 9 の 3 件は完了前に追加推奨 |
| silent-failure-hunter | 3 | 7 | - | **現状では本番有効化不可**、Phase 7 前に Critical 修正必須 |
| type-design-analyzer | - | 5 | 5 | マージ可能、discriminated union 化推奨 |
| comment-analyzer | 2 | 8 | - | マージして問題なし |
| code-simplifier | - | 10 | - | A- 評価、merge 後すぐの手入れ不要 |

→ **Critical 5 件全件**を `commit 39c1b92` で本 PR 内修正済 (forbidden 除去 / PII sanitize 拡張 / smoke script sanitize 経由 / errors.some() / HTTP 403 ガード)。

### AI 越権事案: `forbidden` 独断追加

**発生**: 設計仕様書 §6.4 では `SCOPE_REVOKED_REASONS` を 3 つ (`insufficientPermissions` / `delegationDenied` / `userRateLimitExceeded`) に確定していたが、実装段階で AI が 4 つ目 `forbidden` を「DWD 未反映の典型」とコメント付きで独断追加していた。

**検出**: 6 エージェント review の **code-reviewer / silent-failure-hunter / comment-analyzer の 3 エージェントが独立して指摘** (Critical 1)。`forbidden` は組織側拒否ポリシーでも返るため、宛先固有扱い (user_permanent) が正しい。誤って scope_revoked にすると run 全体中断 + 後続 user 全件 rollback で大量配信遅延のリスクあり。

**対応**:
- `dispatch-403-classifier.ts` から forbidden を除去
- テストで forbidden が user_permanent に分類されることを assertion
- 設計仕様書 §6.4 のサンプルコードも更新 (3 reason のみ列挙、AI 越権防止の警告コメント追加)
- memory 追記: `~/.claude/memory/feedback_spec_unwritten_addition_is_overreach.md`
- グローバル MEMORY.md に索引追加

**教訓**: 「より安全側に倒したい」「より broadly catch する」「より conservative にする」等の方向性自体が **decision-maker 領分**であり、AI が選択する権利はない。実装中に追加要望が生まれた時は、必ず仕様書を grep して該当列挙値・閾値が記載されているか確認し、未記載の場合は Open Question として残して本田様判断を仰ぐ。

---

## 待ち事項 (decision-maker = 本田様 判断)

### A. IAM 認可 (最優先 — Phase 0-A-4 smoke を進めるため必須)

**現状**: CI SA `github-actions@lms-279.iam.gserviceaccount.com` に `dwd-workspace-key` Secret への Accessor 権限なし。
- Cloud Run runtime SA (`1034821634012-compute@`) には既に付与済 (本番 services/api はアクセス可能)
- smoke check は CI SA 経由のため、現状で smoke 不可

**要望**: 以下コマンドの実行認可
```bash
gcloud secrets add-iam-policy-binding dwd-workspace-key \
  --member=serviceAccount:github-actions@lms-279.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor --project=lms-279
```

- 最小権限 (個別 secret 単位、project-level ではない)
- revocable (`gcloud secrets remove-iam-policy-binding` で即時撤回可能)
- 既存 Cloud Run 動作への影響ゼロ

### B. DWD 反映待ち (自然解消)

2026-05-20 ~13:00 JST に本田様が Workspace 管理コンソールで `dwd-workspace-key` SA の DWD scope に `https://www.googleapis.com/auth/gmail.send` を追加済み。

- 最大 24 時間で反映 (実際は数分〜数時間)
- 次セッション開始時刻によっては既に反映済みの可能性
- 反映済みなら smoke check (A 解消後) で `gmail.users.messages.send` が成功する想定
- 未反映なら 403 `insufficientPermissions` が返る → A は通っていても smoke 失敗

### C. TTL 法務確認

`super_dispatch_audit_logs` の 1 年 TTL が privacy policy / 受講契約と整合するか本田様確認中。延長必要なら設計仕様書 `DISPATCH_CONSTRAINTS.AUDIT_LOGS_TTL_DAYS` を調整。

---

## Phase 0-A-4 smoke 再実行手順 (待ち事項 A + B 解消後)

```bash
# 1. IAM 認可 (A 解消、本田様作業)
gcloud secrets add-iam-policy-binding dwd-workspace-key \
  --member=serviceAccount:github-actions@lms-279.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor --project=lms-279

# 2. dry-run 再試行 (Secret Manager 読取り + JWT 生成 + MIME 組立のみ、Gmail API 呼ばず)
gh workflow run smoke-dwd-gmail-send.yml -f mode=dry-run -f to_email=system@279279.net
gh run list --workflow=smoke-dwd-gmail-send.yml --limit 1
gh run watch <run_id> --exit-status

# 3. dry-run 成功 → send mode の宛先 + 認可を本田様にあらためて確認
#    (destructive、実 Gmail 送信、誤送信時ロールバック不可)
gh workflow run smoke-dwd-gmail-send.yml -f mode=send -f to_email=<本田様判断>

# 4. send 成功 = OQ-2 PASS
#    → Phase 1 残部 (completion-eligibility / cc-email-validator / gmail-client) 実装
#    → Phase 2 着手 (Reservation / Run Lock / dispatch-audit)
```

---

## Important 8 件 (Phase 2 着手前に別 PR で吸収予定)

PR #442 review で指摘された Important のうち、本 PR では未対応で Phase 2 PR にまとめて吸収予定:

1. **`CompletionNotification` / `DispatchRun` を discriminated union 化** (type-design #1, #2 / comment-analyzer #4)
   - status="sent" のとき messageId 非 null、status="reserved" のとき notifiedAt null 等を型レベルで強制
2. **`DispatchSettings` / `PutDispatchSettingsRequest` を `Pick<DispatchSettings, ...>` 化** (type-design #3 / code-simplifier #9)
   - 6 フィールドの重複定義を解消
3. **`NOTIFICATION_CC_EMAILS_MAX` / `TEST_SEND_DAILY_LIMIT` の二重定義削除** (code-reviewer #3 / code-simplifier #1 / type-design #9)
   - 個別 export と `DISPATCH_CONSTRAINTS` の両方で同値定義されている
4. **smoke script `buildRawMime` に CRLF 二重防御追加** (code-reviewer #2)
   - 既存 `gmail-draft.ts` の `assertNoCRLF` 相当パターンを smoke にも適用
5. **smoke workflow `mode=send` の environments + required_reviewers** (code-reviewer #9)
   - GitHub Actions environments で required_reviewers を 1 名指定、誤実送信防止
6. **`shouldRunNow` 値域 validation** (silent-failure-hunter #6, pr-test-analyzer #6)
   - scheduleHourJst が 24, -1, 小数等の不正値で silently false になる防御
7. **`getDwdKey` の JSON.parse 失敗時のコンテキスト保護** (silent-failure-hunter #4)
   - private_key 断片がログに残らないよう error message を抑制
8. **`JST_OFFSET_MS` の shared-types 中央集約** (code-simplifier #2)
   - 既存 4 箇所 (`schedule-matcher.ts` / `super-admin.ts` / `progress-pdf-mail-template.ts` / `progress-pdf-document.tsx`) で重複定義

---

## Issue Net 変化

- **Close 数**: 0 件
- **起票数**: 0 件
- **Net**: 0 件

新機能「DXcollege 自動完了通知システム」は **Issue ではなく impl-plan の Phase 0-8 で管理**、PR ベース進行のため Issue 起票なし。Important 8 件も Issue 化せず Phase 2 PR で吸収予定。

CLAUDE.md「GitHub Issues」セクションの triage 基準 (実害 / 再現バグ / CI破壊 / rating≥7 / ユーザー明示指示) には**該当しない** (新機能の Phase 進行中タスクは PR で管理が筋)。

---

## このセッションで作成された PR

| PR | タイトル | merge commit | 種別 |
|---|---|---|---|
| #442 | feat(dispatch): 自動完了通知 Spec + Phase 1 基礎 + smoke workflow | `94e5dfa` | feat (large、+2,947/-139、12 files) |
| #443 | fix(smoke-workflow): shared-types build step を npm ci 後に追加 | `445b1d8` | fix (small、+6/-0、1 file) |

---

## 関連ファイル (次セッションでアクセスすべき)

### 設計・計画ドキュメント
- `docs/specs/2026-05-20-completion-notification-design.md` (748 行、AC 30 件、Critical 1+2 反映後の §6.4/§6.5 更新済み)
- `docs/specs/2026-05-20-completion-notification-impl-plan.md` (503 行、Phase 0-8)
- `docs/specs/2026-05-20-completion-notification-flow.mmd` (Mermaid、Reservation 方式)

### Phase 1 基礎 services + DTO 型
- `services/api/src/services/dispatch/dispatch-error-sanitizer.ts` (PII sanitize)
- `services/api/src/services/dispatch/dispatch-403-classifier.ts` (403 reason 分類、HTTP 403 ガード)
- `services/api/src/services/dispatch/schedule-matcher.ts` (JST 時刻照合)
- `services/api/src/services/dispatch/__tests__/*.test.ts` (Unit Test 64 件)
- `packages/shared-types/src/dispatch.ts` (DTO 型 320 行)

### smoke check
- `scripts/smoke-dwd-gmail-send.ts` (DWD JWT + Gmail send)
- `.github/workflows/smoke-dwd-gmail-send.yml` (workflow_dispatch、dry-run/send)

### memory (グローバル)
- `~/.claude/memory/feedback_spec_unwritten_addition_is_overreach.md` (新規、AI 越権教訓)
- `~/.claude/memory/MEMORY.md` (索引更新済み)

---

## 環境状態 (セッション終了時)

| 項目 | 状態 |
|---|---|
| Git ブランチ | main (clean) |
| Git 最新 | `445b1d8 fix(smoke-workflow)... #443` |
| CI 直近状態 | smoke-dwd-gmail-send.yml は **failure** (Secret Manager 権限不足、A 解消で復旧見込み) |
| 残留 Node プロセス | なし |
| 1048 件全テスト | PASS |
| type-check | PASS |
| lint | 0 errors |

---

## 次セッション 5 工程マトリクス

| 工程 | 状態 | 次アクション |
|---|---|---|
| 1. **catchup** | ✅ Session 38 で完結、Issue Net 0 | 次セッション開始時に Issue 状態と本ハンドオフ参照 |
| 2. **Phase 0-A-4 smoke** | ⏸ IAM 認可 + DWD 反映待ち | A: IAM 認可 → smoke 再試行 |
| 3. **Phase 1 残部** | ⏸ smoke 成功待ち | smoke OK 後に `completion-eligibility` / `cc-email-validator` / `gmail-client` 着手 |
| 4. **Phase 2 (Reservation/Lock/Audit)** | ⏸ Phase 1 完了待ち | Important 8 件と合わせて 1 PR で出す |
| 5. **本田様確認待ち事項** | ⏸ IAM 認可 / 法務確認 | 認可・確認後に通常進行 |
