---
updated: 2026-08-20 (Firestore複合indexデプロイ完了・ミッション達成)
---

## 現在のミッション
出席レポートの入退室ログ整合性を強化する。レッスン入室最小間隔(F1、異なるレッスンへの入室を退室から1分間ブロック)+セッション重複ログ異常検知(F2、重複/負滞在/stale activeの3種をレポートで検知)を実装する。

## 背景・why
2026-06-10のGoogle Chatスレッドで開発者から出席レポート不整合について①〜⑦の指摘があった。①②③④⑤は既存Issue #533等で対応済みと確認したが、⑥(前後レッスンの退室ログが同時刻になる問題)と⑦(明らかにおかしいログへのエラー検知)は未対応のまま残っていた。以前完了と判定したGOAL.md(テスト任意化ミッション)はこの2件を含んでおらず、決裁者から「ゴール設定が甘かった、しっかりオーダー通り対応」の指示があり本ミッションを新設した。

開発者判断: ⑥は表示調整のみの簡易案ではなく実際の1分間隔ブロック(構造変更)、受講者が困惑しないよう分かりやすい説明文を表示すること。⑦は実装する。

計画はplan mode承認済み(2026-08-20)、Codexセカンドオピニオン(MCP版、effort=high)+実測検証(Firestore複合indexの要否を本番環境へのクエリで確認)を経て確定。計画全文: `/Users/yyyhhh/.claude/plans/shimmying-sleeping-moth.md`。判断材料の図解: `/private/tmp/claude-501/-Users-yyyhhh-Projects-279-lms/a9be797d-c139-4582-a660-52785541ba47/scratchpad/grip-20260820-192901-lesson-entry-gap-plan.html`(セッション終了後は失われるため、次セッションでの再確認は計画ファイルを正とする)。

**観測期間・2段階ロールアウトの計画変更(2026-08-20)**: 開発者から「本システムは現在稼働していない、観測を1週間することに意味は無い」との明示指摘があり、PR-A後の観測期間・PR-B後の`LESSON_ENTRY_GAP_MS=0`→`60000`の2段階ロールアウトを両方省略。PR-Bはデフォルト値(60000ms)で直接デプロイする方針に変更（ADR-027改訂履歴に理由を記録済み）。下記「完了の定義」「進行中のtasks」はこの変更後の状態を反映。

## 完了の定義
- PR-A(F2異常検知、約8ファイル)がmainにmerge済み（証明: `gh pr list --state merged --search "F2" --search "異常検知"`で該当PRがヒット、または計画ファイルのPR-Aセクション記載ファイル群のgit履歴で確認）→ 済（PR #628）
- PR-B(F1入室ギャップ)がmainにmerge済み（証明: 同様にPR-Bセクション記載ファイル群を確認）→ 済（PR #631、レビュー指摘対応コミット含む）
- `firestore.indexes.json`の`lesson_sessions(userId,courseId)`複合indexが本番デプロイ済み（証明: `gcloud firestore indexes composite list --project=lms-279`で該当indexの`state: READY`を確認）→ 済（決裁者承認の上`firebase deploy --only firestore:indexes -P default`実行、`state: READY`確認済み）
- 本番`LESSON_ENTRY_GAP_MS`切替 → 対象外（2段階ロールアウトを行わない方針変更のため、コード上のデフォルト値60000msがそのままデプロイされる。index未デプロイの間は上記の通り事実上無効）
- 計画ファイル記載の受入基準(AC)9項目すべてを満たす（証明: `/Users/yyyhhh/.claude/plans/shimmying-sleeping-moth.md`の「検証・受入基準(AC)」セクション参照、各項目のテストコマンドを実行）

## 進行中のtasks
- [x] PR-A: F2異常検知の実装(session-anomaly.ts新設、super-admin.ts/analytics.tsへの組込み、shared-types拡張、FE2箇所へのバッジ+フィルタ追加)
- [x] PR-A: codex review + pr-review-toolkit 2エージェント並列実施(large tier該当、計7件の指摘すべて反映)
- [x] PR-A: マージ(PR #628、2026-08-20)
- [x] PR-B: F1入室ギャップの実装(トランザクション化されたgap判定+session作成、firestore.indexes.json追加、FE事前ゲート、EntryCooldownNotice新設)
- [x] PR-B: 実機UI確認（`E2E_TEST_ENABLED=true`の`e2e-test`テナント、Playwright MCPでdisabledオーバーレイ・カウントダウンバナー・案内文言を目視確認）
- [x] PR-B: codex review + pr-review-toolkit 2エージェント並列実施(large tier該当、計10件の指摘すべて反映。gap判定ロジックを`services/lesson-entry-gap.ts`に共通化等)
- [x] PR-B: マージ(PR #631、2026-08-20)
- [x] ADR-027改訂・CLAUDE.md重要な設計判断・docs/data-model.md更新(PR-A/PR-B分)
- [x] `firestore.indexes.json`の新規複合index(`lesson_sessions(userId,courseId)`)を本番へ手動デプロイ（決裁者承認の上で実施。Firebase CLIの認証アカウント切替（`system@jaccw.or.jp`→`lms-279`にownerを持つ`system@279279.net`をログイン追加）を経て`firebase deploy --only firestore:indexes -P default`実行、`gcloud firestore indexes composite list --project=lms-279`で`state: READY`確認済み）

## 🎯 GOAL.md のミッション達成
「進行中のtasks」全項目`[x]`。F1(PR #631)・F2(PR #628)ともmainへマージ済み、F1に必要な本番Firestoreインデックスもデプロイ・READY確認済み。次のゴールへの更新 or 本ファイル削除を検討してください。

## 🔄 中断点（in-flight）
なし（全タスク完了）
