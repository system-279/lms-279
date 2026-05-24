# DXcollege 自動完了通知 Phase 8 Cutover 実行手順

Phase 1〜7 で実装した自動完了通知システムを本番稼働開始させる手順。`super_dispatch_settings/global.enabled` を `true` に切り替えるまでの gating step を順番に実行する。

実装計画 §Phase 8 (`docs/specs/2026-05-20-completion-notification-impl-plan.md`) を実行用に展開したもの。

## TL;DR

```
Step 0: 開発者が SendAs 登録 (UI)
        │
        ▼
Step 1-3: enabled=false で初期化 → デプロイ確認 → cron no-op 確認 (AI 主導)
        │
        ▼
Step 4-5: SendAs send smoke (Step 4a) + dry-run (Step 5、admin SDK workflow) で配送/対象を検証 (AI 主導、目視は開発者)
        │
        ▼
Step 6-7: 対象一覧レビュー + 番号単位明示認可 (開発者必須)
        │
        ▼
Step 8-10: enabled=true → 初回 cron で送信 → audit_logs 確認 (AI 主導)
        │
        ▼
Step 11-12: 問い合わせ受付 / kill switch (開発者 + AI)
```

## 前提

- PR #442 〜 #485 (Phase 1〜7 + E2E 復旧) すべて main にマージ済み
- Cloud Run env 設定済み:
  - `DXCOLLEGE_DISPATCH_SUBJECT=system@279279.net` (DWD impersonation 対象 mailbox)
  - `DXCOLLEGE_SENDER_EMAIL=dxcollege@279279.net` (MIME From、SendAs 経由偽装)
  - `DISPATCH_OIDC_AUDIENCE=https://api-3zcica5euq-an.a.run.app`
- Cloud Scheduler `dxcollege-completion-notifications` ENABLED (毎時 JST 00 分起動)
- Firestore TTL Policy: `super_dispatch_audit_logs.ttlExpireAt` / `super_dispatch_runs.ttlExpireAt` 登録済み
- DWD scope `https://www.googleapis.com/auth/gmail.send` 登録済み

> doc 不在時の挙動は `services/api/src/services/dispatch/run-completion-notifications.ts:170-173` で **kill switch 同等 (no-op)** に設計済みのため、初期化前でも毎時 cron は無害。

## AI / 開発者 担当切り分け

| Step | 内容 | AI 領分 | 開発者必須 |
|---|---|---|---|
| 0 | SendAs 登録 | ❌ | ✅ |
| 1 | dispatch-settings 初期化 (enabled=false) | ✅ | - |
| 2 | 本番デプロイ | ⚠️ 認可後 AI | ✅ 番号認可 |
| 3 | Cloud Run 起動 + cron no-op 確認 | ✅ | - |
| 4a | SendAs send smoke (固定 dummy、開発者宛) | ✅ trigger | ✅ 受信目視 (From header 確認) |
| ~~4b~~ | ~~test-send~~ | 撤廃 (2026-05-24 PR-B、Step 4a で代替) | - |
| 5 | dry-run で対象一覧取得 | ✅ | - |
| 6 | 対象一覧レビュー | ❌ | ✅ |
| 7 | 本番有効化の明示認可 | ❌ | ✅ |
| 8 | enabled=true 切替 (Web UI) | ⚠️ Step 7 認可後の確認支援のみ | ✅ UI 操作 |
| 9 | 次の cron で初回送信 | - 自動 - | - |
| 10 | audit_logs / run_history 確認 | ✅ | - |
| 11 | 受信者問い合わせ受付 | ❌ | ✅ |
| 12 | 問題発生時 kill switch (Web UI) | ⚠️ 発動判断の助言のみ | ✅ UI 操作 |

---

## Step 0: SendAs 登録 (開発者必須)

ADR-037 §実装方針 4 / 設計仕様書 §8.2.2 の手順を実行する。

### 手順

1. https://mail.google.com に `system@279279.net` でログイン
2. 設定 (歯車) → **「すべての設定を表示」** → **「アカウントとインポート」** タブ
3. **「他のメール アドレスを追加」** をクリック
4. 入力:
   - 名前: `DXcollege運営スタッフ`
   - メールアドレス: `dxcollege@279279.net`
   - **エイリアスとして扱う**: チェック **ON**
5. 「次のステップ」→ Workspace 内部送信なので SMTP 認証は不要、そのまま完了
6. (任意) 「メール送信時のデフォルトの返信アドレス」を `dxcollege@279279.net` に設定

### 期待結果

「アカウントとインポート」タブの「名前」セクションに `DXcollege運営スタッフ <dxcollege@279279.net>` (エイリアス) が表示される。

### 完了確認

完了したら次の Step に進む合図を開発者から AI に伝える。

### 失敗時

- 「他のメール アドレスを追加」が見つからない → Workspace 管理コンソールで `system@279279.net` の Gmail 設定が制限されている可能性。管理者権限で確認。
- 確認コードを要求された → 通常 Workspace 内部送信では出ないが、出た場合は `dxcollege@279279.net` グループに届く確認メールから取得。

---

## Step 1: dispatch-settings/global を enabled=false で初期化 (AI 主導)

### 前提

現在 `super_dispatch_settings/global` doc が存在するか不明。doc 不在は no-op だが、Step 8 で UI から `enabled=true` 切替するため事前に doc を作成しておく。

### 手順

Web UI ベース (推奨、追加 admin SDK workflow 不要):

1. 開発者がブラウザで `https://web-1034821634012.asia-northeast1.run.app/super/dispatch-settings` にアクセス (Firebase 認証 + super-admin)
2. ScheduleEditor で初期値設定:
   - **enabled: false** (kill switch on)
   - scheduleDaysOfWeek: 任意（後で変更可）
   - scheduleHourJst: 任意（後で変更可）
   - signatureName: `DXcollege運営スタッフ` (default)
   - completionMessageBody: 任意（後で変更可、現場メッセージ ④ の文言を入れる）
3. 「保存」で doc 作成

> Web UI 操作は開発者が実行。AI は Web UI 経由の Firebase 認証を持たない。

### 期待結果

- Firestore に `super_dispatch_settings/global` doc が作成され、`enabled: false`
- Cloud Scheduler が次の 00 分に起動しても何もしない (kill switch)

### 失敗時

- 画面が表示されない → Cloud Run の `web` service ログ確認、または api service の super-admin auth エラー確認

---

## Step 2: 本番デプロイ (Phase 1-7 PR がすべて反映済みなら skip)

### 確認

```bash
gh run list --branch main --workflow=deploy.yml --limit 3
```

最新 deploy が PR #485 (Session 47) の merge commit 後で成功していれば skip。古い場合のみ:

```bash
gh workflow run deploy.yml --ref main
```

### 期待結果

`Deploy to Cloud Run` workflow が PASS。

### 失敗時

deploy workflow のログ確認。Cloud Run revision の `lastReadyRevision` が新しい revision に更新されているか確認。

---

## Step 3: Cloud Run 起動 + cron no-op 確認 (AI 主導)

### 手順

1. Cloud Scheduler の最終実行状態を確認:
   ```bash
   gcloud scheduler jobs describe dxcollege-completion-notifications \
     --location=asia-northeast1 --project=lms-279 \
     --format="yaml(state,lastAttemptTime,status)"
   ```
   `state: ENABLED` / `status: {}` であること

2. Cloud Run revision を確認:
   ```bash
   gcloud run services describe api --region=asia-northeast1 --project=lms-279 \
     --format="value(status.latestReadyRevisionName,status.url)"
   ```

3. 次の毎時 00 分まで待ち、`status: {}` が維持されることを確認 (もしくは 1 回 cron が動いていることを確認)。

### 期待結果

- `lastAttemptTime` が直近 1 時間以内
- `status: {}` (エラーなし)
- `super_dispatch_runs` collection に新しい runId doc が作成され、status=`completed` で skip 理由が `settings_disabled` (enabled=false ガード成立)

### 失敗時

- `status.code` が 0 以外 → Cloud Run のログを確認 (本番 logs read は decision-maker 認可が必要)

---

## Step 4: SendAs send smoke + test-send (AI trigger / 開発者目視)

### 4a. SendAs send smoke (GitHub Actions workflow)

```bash
gh workflow run smoke-dwd-gmail-send.yml \
  -f mode=send \
  -f to_email=system@279279.net \
  -f subject_email=system@279279.net \
  -f sender=dxcollege@279279.net
```

または GitHub UI で「Smoke DWD Gmail Send」を Run workflow。

#### 期待結果 (AI 確認)

- workflow が PASS
- workflow ログに `✓ 送信成功` + `messageId: ...` が出力
- 「SendAs smoke check 結果: PASS (API 受理)」

#### 期待結果 (開発者目視)

- `system@279279.net` の Gmail 受信トレイに smoke メールが届く
- **From ヘッダが `DXcollege運営スタッフ <dxcollege@279279.net>` で表示される** (SendAs 経由偽装が成立)

### 4b. test-send — 撤廃 (2026-05-24 PR-B)

UI の「テスト送信」ボタン + `/api/v2/super/dispatch/test-send` endpoint は撤廃済み。SendAs 経路の検証は Step 4a (`smoke-dwd-gmail-send.yml`) で完了しているため追加の test-send は不要。

設定値 (本文 / 署名 / CC) を反映した完全な MIME プレビューは **Step 5 (dry-run admin SDK)** で取得する。

### 失敗時 (Step 4a smoke のみ)

| 症状 | 原因候補 | 対処 |
|---|---|---|
| smoke 401 unauthorized_client | `--subject-email` が Group エイリアスのまま | `subject_email=system@279279.net` を確認 |
| smoke 400 invalidArgument / SendAs not configured | Step 0 未完了 | Step 0 を再実行 |

---

## Step 5: dry-run で対象一覧取得 (AI 主導、2026-05-24 PR-B で UI 撤廃 → admin SDK 経由)

### 手順

UI の「ドライラン」ボタンは撤廃済み。AI が `dispatch-dry-run.yml` workflow を起動して対象一覧 + MIME プレビューを取得:

```bash
gh workflow run dispatch-dry-run.yml --ref main
```

または GitHub UI で「Dispatch Dry Run」を Run workflow。

AI が完了監視 → `gh run download <run-id>` で artifact (`dispatch-dry-run-result-*.json`) 取得 → JSON を解析して開発者に提示。

### 期待結果

- 表示された受講者リストが、テナント管理画面 (`/super/tenants`) の各テナントで 100% 完了している受講者と一致
- `course_progress.isCompleted=true` かつ `totalLessons === lessonOrder.length` を満たすコースのみカウント
- 対象 0 件の場合: 全コース 100% 完了している受講者が現時点で存在しない (期待通り)

### 失敗時

- 対象が想定より多い → eligibility ロジック (`completion-eligibility.ts`) のテストデータ確認、本番データの実態と乖離がないか確認
- 対象 0 件で想定外 → 100% 完了している受講者が本当にいないか、または `course_progress` doc が欠損していないか確認

---

## Step 6: 対象一覧レビュー (開発者必須)

### 担当: 開発者 (4 原則 §1 decision-maker 領分)

Step 5 の dry-run 結果を開発者が目視レビューし、以下を判断:

- 対象受講者が「本当に完了通知を送って良い」状態か
- 期待外の受講者が混入していないか (テスト用 / 退会済み等)
- スケジュール (`scheduleDaysOfWeek` / `scheduleHourJst`) の設定が現場運用と合っているか (現場メッセージ ① の「指定曜日・時間」)
- テナント別 CC 設定 (`notificationCcEmails`) が各テナントの担当者と合っているか (現場メッセージ ②)

### 期待結果

開発者から「対象一覧 OK、cutover 進めて良い」または「修正必要 (理由)」のフィードバック。

---

## Step 7: 本番有効化の明示認可 (開発者必須)

### 担当: 開発者 (CLAUDE.md 4 原則 §3 番号単位明示認可)

AI からの認可要請テンプレート:

```
DXcollege 自動完了通知の本番有効化 (enabled=false → true) を実行してよろしいですか？

対象: super_dispatch_settings/global.enabled
変更前: false
変更後: true
影響: 次の毎時 00 分から自動送信が開始される

承認形式: "Step 8 を実行してよい" または番号単位の具体的承認
```

### 期待結果

開発者から具体的な実行承認の返答 (汎用的な「進めて良い」等ではなく、本 step 番号を明示)。

---

## Step 8: enabled=true 切替 (開発者 UI 操作、Step 7 認可後)

### 担当: 開発者 (Web UI 操作) + AI (前後の状態確認支援)

現状 AI には本番 super-admin API を直接叩く経路がない (super-admin auth は Firebase Bearer Token、admin SDK workflow も未整備) ため、本 step の実 write は開発者が UI で実行する。

### 手順

開発者がブラウザで `/super/dispatch-settings` を開き、`enabled` を **true** に切替して保存。

AI は前後の状態確認 (切替前: enabled=false / dry-run 対象一覧 / 切替後: enabled=true / version +1) を支援する。

> 将来 AI が直接実行できるようにするには、新規 admin SDK workflow (例: `dispatch-settings-toggle.yml`) の整備が必要。現状は cutover 当日にこの workflow を作るより、Web UI の方が高速かつ可逆。

### 期待結果

- Firestore `super_dispatch_settings/global.enabled=true`
- 設定の `version` フィールドが +1

### Rollback

`enabled` を `false` に戻すだけで即時 kill switch (次の cron で何もしない)。

---

## Step 9: 次の cron で初回送信 (自動)

最大 60 分以内に毎時 00 分起動の cron が実行され、Step 5 の dry-run で確認した対象に対して実送信が走る。

### 期待結果

- `super_dispatch_runs` collection に runId doc が作成され、最終的に `status=completed`
- 各送信対象 user に対して `completion_notifications/{userId}` doc が `reserved` → `sent` で更新される
- 受講者本人 + テナント担当者 (ownerEmail + notificationCcEmails) にメールが届く

---

## Step 10: audit_logs / run_history で送信件数確認 (AI 主導)

### 手順

1. 開発者がブラウザで `/super/dispatch-settings` の「配信履歴」セクションを確認
2. 直近の run の `sent` / `skipped` / `failed` カウントを確認

または AI が super-admin API 経由で取得 (Firebase Bearer Token 必要、現状は Web UI 経由が現実的)。

### 期待結果

- `sent` カウント = Step 5 dry-run の対象件数
- `failed` カウント = 0
- `skipped` カウント = (`reserved` のまま transient 失敗 / `manual_review_required` / 既送信スキップ等)

### 異常時

`failed` > 0:
- failed_permanent 詳細を audit_logs で確認
- transient 失敗 (429/503) は次回 cron で自動再試行されるはず

---

## Step 11: 受信者問い合わせ受付 (開発者)

担当: 開発者

初回送信後 24 時間以内に受講者・テナント担当者から問い合わせがあれば、内容を整理して AI と共有。AI が必要に応じて Step 12 (kill switch) を発動する判断材料。

---

## Step 12: 問題発生時の kill switch (開発者 UI 操作)

### 担当: 開発者 (Web UI 操作) + AI (発動判断の助言)

Step 8 と同様、現状 AI には super-admin API への直接 write 経路がない。緊急時の最短経路は Web UI 操作。

### 発動条件

- 配送先誤り (期待外のテナント / 受講者に届いた)
- From ヘッダが期待通りに表示されない
- CC 担当者の登録ミス
- 文面の重大な誤り

### 手順

開発者がブラウザで `/super/dispatch-settings` の `enabled` を **false** に切替して保存。

AI は audit_logs / run_history を確認して影響範囲 (sent カウント / failed カウント / どのテナント・受講者に届いたか) を把握し、Recovery 計画を提示する。

### 期待結果

- `super_dispatch_settings/global.enabled=false`
- 次の毎時 cron 起動で no-op

### Recovery 後の再開

問題を修正したうえで Step 5 (dry-run 再確認) → Step 7 (再認可) → Step 8 (enabled=true 再設定) を再実行。

---

## 関連リソース

- ADR-037: `docs/adr/ADR-037-completion-notification-sender-impersonation.md`
- 設計仕様書: `docs/specs/2026-05-20-completion-notification-design.md`
- 実装計画: `docs/specs/2026-05-20-completion-notification-impl-plan.md`
- 処理フロー図: `docs/specs/2026-05-20-completion-notification-flow.mmd`
- smoke script: `scripts/smoke-dwd-gmail-send.ts`
- smoke workflow: `.github/workflows/smoke-dwd-gmail-send.yml`
- LATEST handoff: `docs/handoff/LATEST.md`
