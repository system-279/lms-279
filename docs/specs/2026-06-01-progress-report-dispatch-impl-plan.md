# 進捗レポート 定期自動配信 (Phase 3) 実装計画

| 項目 | 値 |
|---|---|
| 起票日 | 2026-06-01 |
| 設計仕様書 | [`2026-06-01-progress-report-dispatch-design.md`](./2026-06-01-progress-report-dispatch-design.md) |
| 関連 ADR | ADR-039 |
| 関連 PR | (3a / 3b / 3c / 3d / 3e + 設計 PR 本 PR) |

---

## 1. PR 分割 (5 PR + 1 設計 PR)

### Phase 3-design (本 PR): ADR-039 + 3 spec
- `docs/adr/ADR-039-phase3-progress-report-dispatch.md`
- `docs/specs/2026-06-01-progress-report-dispatch-design.md`
- `docs/specs/2026-06-01-progress-report-dispatch-impl-plan.md`
- `docs/specs/2026-06-01-progress-report-dispatch-flow.mmd`

### PR 3a: shared-types + storage interface 拡張 (~1000 LOC)
- `packages/shared-types/src/dispatch.ts` / `tenant.ts` DTO 拡張
- `services/api/src/services/dispatch/dispatch-storage.ts` interface に 7 メソッド追加
- `services/api/src/services/dispatch/lane-lock.ts` 新規 (transactional 取得、firestore 実装)
- `in-memory-dispatch-storage.ts` / `firestore-dispatch-storage.ts` 実装
- settings PUT を patch semantics に変更 (両実装)
- `tenant-data-loader.ts` に `listProgressReportTargetUsers()` + `getTenantInfo()` 追加
- 単体テスト: claim 重複 reject、pending lease 切れ降格、transactional lane lock 並行 reject、settings patch、受講中フィルタ境界

### PR 3b: gmail-dwd-send.ts multipart/mixed 添付対応 (~450 LOC)
- 新 export `buildMessageMime`
- 既存 `buildCompletionMime` を wrapper にリファクタ
- byte-for-byte 回帰テスト
- RFC 2231 dual-form filename
- 単体テスト: boundary、base64 76char wrap、日本語ファイル名、CR/LF reject、後方互換

### PR 3c: run-progress-reports + state machine + endpoint + Integration (~1700 LOC、**Evaluator 分離発動**)
- 新規 4 ファイル: `run-progress-reports.ts` / `progress-report-recipient.ts` / `progress-mime-builder.ts` / `routes/internal/progress-reports.ts`
- Integration テスト 25 シナリオ (InMemoryDispatchStorage 中心):
  - 基本配信 / 100% 完了除外 / 受講中フィルタ境界 / progressReportEnabled=false テナント skip
  - occurrenceId 冪等 (Scheduler retry で重複なし)
  - pending lease 切れ → manual_review_required
  - crash シナリオ (pending claim 後の Gmail 失敗 / markSent 失敗 → orphan_send audit)
  - lane lock transactional 排他
  - 別 occurrenceId で再送
  - 両レーン独立性 (障害・設定)
  - Gmail 429 retry × 3、403 scope_revoked、400 permanent
  - PDF 5MB 超 → `pdf_too_large` skip
  - PII sha256
  - TTL: pending claim 時点で `ttlExpireAt` 設定
- **Evaluator 分離プロトコル発動** (5 ファイル以上 + 新機能)
- **Codex review セカンドオピニオン併用** (Plan stage thread `019e82e8-4228-79c1-a63a-d3c4e7359731` 継続)

### PR 3d: super-admin API バリデーション + FE 設定 UI (~550 LOC)
- `routes/super/dispatch-settings.ts` PUT バリデーション拡張 (patch semantics 検証含む)
- `routes/super/tenant-settings.ts` に `progressReportEnabled` 追加
- `web/app/super/dispatch-settings/page.tsx` に「進捗レポート 定期配信」セクション追加
- `ScheduleEditor` 流用、always-send-all 戦略
- テナント opt-in トグル UI
- FE テスト: セクション表示、PUT 時 `progressReport` 送信、409 reload、patch semantics 動作確認

### PR 3e: Cloud Scheduler + TTL Policy + dry-run + runbook (~250 LOC + infra)
- Cloud Scheduler 新規 job: `dxcollege-progress-reports` (完了通知と 30 分ずらす)
- Firestore TTL Policy: `progress_report_sends.ttlExpireAt` で 90 日
- `scripts/progress-report-dry-run-cli.ts` + `.github/workflows/progress-report-dry-run.yml`
- `docs/runbook/dxcollege-progress-report-cutover.md` 新規
- scale trigger 300 名超 明記

---

## 2. Acceptance Criteria (AC-PR-01〜22)

### 機能要件
- **AC-PR-01** 基本配信: 設定 ON + schedule 一致 + active 受講者有 → 受講者 (To) + テナント担当者 (CC) に進捗レポート (PDF 添付) 送信
- **AC-PR-02** 100% 完了者除外 → skip + `user_skipped_completed` audit
- **AC-PR-03** 受講中フィルタ (Plan A 4 軸、ADR-039 D-5 改訂): 期限切れ / 0% / 非 student / 非 active tenant 全 skip (退会判定は Firestore schema 不在のため将来 User schema 拡張 PR で対応)
- **AC-PR-04** `progressReportEnabled=false` テナント全件 skip
- **AC-PR-05** `progressReport.enabled=false` → no-op

### 冪等性 (CRITICAL 反映)
- **AC-PR-06** occurrenceId 冪等: Scheduler 同 scheduled execution の retry で重複送信なし
- **AC-PR-07** pending claim 後 crash → 次 retry で manual_review_required 降格、自動再送なし
- **AC-PR-08** 別 occurrenceId (翌週) で同 user 再送 (新 doc create)
- **AC-PR-09** lane lock transactional: 同 lane 並行 request の 2 番目 reject
- **AC-PR-10** 両レーン独立性 (障害): 完了通知 abort 中でも進捗 run 通常完了
- **AC-PR-11** 両レーン独立性 (設定): 完了通知 enabled=true / 進捗 enabled=false → 完了通知のみ送信

### MIME / 添付
- **AC-PR-12** MIME 構造: multipart/mixed、text/plain + application/pdf、RFC 2231 filename dual-form
- **AC-PR-13** PDF 5MB 超 → `pdf_too_large` skip (failed カウンタ不変、専用 counter)
- **AC-PR-14** 既存 `buildCompletionMime` 出力 byte-for-byte 不変 (後方互換)

### セキュリティ / 運用
- **AC-PR-15** PII 最小化: sub-collection に sha256 のみ
- **AC-PR-16** OIDC 認証: token なし or audience 不一致 → 401、settings 読み取りも発生せず
- **AC-PR-17** TTL: pending claim 時点で `ttlExpireAt = claimedAt + 90 days` 設定
- **AC-PR-18** settings patch semantics: 旧 PUT (progressReport 未送信) で既存 `progressReport` 不変
- **AC-PR-19** Tenant `progressReportEnabled` のみ OFF → 完了通知影響なし
- **AC-PR-20** retry & rate limit: Gmail 429 × 2 → 3 回目成功 → sent +1、`Retry-After` 尊重
- **AC-PR-21** audit: laneId / occurrenceId / claimed / pendingExpired / orphanSend / rateLimited / pdfGenerationFailed / duration を記録
- **AC-PR-22** kill switch 即時性: `progressReport.enabled=false` → 次回 cron で進捗のみ no-op、完了通知影響なし

---

## 3. 検証 (end-to-end)

### 各 PR で
```bash
npm run lint -w @lms-279/shared-types -w @lms-279/api -w @lms-279/web
npm run type-check -w @lms-279/shared-types -w @lms-279/api -w @lms-279/web
npm run test -w @lms-279/api
npm run test -w @lms-279/web
```

### PR 3c マージ前 (Evaluator 分離プロトコル)
- 別コンテキストで evaluator agent 起動
- 入力: AC-PR-01〜22 + git diff --name-only
- 評価: PASS / FAIL / UNTESTABLE 判定 + 設計妥当性 + 見落としエッジケース

### PR 3e マージ後 (dry-run smoke + 実 MIME 確認)
```bash
# dry-run: Gmail 送信せず、対象人数 + 推定通数 + CC 数 + PDF サイズ + 処理時間予測を出力
gh workflow run progress-report-dry-run.yml \
  -f tenant_ids=t_xxx -f tenant_emails=eval-only@example.com

# 実 MIME smoke: Gmail / Outlook365 / Apple Mail で日本語ファイル名デコード確認
gh workflow run progress-report-smoke.yml \
  -f tenant_id=t_xxx -f recipient_email=qa-only@example.com
```

### 本番有効化 (業務スーパー管理者作業、runbook 準拠)
1. Tenant `progressReportEnabled=true` 設定 (テナント単位 opt-in)
2. dispatch-settings UI で `progressReport.enabled=true`、曜日・時刻設定
3. 次回 cron 起動 → 受信確認
4. NG なら `progressReport.enabled=false` (kill switch、完了通知影響なし)

---

## 4. 運用 (cutover / kill switch / 監視)

### 4.1 cutover step (業務スーパー管理者作業)
1. テナント単位の `progressReportEnabled` 決裁
2. 各テナントの `progressReportEnabled=true` 設定
3. dispatch-settings UI で曜日・時刻設定、`progressReport.enabled=true`
4. dry-run workflow で対象人数・推定処理時間を確認
5. 本番 cron 起動 → 受信確認 → 業務スーパー管理者へ報告

### 4.2 kill switch
- 即時停止: `progressReport.enabled=false` (UI 操作で完了通知影響なし)
- テナント単位停止: `tenants/{tid}.progressReportEnabled=false`

### 4.3 監視
| 監視対象 | 閾値 | アクション |
|---|---|---|
| 全テナント合計受講者数 | 300 名超 | Cloud Tasks 移行を Phase 4 OQ として検討 |
| Workspace `system@279279.net` 送信上限 | rolling 24h で 1,800 件超 (90%) | cron ずらし強化 or Cloud Tasks 移行 |
| pending lease 切れ件数 | 1 run で 5 件超 | Cloud Run 安定性調査、heartbeat lease 更新検討 |
| orphan_send audit | 1 件でも発生 | Gmail 送信ログ突合、手動確認 |

---

## 5. リスク

| リスク | 緩和策 |
|---|---|
| 受講者数 500 名超に拡大 | runbook scale trigger 明記、Phase 4 OQ 登録 |
| Cloud Run 280s timeout | AC-PR-09 lane lock + AC-PR-07 pending lease 切れで自動 manual_review 降格 |
| PDF メモリ消費 (並列 8 × 数 MB) | Font.register cache、Phase 3e ベンチ |
| 両 cron 同時起動で 429 蓄積 | Phase 3e で初期から 30 分ずらす |
| 削除直前ユーザー race | claim 直前 / send 直前の active 再確認 |
| テナント opt-in 後付け忘れ | runbook cutover step で明示 |
| RFC 2231 filename MUA 互換性 | Phase 3e smoke で Gmail / Outlook365 / Apple Mail 実デコード確認 |

---

## 6. 関連リソース

- ADR-039: `docs/adr/ADR-039-phase3-progress-report-dispatch.md`
- 設計仕様書: `docs/specs/2026-06-01-progress-report-dispatch-design.md`
- フロー図: `docs/specs/2026-06-01-progress-report-dispatch-flow.mmd`
- Plan stage 議論: `~/.claude/plans/eager-jumping-hoare.md`
- Codex セカンドオピニオン thread: `019e82e8-4228-79c1-a63a-d3c4e7359731`
- 完了通知 spec (対称設計): `docs/specs/2026-05-20-completion-notification-design.md`
- 完了通知 cutover runbook (mirror 対象): `docs/runbook/dxcollege-completion-notification-cutover.md`
