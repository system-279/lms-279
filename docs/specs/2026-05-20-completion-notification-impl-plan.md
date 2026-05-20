# DXcollege 自動完了通知システム 実装計画

| 項目 | 値 |
|---|---|
| 策定日 | 2026-05-20 |
| 設計仕様書 | [2026-05-20-completion-notification-design.md](./2026-05-20-completion-notification-design.md) |
| 処理フロー図 | [2026-05-20-completion-notification-flow.mmd](./2026-05-20-completion-notification-flow.mmd) |
| ブランチ | `feat/completion-notification-system-design` (設計) + Phase 別 feature ブランチ (実装) |
| 推定総工数 | エンジニア作業 5-7 日 + 本田様作業 0.5-1 日 + DWD 反映待ち最大 24 時間 |

---

## 1. 計画サマリ

### 1.1 ゴール

設計仕様書 AC 30 件 (機能 9 / Reservation 6 / Run Lock・403 3 / エッジケース 7 / セキュリティ 5) を全て満たす自動完了通知システムを、本番受講者への誤送信ゼロで段階的にデプロイする。

### 1.2 スコープ

| In Scope | Out of Scope (将来課題) |
|---|---|
| 設計仕様書の全機能要件 (FR-1〜FR-12) | bounce 検知 |
| 全非機能要件 (NFR-1〜NFR-11) | テナント管理者向け CC 設定 UI |
| 全 AC 30 件の自動テスト | 完了通知以外の自動メール (受講開始通知等) |
| ADR-035 として設計判断を ADR 登録 | 配信スケジュールの「分」単位指定 |
| Cutover 手順書 (Phase 8) | 多言語対応 (i18n) |

### 1.3 制約事項

- **誤送信時ロールバック不可**: 本番デプロイ前に必ず dev or staging で実機検証
- **CLAUDE.md CRITICAL 全項目遵守**: main 直 push 禁止、Definition of Done、Quality Gate (Evaluator 分離プロトコル発動条件 5+ ファイル変更を満たす)
- **既存 PR #434 機能には一切影響を与えない**: `gmail-draft.ts` / `progress-pdf-draft.ts` を変更しない
- **DWD scope 共通化禁止**: `gmail.send` 専用 client、既存 `SCOPES` を汚染しない (Codex Important-1)

---

## 2. Phase 分割と依存関係

### 2.1 Phase 一覧

| Phase | 内容 | 規模 | 推定工数 | 依存 |
|---|---|---|---|---|
| **Phase 0** | 前提作業 (本田様 Workspace 作業 + Infra 確認) | 中 | 0.5-1 日 + DWD 反映 24h | なし |
| **Phase 1** | 基礎 services (Unit Test 中心) | 大 | 1 日 | Phase 0 |
| **Phase 2** | Reservation / Run Lock layer | 中 | 0.5 日 | Phase 1 |
| **Phase 3** | Mail template + Gmail DWD send | 中 | 0.5 日 | Phase 1 |
| **Phase 4** | Internal API + メインロジック (race / lock / 403 シナリオ全網羅) | 大 | 1 日 | Phase 1, 2, 3 |
| **Phase 5** | Super admin API (6 endpoints) | 大 | 1 日 | Phase 1, 2 (Phase 3, 4 と並列実装可) |
| **Phase 6** | Frontend UI (1 page + 7 components + Playwright E2E) | 大 | 1.5 日 | Phase 5 (DTO 確定後) |
| **Phase 7** | Infrastructure + ADR-035 登録 | 中 | 0.5 日 | Phase 4, 5, 6 完了後 |
| **Phase 8** | Smoke check + Cutover | 中 | 0.5 日 + 本田様承認 | Phase 7 |

### 2.2 依存関係グラフ

```
Phase 0 (前提作業、人手)
   │ DWD scope 反映、Group smoke、auth 方式確認、infra 準備
   ▼
Phase 1 (基礎 services、並列実装可能 7 ファイル)
   │ sanitizer / 403-classifier / schedule-matcher /
   │ completion-eligibility / cc-validator / gmail-client / shared-types
   ▼
   ├──→ Phase 2 (Reservation/Lock、3 ファイル)
   │      │ reservation / run-lock / dispatch-audit
   │      │
   │      ▼
   │   Phase 4 (Internal API、メインロジック)
   │      │
   │      ├──→ Phase 7 (Infra + ADR)
   │      │
   ├──→ Phase 3 (Mail + Gmail send、2 ファイル) ──┐
   │                                              │
   └──→ Phase 5 (Super admin API、6 routes) ────┐ ▼
                                                │ Phase 4 統合点
              ┌─────────────────────────────────┘
              ▼
        Phase 6 (Frontend UI、API DTO 確定後)
              │
              ▼
        Phase 7 (Infrastructure + Deploy)
              │
              ▼
        Phase 8 (Smoke check + Cutover)
```

### 2.3 並列化機会

- **Phase 1 内 7 ファイル**: 完全独立、並列実装可能 (Agent Teams or 直列 TDD どちらでも可)
- **Phase 3 と Phase 5**: 互いに独立 (Phase 5 は Phase 4 結合より先に着手可)
- **Phase 6 内 7 components**: API DTO 確定後は並列実装可能

### 2.4 Phase 別 PR 戦略

各 Phase で個別 PR を切る (推奨)。理由:
- レビュー粒度の制御
- 部分 rollback の容易性
- Quality Gate (Evaluator 分離) の Phase 単位発動

| PR | 含めるもの |
|---|---|
| PR-A (Phase 1) | 基礎 services + Unit Test |
| PR-B (Phase 2) | Reservation/Lock + Integration Test |
| PR-C (Phase 3) | Mail template + Gmail send + Unit Test |
| PR-D (Phase 4) | Internal API + メインロジック + Integration Test (race scenario 全網羅) |
| PR-E (Phase 5) | Super admin API 6 endpoints |
| PR-F (Phase 6) | Frontend UI + Playwright E2E |
| PR-G (Phase 7) | Infra (Cloud Scheduler / TTL / env) + ADR-035 |

---

## 3. Phase 詳細

### Phase 0: 前提作業 (Open Questions 解決)

| Task | 担当 | 依存 |
|---|---|---|
| OQ-3 解決: 本田様が Workspace 管理コンソール権限を持つか確認 | エンジニア + 本田様 | なし |
| OQ-3 実施: `dwd-workspace-key` SA に `gmail.send` scope 追加 | **本田様** | OQ-3 解決 |
| DWD 反映待ち (最大 24h) | - | OQ-3 実施 |
| **OQ-2 解決**: `dxcollege@279279.net` で実機 smoke (`gmail.users.messages.send` を `subject=dxcollege@279279.net`、`To=エンジニア自身`、`scope=gmail.send` のみで実行) | エンジニア | DWD 反映完了 |
| smoke 失敗時の判断: SendAs 設定 or 実ユーザー mailbox 化 | 本田様 | smoke 結果 |
| OQ-7 解決: 既存 super-admin auth が Firebase Bearer か確認 (`services/api/src/middleware/super-admin.ts` 等を grep) | エンジニア | なし |
| OQ-8 解決: `super_dispatch_audit_logs` 1 年 TTL の法務確認 | 本田様 | なし |
| Gmail API / Cloud Scheduler API 有効化確認 | エンジニア | なし |

**Phase 0 完了条件**:
- OQ-2/3/7/8 全て解決
- Group エイリアス smoke 成功 (or 代替判断完了)
- DWD scope 反映確認

### Phase 1: 基礎 services

| File | 機能 | 関連 AC | テスト |
|---|---|---|---|
| `services/api/src/services/dispatch/dispatch-error-sanitizer.ts` | `sanitizeErrorForAudit()` | AC-33 | Unit |
| `services/api/src/services/dispatch/dispatch-403-classifier.ts` | 403 reason 分類 | AC-17, AC-18 | Unit |
| `services/api/src/services/dispatch/schedule-matcher.ts` | JST 時刻判定 | AC-6 | Unit |
| `services/api/src/services/dispatch/completion-eligibility.ts` | published コース全件母集合判定 | AC-1 | Unit |
| `services/api/src/services/dispatch/cc-email-validator.ts` | CC 配列 individual validation | AC-4, AC-25 | Unit |
| `services/api/src/services/gmail-client.ts` | `getGmailClientForSender(senderEmail)` 専用 client | AC-34 | Unit |
| `packages/shared-types/src/dispatch.ts` | DTO 型 | - | (型のみ) |

**Phase 1 完了条件**:
- 各 service の Unit Test カバレッジ ≥ 90%
- `npm run lint && npm run type-check && npm test -w @lms-279/api` 全 PASS
- 既存 `progress-pdf-draft.ts` の `validateRecipientEmail` を `cc-email-validator.ts` で再利用 (DRY)

### Phase 2: Reservation / Run Lock layer

| File | 機能 | 関連 AC | テスト |
|---|---|---|---|
| `services/api/src/services/dispatch/reservation.ts` | pre-send transaction (`tryReserveOrSkip`) | AC-10, AC-11, AC-12 | Integration |
| `services/api/src/services/dispatch/run-lock.ts` | `super_dispatch_runs` lock | AC-16 | Integration |
| `services/api/src/services/dispatch/dispatch-audit.ts` | audit_logs 書き込み | AC-33 | Integration |

**Phase 2 完了条件**:
- Integration Test で transaction 競合 6 シナリオ網羅 (新規 / sent / failed_permanent / reserved-in-lease / reserved-expired / manual_review)
- run lock 同時起動 2 件で 1 つだけ成功するシナリオ確認
- audit_logs に PII 漏洩がないことを assertion

### Phase 3: Mail template + Gmail DWD send

| File | 機能 | 関連 AC | テスト |
|---|---|---|---|
| `services/api/src/services/dispatch/completion-notification-mail.ts` | 完了通知テンプレート | AC-3, AC-5 | Unit |
| `services/api/src/services/dispatch/gmail-dwd-send.ts` | DWD send + MIME 組立 + retry | AC-32 | Unit (Gmail API mock) |

**Phase 3 完了条件**:
- 完了通知本文が `completionMessageBody` + `signatureName` を含む
- CC validation 失敗時に MIME に Cc: ヘッダが出ない
- Gmail API 429 retry が exponential backoff で 3 回まで

### Phase 4: Internal API + メインロジック

| File | 機能 | 関連 AC | テスト |
|---|---|---|---|
| `services/api/src/services/oidc-verify.ts` | OIDC token middleware | AC-30 | Unit + Integration |
| `services/api/src/services/dispatch/run-completion-notifications.ts` | メインロジック | 全 AC | Integration |
| `services/api/src/routes/internal/dispatch.ts` | POST endpoint | AC-30 | Integration |

**Phase 4 完了条件**:
- Integration Test で AC-1〜18 全シナリオ網羅 (race / lock / 403 / 100% 判定 / kill switch 全て)
- **Evaluator 分離プロトコル発動** (Phase 完了時に `evaluator` agent で AC 検証 + 独立評価)
- `~/.claude/rules/error-handling.md` 状態復旧 > ログ記録 > 通知 の原則準拠を確認

### Phase 5: Super admin API

| File | endpoint | 関連 AC |
|---|---|---|
| `routes/super/dispatch-settings.ts` | GET/PUT `/api/v2/super/dispatch/settings` | AC-23 |
| `routes/super/dispatch-audit-logs.ts` | GET `/api/v2/super/dispatch/audit-logs` | - |
| `routes/super/dispatch-runs.ts` | GET `/api/v2/super/dispatch/runs` | - |
| `routes/super/tenant-notification-cc.ts` | GET/PUT `/api/v2/super/tenants/:tenantId/notification-cc-emails` | AC-24, AC-25 |
| `routes/super/dispatch-dry-run.ts` | POST `/api/v2/super/dispatch/dry-run` | AC-8 |
| `routes/super/dispatch-test-send.ts` | POST `/api/v2/super/dispatch/test-send` | AC-9 |

**Phase 5 完了条件**:
- 各 endpoint で既存 super-admin auth middleware 適用 (AC-31)
- test-send は固定ダミーデータ + 添付なし + To=superAdmin.email 強制
- 楽観的ロック (version) で 409 を返す確認
- レート制限 (test-send 1 日 50 件) の確認

### Phase 6: Frontend UI

| File | 機能 | テスト |
|---|---|---|
| `web/app/super/dispatch-settings/page.tsx` | ページ本体 | Playwright |
| `web/app/super/dispatch-settings/components/ScheduleEditor.tsx` | 曜日 + 時刻入力 | Jest |
| `web/app/super/dispatch-settings/components/TenantCcEditor.tsx` | chips UI (上限 10 件) | Jest |
| `web/app/super/dispatch-settings/components/MessageBodyEditor.tsx` | プレビュー付き textarea | Jest |
| `web/app/super/dispatch-settings/components/AuditLogTable.tsx` | 履歴一覧 (フィルタ) | Jest |
| `web/app/super/dispatch-settings/components/RunHistoryTable.tsx` | run 履歴 | Jest |
| `web/app/super/dispatch-settings/components/DryRunPanel.tsx` | ドライラン結果 | Jest |
| `web/app/super/dispatch-settings/components/TestSendButton.tsx` | テスト送信 | Jest |

**Phase 6 完了条件**:
- Playwright E2E で「設定変更 → DB 反映 → audit_logs 記録」を確認
- chips UI で CRLF / カンマ / 重複が拒否される
- スーパー管理者以外は 401/403 が返る

### Phase 7: Infrastructure + ADR

| Task | 内容 |
|---|---|
| Cloud Scheduler job 作成 | `gcloud scheduler jobs create http` で `0 * * * *` + `time-zone=Asia/Tokyo` + OIDC token |
| Cloud Run env 追加 | `DXCOLLEGE_SENDER_EMAIL=dxcollege@279279.net` |
| Firestore TTL Policy | `super_dispatch_audit_logs.ttlExpireAt` + `super_dispatch_runs.ttlExpireAt` |
| Firestore composite index | `super_dispatch_audit_logs` のフィルタ用、`super_dispatch_runs.status + leaseExpiresAt` |
| Cloud Scheduler SA 作成 + 権限付与 | `dxcollege-scheduler@lms-279.iam.gserviceaccount.com` に Cloud Run invoker |
| ADR-035 起票 | `docs/adr/ADR-035-auto-completion-notification.md` |
| deploy.yml 更新 | 必要に応じて (env 追加分) |

### Phase 8: Smoke check + Cutover

| Step | 内容 | 担当 |
|---|---|---|
| 1 | 本番デプロイ前、`super_dispatch_settings/global.enabled = false` で初期化 | エンジニア |
| 2 | 本番デプロイ実行 (deploy.yml workflow) | エンジニア |
| 3 | Cloud Run 起動確認、Cloud Scheduler 1 回起動を待つ (kill switch なので何もしない) | エンジニア |
| 4 | test-send 実行 → スーパー管理者自身宛にダミーメール受信確認 | エンジニア |
| 5 | dry-run 実行 → 次回 cron で送信される対象一覧確認 | エンジニア |
| 6 | 一覧を本田様にレビュー、対象が期待通りか確認 | 本田様 |
| 7 | 本田様の明示承認 (番号単位の認可、CLAUDE.md 4 原則 §3) | 本田様 |
| 8 | `enabled = true` に切替 (UI から実施) | エンジニア |
| 9 | 次の cron 起動 (最大 60 分以内) で初回本番送信 | (自動) |
| 10 | 初回送信件数を audit_logs / run_history で確認 | エンジニア |
| 11 | 受信受講者・テナント担当者からの問い合わせ受付 | 本田様 |
| 12 | 問題発生時は即時 `enabled = false` で kill switch | エンジニア |

---

## 4. 統合影響分析

### 4.1 関連する既存機能

| 既存機能 | 依存方向 | 整合性 |
|---|---|---|
| `services/api/src/services/google-auth.ts` (DWD) | この機能が依存 (gmail-client.ts で新規 JWT) | ✅ 既存共通 SCOPES 非変更で互換性確保 (Codex Important-1) |
| `services/api/src/services/progress-pdf.ts` (PDF 生成) | この機能が依存 (ProgressPdfDocument を import) | ✅ 既存 export 流用 |
| `services/api/src/services/progress-pdf-mail-template.ts` (mail template) | 参照 (構造を踏襲しつつ別ファイル) | ✅ 直接依存なし |
| `services/api/src/routes/super/progress-pdf-draft.ts` (PR #434) | **完全独立、変更なし** | ✅ |
| `services/api/src/services/gmail-draft.ts` (PR #434) | **完全独立、変更なし** | ✅ |
| `course_progress` collection (既存) | この機能が読み取り | ✅ 既存 schema 変更なし |
| `tenants/{tenantId}` (既存) | この機能が write (`notificationCcEmails` / `completionNotificationEnabled` 追加) | ⚠️ Firestore は欠損フィールド `undefined` 扱いなので backfill 不要、`sanitizeForUpdate` パターンで対応 (OQ-5) |
| Super-admin auth middleware | この機能が依存 | ✅ 既存 middleware 流用 (OQ-7 で Bearer 確認) |

### 4.2 既存ファイル変更箇所

| ファイル | 変更内容 | 影響 |
|---|---|---|
| `services/api/src/index.ts` (or 同等の router 登録) | 新規 routes (`/api/internal/dispatch`, `/api/v2/super/dispatch/*`) 登録 | minor、import 追加のみ |
| `packages/shared-types/src/index.ts` | dispatch types export 追加 | minor、export 追加のみ |
| `services/api/firestore.rules` (存在すれば) | 新規 collection の rules 追加 | minor |
| `services/api/src/services/google-auth.ts` | **変更なし** | ゼロ (Codex Important-1) |

### 4.3 E2E フロー (本機能を含む完全フロー)

#### メインフロー (100% 完了 → 通知)

```
1. 受講者がコース全レッスン受講 → quiz 受験 → 全 quiz 合格
2. course_progress.isCompleted = true (既存ロジックで書き換え)
3. 受講者が enroll している全 published コースで step 2 が完了
4. 次の Cloud Scheduler 起動 (最大 60 分以内)
5. BE が super_dispatch_settings/global を読み、スケジュール一致確認
6. BE が published コース全件 + course_progress で 100% 完了判定
7. BE が completion_notifications/{userId} を transaction で reserve
8. PDF 生成 → DWD なりすまし送信 (To=受講者、CC=ownerEmail + notificationCcEmails)
9. completion_notifications.status = sent に更新
10. 受講者と CC 担当者に Gmail 受信
11. audit_logs に user_notified 記録
```

#### 設定フロー (本田様)

```
1. 本田様が /super/dispatch-settings にアクセス
2. ScheduleEditor で曜日・時刻設定
3. TenantCcEditor で各テナントの CC 追加担当者を chips で入力
4. MessageBodyEditor で完了通知本文プレビュー確認
5. 保存 → version 楽観的ロック → audit_logs 記録
6. 次回 cron 起動で新設定が適用される
```

#### エラー復旧フロー

```
1. permanent_failed / manual_review_required ユーザー発生
2. 本田様が UI で AuditLogTable / RunHistoryTable から該当 user を特定
3. 根本原因 (例: 受講者 email 不正) を本田様判断で修正
4. エンジニアが scripts/clear-failed-notification.ts を workflow_dispatch 経由で実行
5. 次回 cron で再評価 → 通知される
```

---

## 5. テスト戦略

### 5.1 Phase 別カバレッジ

| Phase | Unit Test | Integration Test | E2E Test | 実機 smoke |
|---|---|---|---|---|
| Phase 1 | ✅ 全 service | - | - | - |
| Phase 2 | ✅ 純粋関数部分 | ✅ transaction シナリオ 6 件 | - | - |
| Phase 3 | ✅ template + MIME | ✅ Gmail mock | - | - |
| Phase 4 | ✅ middleware | **✅ AC-1〜18 全網羅** | - | - |
| Phase 5 | ✅ validation | ✅ 各 endpoint Auth + レート制限 | - | - |
| Phase 6 | ✅ component | - | ✅ Playwright | - |
| Phase 7 | - | - | - | dev で Cloud Scheduler 起動確認 |
| Phase 8 | - | - | - | **本番 smoke (test-send + dry-run)** |

### 5.2 重点テストシナリオ

#### Phase 2 / Phase 4 で必須の Reservation シナリオ

1. **新規予約**: completion_notifications 不在 → reserved 状態で create 成功
2. **既存 sent**: 既に sent → スキップ
3. **既存 failed_permanent**: 既に failed_permanent → スキップ
4. **既存 reserved (lease 内)**: 他 run が処理中 → スキップ
5. **既存 reserved (lease 期限切れ)**: manual_review_required に降格、再送しない
6. **既存 manual_review_required**: スキップ
7. **transaction 競合**: 2 並列 worker が同時 reserve → 1 つのみ成功
8. **送信成功**: reserved → sent
9. **送信 transient 失敗**: reserved 維持、次回 cron で再試行
10. **送信 permanent 失敗 (宛先固有)**: failed_permanent に更新
11. **送信 403 insufficientPermissions**: run 全体中断、後続 reservation rollback

#### Phase 6 Playwright シナリオ

1. スーパー管理者で `/super/dispatch-settings` アクセス → ページ表示
2. ScheduleEditor で「月木の 09:00」設定 → 保存 → DB 反映確認
3. TenantCcEditor で `a@example.com` 追加 → chip 表示 → 保存
4. TenantCcEditor で CRLF 含む文字列を入力 → エラー表示
5. test-send ボタン押下 → スーパー管理者自身に Gmail 届く (mock 検証)
6. dry-run ボタン押下 → 一覧表示
7. スーパー管理者以外でアクセス → 401/403

### 5.3 Quality Gate

| 規模 | Phase | 完了条件 |
|---|---|---|
| 大 | Phase 1, 4, 5, 6 | Lint + Test + Build + `/simplify` + `/safe-refactor` + **Evaluator 分離プロトコル** |
| 中 | Phase 2, 3, 7, 8 | Lint + Test + Build + `/simplify` |

---

## 6. デプロイ戦略

### 6.1 デプロイフロー

```
Phase 7 デプロイ時点
  ↓ super_dispatch_settings/global.enabled = false で初期化
本番 Cloud Run / Cloud Scheduler 起動
  ↓ cron 起動するが kill switch で何もしない (audit_logs だけ run_started/completed 記録)
test-send で実機検証 (エンジニア自身宛)
  ↓ メール受信 + Gmail UI 確認
dry-run で本番データ確認
  ↓ 送信予定者リストを本田様レビュー
本田様の番号単位明示認可
  ↓ "PR #N — タイトル の cutover を進めて良い" 形式
enabled = true に切替 (UI から)
  ↓ 次の cron 起動で本番送信開始
初回送信件数監視 + 問い合わせ受付
```

### 6.2 Cutover 安全装置

| 装置 | 効果 |
|---|---|
| `enabled = false` 初期化 | 本番デプロイ後も即時送信されない |
| test-send | 実機 Gmail 受信を事前確認 |
| dry-run | 送信対象を事前に本田様レビュー |
| 番号単位明示認可 | AI が勝手に enable しない (CLAUDE.md 4 原則 §3) |
| kill switch | 問題発生時に即時停止 |
| Reservation 方式 | 同一 user への二重送信を構造的に防止 |
| 403 reason 分類 | scope 撤回時に全 user 終端化を防ぐ |

---

## 7. ロールバック戦略

| 状況 | 対応 | 復旧時間 |
|---|---|---|
| 設定誤入力 (誤った時刻設定) | UI から再設定、次回 cron に反映 | 即時 (最大 60 分後の cron 起動で適用) |
| 一部 user のみ誤送信 | `scripts/clear-failed-notification.ts` で個別 doc 削除、本田様が受信者対応 | 数時間 |
| 大量誤送信中 | UI から `enabled = false` → 即時 kill switch | 即時 (次の cron で停止) |
| 致命的バグ (例: 全 user に永久 transient_failed) | Cloud Scheduler job pause → Cloud Run rollback (前 commit に revert) → 設計再検討 | 30 分 |
| Firestore データ破壊 | PITR で復元 (CLAUDE.md production-data-safety.md §2) | 1-2 時間 |
| 全体設定ミス (DWD scope 撤回等) | 403 reason 分類で自動 run abort、Error Reporting critical 通知、本田様対応 | 即時検知 + 対応は scope 依存 |

---

## 8. Open Questions の解決順序

| 順序 | OQ | Phase | 解決手段 |
|---|---|---|---|
| 1 | OQ-3 (Workspace 権限) | Phase 0 | 本田様確認、無ければエンジニアが代行不可 |
| 2 | OQ-3 実施 (gmail.send scope 追加) | Phase 0 | 本田様作業、24h 反映待ち |
| 3 | OQ-2 (Group エイリアス DWD smoke) | Phase 0 | エンジニアが実機 smoke、失敗時は本田様判断 |
| 4 | OQ-7 (super-admin auth 方式) | Phase 0 | 既存コード grep、5 分 |
| 5 | OQ-8 (TTL 法務) | Phase 0 | 本田様 + 法務確認 |
| 6 | OQ-1, OQ-6 (Gmail API / OIDC audience) | Phase 7 | gcloud / Cloud Run 確認 |
| 7 | OQ-4 (Cloud Run 300 秒) | Phase 4 | Integration Test で実測 |
| 8 | OQ-5 (tenant フィールド追加 backfill) | Phase 5 | `sanitizeForUpdate` で対応 |
| 9 | OQ-9 (lease 期限実測) | Phase 4 / 8 | Integration Test + 本番 smoke で確定 |

---

## 9. AC ↔ Phase マッピング

設計仕様書 AC 30 件を Phase に紐付け。実装完了時に全 AC を Phase 完了条件として検証する。

| Phase | カバー AC |
|---|---|
| Phase 1 | AC-4 (CC validation), AC-25 (CRLF/カンマ拒否), AC-33 (sanitize), AC-34 (scope 分離) |
| Phase 2 | AC-10 (reserve transaction), AC-11 (reserved lease 内), AC-12 (lease 期限切れ降格), AC-16 (run lock) |
| Phase 3 | AC-3 (sender), AC-5 (テンプレート), AC-32 (PII hash) |
| Phase 4 | AC-1 (100% 判定母集合), AC-2 (idempotency), AC-6 (スケジュール), AC-7 (kill switch), AC-13 (sent 更新), AC-14 (transient 維持), AC-15 (permanent 記録), AC-17 (403 全体中断), AC-18 (403 宛先固有), AC-19 (email 無効), AC-22 (案 C), AC-30 (OIDC) |
| Phase 5 | AC-8 (dry-run), AC-9 (test-send dummy), AC-20 (ownerEmail null), AC-21 (CcEmails 空), AC-23 (version 楽観ロック), AC-24 (CC 上限 10), AC-31 (Bearer auth) |
| Phase 6 | UI 統合 (AC-23 警告 reload, AC-25 chips validation) |
| Phase 8 | 全 AC 本番検証 |

---

## 10. CLAUDE.md ルール準拠チェックリスト

| ルール | 準拠状況 |
|---|---|
| CRITICAL: 3 ステップ以上 → `/impl-plan` | ✅ 本ドキュメント |
| CRITICAL: 3 ファイル以上 → `/simplify` + `/safe-refactor` | ✅ Phase 1/4/5/6 完了時 |
| CRITICAL: 同じエラー 3 回失敗 → `/codex` | ✅ 既に Phase 7 セルフレビュー後に実施済 |
| CRITICAL: API 境界変更 → FE/BE 確認 | ✅ Phase 5 で `check-api-impact` skill |
| CRITICAL: statusフィールド管理 → 状態遷移図先行 | ✅ 設計仕様書 §4.2 |
| CRITICAL: DB Partial Update → 更新対象外保護 | ✅ `sanitizeForUpdate` パターン (OQ-5) |
| CRITICAL: 未実装確認 → ソース実在確認 + git log | ✅ Phase 0 実施 |
| CRITICAL: main 直 push 禁止 | ✅ `feat/completion-notification-system-design` 作業中 |
| CRITICAL: destructive 操作 → 1 行詰めコマンド + 件数 assert | N/A (本機能は destructive 操作なし、新規追加のみ) |
| CRITICAL: グローバル memory 追加前に既存 grep + スコープ判定 | N/A |
| Test First: 実装 → `/tdd` で RED→GREEN→REFACTOR | ✅ Phase 1-5 で適用 |
| Test First: 境界値・異常系を必ず含める | ✅ AC-10〜18 / AC-19〜25 |
| Test First: 新データパス → 全出力フィールド期待値列挙 | ✅ progressSnapshot / courseIdsSnapshot |
| Test First: 関数戻り値変更 → 全呼び出し元整合性確認 | ✅ Phase 5 で `check-api-impact` |
| Test First: データフロー実装後 → `/trace-dataflow` | ✅ Phase 6 で適用 |
| Definition of Done: テスト・lint・型 PASS + 件数提示 | ✅ 各 Phase 完了時 |
| Definition of Done: コードパス最低 1 回実行 | ✅ Phase 8 cutover |
| Definition of Done: Test plan 全項目実行 | ✅ 各 PR で明記 |
| Definition of Done: 公式に存在しないメカニズム禁止 | ✅ Codex セカンドオピニオンで確認済 |
| Quality Gate: 実装完了後 `/simplify` | ✅ 各 Phase |
| Quality Gate: 3+ ファイル → `/safe-refactor` | ✅ 各 Phase |
| Quality Gate: 5+ ファイル → Evaluator 分離プロトコル | ✅ Phase 1, 4, 5, 6 |
| Quality Gate: PR レビュー → `/review-pr` | ✅ 各 PR |
| Debug Protocol: データ検証優先 | ✅ Phase 8 cutover 手順 |
| Task Delegation: 30 秒以上 → バックグラウンド | ✅ Codex セカンドオピニオン |

---

## 11. 想定リスクと対策

| リスク | 確率 | 影響 | 対策 |
|---|---|---|---|
| Google Group エイリアスが DWD subject として使えない | 中 | 高 | Phase 0 で smoke 必須、失敗時は SendAs/実ユーザー化を判断 |
| Cloud Run 300 秒で全 user 処理が完了しない (将来テナント増) | 低 (現状 2 テナント) | 中 | Phase 4 Integration Test で実測、超過時は resumable run を将来課題に |
| Reservation transaction が高頻度競合する | 低 | 低 | 並列度 8 + 単一 worker 想定なら問題なし、超過時は lease 短縮 |
| 受講者の Gmail が受信拒否設定 | 低 | 低 | Gmail API 403 宛先固有として failed_permanent 記録、本田様判断 |
| 本田様の Workspace 管理コンソール権限が不足 | 低 | 高 (Phase 0 ブロック) | Phase 0 開始時に最優先で確認 |
| 法務確認 (TTL 1 年) で延長要請 | 低 | 低 | TTL を 2-7 年等に調整、Firestore TTL Policy で対応可能 |
| Cloud Scheduler の barometer 起動誤差 | 低 | 低 | DB 設定との一致判定で吸収、5 分以内のずれは許容 |

---

## 12. 完了の定義 (Phase 全体)

以下を全て満たした時点で本機能の実装完了とする:

1. ✅ AC 30 件全て満たす自動テストが PASS
2. ✅ Phase 1-7 の全 PR が main にマージ済み
3. ✅ Phase 8 cutover で本番初回送信に成功
4. ✅ 受講者 1 名以上から実際に Gmail 受信確認
5. ✅ ADR-035 が main に登録済み
6. ✅ 本田様の運用引き継ぎ完了 (UI 操作・kill switch・script 復旧フロー説明)
7. ✅ `~/.claude/memory/` に運用上の教訓を追記 (該当があれば)
