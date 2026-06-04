# DXcollege 進捗レポート定期自動配信 Cutover 実行手順

Phase 3 PR 3a-3e で実装した「進捗レポート定期自動配信」を本番稼働開始させる手順。`super_dispatch_settings/global.progressReport.enabled` を `true` に切り替えるまでの gating step を順番に実行する。

実装計画 §PR 3e (`docs/specs/2026-06-01-progress-report-dispatch-impl-plan.md`) を実行用に展開したもの。完了通知レーン cutover (`dxcollege-completion-notification-cutover.md`) を mirror した姉妹 runbook。

## TL;DR

```
Step 0: Cloud Scheduler / TTL Policy / SA 権限 1 回限り setup (AI 主導 + 開発者認可)
        │
        ▼
Step 1-2: テナント opt-in (progressReportEnabled=true) + dispatch-settings.progressReport=false
          で初期化 (業務スーパー管理者 UI / AI 確認)
        │
        ▼
Step 3-4: cron no-op 確認 → dry-run で対象一覧取得 (AI 主導)
        │
        ▼
Step 5: 対象一覧レビュー + 番号単位明示認可 (開発者必須)
        │
        ▼
Step 6: progressReport.enabled=true → 初回 cron で送信 (業務スーパー管理者 UI)
        │
        ▼
Step 7-8: audit_logs / run_history 確認 → 問題発生時 kill switch (業務スーパー管理者 UI)
```

## 前提

- PR #506 〜 #514 (Phase 3 設計 + PR 3a/3b/3c/3d) すべて main にマージ済み
- PR 3e の `scripts/progress-report-dry-run-cli.ts` / `.github/workflows/progress-report-dry-run.yml` が main にマージ済み (本 PR 範囲)
- 完了通知レーン (`dxcollege-completion-notifications` cron) が安定稼働済 (進捗レーンは完了通知 cutover の経験を前提)
- Cloud Run env 設定済:
  - `DXCOLLEGE_DISPATCH_SUBJECT=system@279279.net`
  - `DXCOLLEGE_SENDER_EMAIL=dxcollege@279279.net`
  - `DISPATCH_OIDC_AUDIENCE=https://api-3zcica5euq-an.a.run.app`
- DWD scope `https://www.googleapis.com/auth/gmail.send` 登録済 (完了通知レーンと共用)

> doc 不在 / `progressReport=undefined` / `progressReport.enabled=false` のいずれも `run-progress-reports.ts` 側で **kill switch 同等 (no-op)** に設計済み (AC-PR-05 / AC-PR-22)。初期化前の cron 起動は無害。

## AI / 開発者 / 業務スーパー管理者 担当切り分け

| Step | 内容 | AI 領分 | 開発者必須 | 業務スーパー管理者必須 |
|---|---|---|---|---|
| 0 | Cloud Scheduler / TTL / SA 権限 setup | ⚠️ 認可後 AI | ✅ 番号認可 | - |
| 1 | テナント opt-in (progressReportEnabled=true) | - | - | ✅ UI 操作 |
| 2 | dispatch-settings.progressReport 初期化 (enabled=false) | - | - | ✅ UI 操作 |
| 3 | cron no-op 確認 | ✅ | - | - |
| 4 | dry-run で対象一覧取得 | ✅ | - | - |
| 5 | 対象一覧レビュー + 認可 | ❌ | ✅ | - |
| 6 | progressReport.enabled=true 切替 | ⚠️ 状態確認支援のみ | - | ✅ UI 操作 |
| 7 | audit_logs / run_history 確認 | ✅ | - | - |
| 8 | 問題発生時 kill switch | ⚠️ 発動判断の助言のみ | - | ✅ UI 操作 |

> **運用方針 (2026-05-24 確定、完了通知 cutover と共通)**: 本番投入の最終操作 (Step 6 マスタートグル ON / Step 8 kill switch) は **業務スーパー管理者本人の手** でのみ実行する。AI も開発者も代行しない。AI 駆動開発 4 原則 §1 の具体展開。

---

## Step 0: Cloud Scheduler / TTL Policy / SA 権限 setup (1 回限り、AI 主導 + 開発者認可)

### 0a. Cloud Scheduler job 作成 (進捗レーン専用、完了通知と 30 分ずらす)

完了通知 cron `dxcollege-completion-notifications` が毎時 00 分起動なので、進捗レーンは **毎時 30 分起動** にして同時起動時の Gmail 429 競合を回避する (ADR-039 リスク管理方針)。

### 認可要請テンプレート

```
Cloud Scheduler job `dxcollege-progress-reports` を新規作成してよろしいですか？

操作: gcloud scheduler jobs create http
schedule: "30 * * * *" (JST、完了通知と 30 分ずらす)
target: https://api-3zcica5euq-an.a.run.app/api/v2/internal/dispatch/run-progress-reports
auth: OIDC token (service account: dxcollege-scheduler@lms-279.iam.gserviceaccount.com、完了通知レーンと共用)
audience: https://api-3zcica5euq-an.a.run.app (= DISPATCH_OIDC_AUDIENCE env)

副作用: 毎時 30 分に HTTP POST が走る (progressReport.enabled=false の間は no-op 返却)
ロールバック: gcloud scheduler jobs pause で停止可能、または delete で削除可能

承認形式: "Step 0a を実行してよい" または番号単位の具体的承認
```

### 実行コマンド (認可後)

```bash
gcloud scheduler jobs create http dxcollege-progress-reports \
  --location=asia-northeast1 \
  --project=lms-279 \
  --schedule="30 * * * *" \
  --time-zone="Asia/Tokyo" \
  --uri="https://api-3zcica5euq-an.a.run.app/api/v2/internal/dispatch/run-progress-reports" \
  --http-method=POST \
  --oidc-service-account-email="dxcollege-scheduler@lms-279.iam.gserviceaccount.com" \
  --oidc-token-audience="https://api-3zcica5euq-an.a.run.app" \
  --description="Phase 3 進捗レポート定期自動配信 (ADR-039)" \
  --attempt-deadline=280s \
  --max-retry-attempts=0
```

> SA `dxcollege-scheduler@lms-279.iam.gserviceaccount.com` は完了通知レーン (`dxcollege-completion-notifications`) と共用。既に `roles/run.invoker` が Cloud Run `api` service に付与済みのため追加 IAM 操作は不要 (完了通知 cutover の Step 0 で実施済、`docs/specs/2026-05-20-completion-notification-design.md` §708 参照)。新規 SA を作成する選択は、完了通知レーンとの権限不均衡 / DWD scope 共有 / monitoring 経路の分散を招くため非推奨。

> `--max-retry-attempts=0`: 進捗レーンは at-least-once 配信を occurrenceId で冪等化 (AC-PR-06)。Cloud Scheduler 自動 retry は意味がなく、duration 加算で次 cron との重複起動リスクを増やすため 0 に固定。

### 期待結果

```bash
gcloud scheduler jobs describe dxcollege-progress-reports \
  --location=asia-northeast1 --project=lms-279 \
  --format="yaml(state,schedule,timeZone,lastAttemptTime)"
```

- `state: ENABLED`
- `schedule: "30 * * * *"`
- `timeZone: "Asia/Tokyo"`

### 失敗時

- `PERMISSION_DENIED`: 作成者 (cli 実行者) に `roles/cloudscheduler.admin` がない、または SA `dxcollege-scheduler@lms-279.iam.gserviceaccount.com` に `roles/run.invoker` がない → IAM 確認
- `INVALID_ARGUMENT`: schedule cron 構文 / time-zone 名 / URI を確認

### 0b. Firestore TTL Policy 登録 (`progress_report_sends.ttlExpireAt`、90 日保持)

進捗レーンの送信記録 (`tenants/{tid}/progress_report_sends/{occurrenceId}__{userId}`) は AC-PR-17 で 90 日保持。Firestore TTL Policy で自動削除する。

### 認可要請テンプレート

```
Firestore TTL Policy を登録してよろしいですか？

対象: tenants/{tenantId}/progress_report_sends/{*} の ttlExpireAt フィールド
影響: 各 doc の ttlExpireAt が過去になった時点で自動削除 (最大 24 時間遅延あり)
ロールバック: gcloud firestore fields ttls disable で無効化可能 (既削除 doc は復元不可)

承認形式: "Step 0b を実行してよい" または番号単位の具体的承認
```

### 実行コマンド (認可後)

```bash
gcloud firestore fields ttls update ttlExpireAt \
  --collection-group=progress_report_sends \
  --enable-ttl \
  --project=lms-279 \
  --database='(default)'
```

### 期待結果

```bash
gcloud firestore fields ttls list \
  --project=lms-279 --database='(default)' \
  --filter="name~progress_report_sends"
```

`state: ACTIVE` の TTL Policy が表示される。

### 失敗時

- `policy already exists`: 既に登録済 → skip OK
- `quota exceeded` (TTL Policy は project あたり 200 個まで): 不要な TTL を整理

### 0c. Workflow Identity Pool に dry-run workflow 権限追加 (確認のみ、変更不要想定)

`progress-report-dry-run.yml` workflow は既存 `dispatch-dry-run.yml` と同じ WIF + SA (`github-actions@lms-279.iam.gserviceaccount.com`) を使うため、追加 IAM 設定は不要。

念のため確認:

```bash
gcloud iam service-accounts get-iam-policy \
  github-actions@lms-279.iam.gserviceaccount.com \
  --project=lms-279
```

`roles/iam.workloadIdentityUser` が `principalSet://iam.googleapis.com/projects/.../attribute.repository/system-279/lms-279` に bind されていれば OK。

---

## Step 1: テナント opt-in (progressReportEnabled=true)

### 担当: 業務スーパー管理者 (Web UI 操作)

進捗レポート定期配信は **テナント単位 opt-in (default false、ADR-039 D-6)**。対象テナントごとに業務スーパー管理者が UI から ON にする。

### 手順 (業務スーパー管理者向け)

1. ブラウザで `/super/dispatch-settings` を開く
2. 「テナントごとの CC 追加設定」セクションでテナントを選択
3. 「**このテナントへの進捗レポート定期配信**」スイッチを **OFF → ON** に切替
4. 「保存」ボタン押下
5. 「保存しました」が表示されることを確認

> 完了通知の opt-in (`completionNotificationEnabled`) とは独立。両方 ON / 片方のみ ON / 両方 OFF いずれも可。

### 期待結果

- Firestore `tenants/{tenantId}.progressReportEnabled=true`
- 対象テナントすべてに同操作を実施した状態

### AI の支援範囲

- 操作前後の Firestore 状態確認 (`tenants/{tid}.progressReportEnabled` の値読み取り)
- 業務スーパー管理者からの UI 操作・文言に関する質問への回答

---

## Step 2: dispatch-settings.progressReport を enabled=false で初期化

### 担当: 業務スーパー管理者 (Web UI 操作)

### 手順 (業務スーパー管理者向け)

1. ブラウザで `/super/dispatch-settings` を開く
2. 「進捗レポート 定期配信」セクションで初期値設定:
   - **配信 OFF** (kill switch on、Step 6 まで OFF のまま)
   - 配信曜日: 任意（後で変更可、例: 月曜・木曜）
   - 配信時刻: 任意（後で変更可、Cloud Scheduler の `30 * * * *` に合わせるなら `9` 等)
3. 「保存」ボタン押下
4. version が +1 されていること、「保存しました」が表示されることを確認

### 期待結果

- Firestore `super_dispatch_settings/global.progressReport.enabled=false`
- `progressReport.scheduleDaysOfWeek` / `scheduleHourJst` に値が入る
- Cloud Scheduler が次の 30 分に起動しても何もしない (AC-PR-05)

---

## Step 3: cron no-op 確認 (AI 主導)

### 手順

1. Cloud Scheduler 最終実行状態:
   ```bash
   gcloud scheduler jobs describe dxcollege-progress-reports \
     --location=asia-northeast1 --project=lms-279 \
     --format="yaml(state,lastAttemptTime,status)"
   ```
   `state: ENABLED` / `status: {}` であること

2. 次の毎時 30 分まで待ち、`status: {}` が維持されることを確認

3. `super_dispatch_runs` collection で進捗レーンの run を確認:
   - 期待: doc が **作成されない** (進捗レーンは shouldRunProgressReportNow が false の段階で no-op、lane lock も取らない、AC-PR-05)

### 失敗時

- `status.code` が 0 以外 → Cloud Run のログを確認 (本番 logs read は decision-maker 認可が必要)

---

## Step 4: dry-run で対象一覧取得 (2 経路、Phase 4 α-7-FE で UI 復活)

### 経路 A: UI 経由 (推奨、業務スーパー管理者でも実施可)

Phase 4 α-7-FE (PR #519) で UI の「配信プレビュー」セクションが復活。`/super/dispatch-settings` ページの「進捗レポート 配信プレビュー」セクションで「プレビューを取得」ボタンを押す:

1. ブラウザで `/super/dispatch-settings` を開く
2. 「進捗レポート 定期配信」セクションで `progressReport.enabled` / 曜日 / 時刻が保存済みであることを確認
3. 直下の「進捗レポート 配信プレビュー」セクションの「プレビューを取得」ボタンを押す
4. 5 秒以内に対象テナント数 / 送信予定数 / 推定処理時間 / PDF 推定サイズが表示される
5. 「scale trigger 超過」warning が出た場合は Step 5 で Cloud Tasks 移行検討の要否を判断 (ADR-039)
6. テナント別 table で `skipped` / `wouldSendCount` / `ineligibleCount` 等の内訳を確認

**運用ロック注記** (α-7-FE 仕様、AC-α7-13):
- 進捗レポート設定 (曜日 / 時刻 / `progressReport.enabled`) を編集中はプレビューに反映されない (保存済み設定で計算)
- 編集後は必ず「保存」ボタンを押してから「プレビューを取得」を押す
- 同時に複数の業務スーパー管理者が編集・プレビューしないこと (10 req/min/email の rate limit + α-5 未実施で lost update リスク)
- **rate budget は完了通知レーンと共有** (10 req/min/email の合算、AC-α7-12 / BE `dispatch-dry-run-limiter.ts`)。両 lane を立て続けにプレビューすると合計 10 回で 429 に到達するので、必要なほうから順に取得すること

### 経路 B: admin SDK workflow (経路 A 不可時、AI 主導)

UI が表示できない / 一時的に落ちている場合、AI が `progress-report-dry-run.yml` workflow を起動:

```bash
gh workflow run progress-report-dry-run.yml --ref main
```

または GitHub UI で「Progress Report Dry Run」を Run workflow。

AI が完了監視 → `gh run download <run-id>` で artifact (`progress-report-dry-run-result-*.json`) 取得 → JSON を解析して開発者に提示。

### 期待結果

- `totalWouldSendCount`: 全テナント合計の実送信対象数
- テナント別 `tenantsSummary[]`:
  - `skipped: true` の理由が `progress_report_disabled` のテナントは Step 1 で opt-in 未済
  - `skipped: false` の `wouldSendCount` が 0 のテナント: 受講中フィルタ (期限内 + 進捗 1% 以上 + non 100% 完了) を満たす user がいない
- `estimatedDurationMs`: 推定処理時間 (1 通あたり ~2 秒 + 並列度 8 から雑算)
- `estimatedPdfSizeKbRange`: 経験値レンジ (実測は本 Step では取らない)
- `scaleTriggerExceeded`: 全テナント合計 300 名超で `true` (Cloud Tasks 移行検討)

### 失敗時

- workflow が異常終了 → workflow log を確認、Firestore 接続 / shared-types build エラーを切り分け
- 対象が想定より多い → 受講中フィルタ (`listProgressReportTargetUsers`) のロジック確認、`enrollment_setting._config.videoAccessUntil` の値が実態と乖離していないか
- 対象 0 件で想定外 → Step 1 のテナント opt-in 実施漏れ、または対象テナントに「進捗 1% 以上 + 期限内 + student」の user が存在しない

### scale trigger 超過時のアクション

`scaleTriggerExceeded: true` (>300 名) の場合は **原則 Step 6 (本番有効化) を保留** する。理由:

- Cloud Run timeout 280s + 並列度 8 + 1 通あたり 2 秒の理論上限は ~1120 名 / 1 run だが、PDF 生成負荷の variance、Firestore read latency、Gmail 429 retry などで実効値は大幅に下がる
- 完了通知レーンと進捗レーンの合算で Workspace `system@279279.net` の Gmail 1800 通/日 (rolling 24h) を超過すると **両レーン同時停止** に直結する
- 300 名超は ADR-039 で Cloud Tasks 移行検討の閾値として明示済

選択肢 (どれか採用するまで Step 6 保留):
1. **対象テナントを分けて段階的に opt-in**: テナント単位で `progressReportEnabled=true` を 1-2 テナントずつ ON → 1 週間運用安定確認 → 次へ
2. **Phase 4 で Cloud Tasks 化を完了させてから cutover**: Cloud Tasks 経由で 1 通あたり別 task として分散実行することで Cloud Run timeout / Gmail rate 制約から独立化
3. **scheduleDaysOfWeek を分散**: 全テナント同曜日配信を曜日分散 (例: A 群 = 月、B 群 = 木) して 1 cron あたりの負荷を半減

開発者から明示認可なき限り、`scaleTriggerExceeded: true` で Step 6 認可要請を出さない。

---

## Step 5: 対象一覧レビュー + 認可 (開発者必須)

### 担当: 開発者 (4 原則 §1 decision-maker 領分)

Step 4 の dry-run 結果を開発者が目視レビューし、以下を判断:

- 対象受講者が「本当に進捗レポートを送って良い」状態か
- 期待外の受講者が混入していないか (テスト用 / 退会済み等)
- スケジュール (`progressReport.scheduleDaysOfWeek` / `scheduleHourJst`) の設定が現場運用と合っているか
- テナント別 CC 設定 (`notificationCcEmails`) が各テナントの担当者と合っているか
- 推定処理時間が Cloud Run timeout 280s に収まるか
- `scaleTriggerExceeded` が `true` の場合は段階配信 / Phase 4 移行検討

### AI からの認可要請テンプレート

```
DXcollege 進捗レポート定期自動配信の本番有効化 (progressReport.enabled=false → true) を実行してよろしいですか？

対象: super_dispatch_settings/global.progressReport.enabled
変更前: false
変更後: true
影響: 次の毎時 30 分から自動送信が開始される

dry-run 結果:
- totalWouldSendCount: {N} 件
- estimatedDurationMs: ~{M} 秒
- scaleTriggerExceeded: {true|false}

承認形式: "Step 6 を実行してよい" または番号単位の具体的承認
```

### 期待結果

開発者から具体的な実行承認の返答 (汎用的な「進めて良い」等ではなく、本 step 番号を明示)。

---

## Step 6: progressReport.enabled=true 切替 (業務スーパー管理者 UI 操作、Step 5 認可後)

### 担当: 業務スーパー管理者 (Web UI 操作) + AI (前後の状態確認支援)

完了通知 cutover と同じ運用方針。Step 5 で開発者から技術ゲート認可を受領した後、業務スーパー管理者が UI を理解し「自分で操作できる」とご判断頂けた段階でご本人が実 write を行う。

### 手順 (業務スーパー管理者向け)

1. ブラウザで `/super/dispatch-settings` を開く
2. 「進捗レポート 定期配信」セクションの「進捗レポート定期配信を有効化」スイッチを **OFF → ON** に切替
3. 「保存」ボタン押下
4. version が +1 されていること、「進捗レポート配信 ON」が表示されることを確認

### AI の支援範囲

- 切替前: 現状 `progressReport.enabled` / dry-run 対象一覧の最新値取得
- 切替後: `progressReport.enabled=true` / version +1 / 監査ログに `settings_updated` イベント記録の確認
- 業務スーパー管理者からの操作・文言に関する質問への回答

### AI が代行しない操作 (executor 越権防止)

- 業務スーパー管理者の代わりに `progressReport.enabled=true` を切替・保存すること
- 「業務スーパー管理者の判断を待たずに進める」意思決定

### 期待結果

- Firestore `super_dispatch_settings/global.progressReport.enabled=true`
- 設定の `version` フィールドが +1
- 完了通知レーンへの副作用なし (完了通知の `enabled` は変化しない、AC-PR-11)

### Rollback

`progressReport.enabled` を `false` に戻すだけで即時 kill switch (次の cron で進捗のみ no-op、完了通知影響なし、AC-PR-22)。

---

## Step 7: audit_logs / run_history で送信件数確認 (AI 主導)

### 手順

1. 次の毎時 30 分の cron で初回送信が実行される
2. 業務スーパー管理者がブラウザで `/super/dispatch-settings` の「配信履歴」「監査ログ」セクションを確認
3. AI が `super_dispatch_runs` / `super_dispatch_audit_logs` の最新 run を確認

### 期待結果

- `super_dispatch_runs` に runId doc が作成され、最終的に `status=completed`
- 各送信対象 user に対して `tenants/{tid}/progress_report_sends/{occurrenceId}__{userId}` doc が `pending` → `sent` で更新される
- 受講者本人 (To) + テナント担当者 (CC) に進捗レポート (PDF 添付) が届く
- `audit_logs` に `progress_report_run_started` / `progress_report_run_completed` イベントが記録される

### 異常時

- `failed` > 0:
  - `failed_permanent` 詳細を audit_logs で確認
  - transient 失敗 (429/503) は次回 cron で自動再試行されるはず
- `pdf_too_large` skip カウント > 0 (AC-PR-13):
  - 該当 user の `course_progress` が異常に多い可能性。テナント側で section 削減検討
- `scope_revoked` (AC-PR-22 abort):
  - DWD scope が剥奪された → Workspace 管理コンソールで再設定

---

## Step 8: 問題発生時の kill switch (業務スーパー管理者 UI 操作)

### 担当: 業務スーパー管理者 (Web UI 操作) + AI (発動判断の助言)

Step 6 と同様、停止操作も業務スーパー管理者本人の領分。

### 発動条件

- 配送先誤り (期待外のテナント / 受講者に届いた)
- PDF 内容の重大な誤り (進捗集計ロジックの bug)
- CC 担当者の登録ミス
- Gmail 1800 通/日 上限近接

### 手順 (業務スーパー管理者向け)

業務スーパー管理者がブラウザで `/super/dispatch-settings` の「進捗レポート 定期配信」セクションで `enabled` を **ON → OFF** に切替して保存。

AI は audit_logs / run_history を確認して影響範囲 (sent カウント / failed カウント / どのテナント・受講者に届いたか) を把握し、Recovery 計画を提示する。

### 期待結果

- `super_dispatch_settings/global.progressReport.enabled=false`
- 次の毎時 30 分 cron 起動で進捗レーン no-op
- **完了通知レーン影響なし** (AC-PR-22)

### Recovery 後の再開

問題を修正したうえで Step 4 (dry-run 再確認) → Step 5 (再認可) → Step 6 (`progressReport.enabled=true` 再設定) を再実行。

---

## 関連リソース

- ADR-039: `docs/adr/ADR-039-phase3-progress-report-dispatch.md`
- 設計仕様書: `docs/specs/2026-06-01-progress-report-dispatch-design.md`
- 実装計画: `docs/specs/2026-06-01-progress-report-dispatch-impl-plan.md`
- 処理フロー図: `docs/specs/2026-06-01-progress-report-dispatch-flow.mmd`
- dry-run script: `scripts/progress-report-dry-run-cli.ts`
- dry-run workflow: `.github/workflows/progress-report-dry-run.yml`
- 完了通知 cutover (mirror): `docs/runbook/dxcollege-completion-notification-cutover.md`
- LATEST handoff: `docs/handoff/LATEST.md`
