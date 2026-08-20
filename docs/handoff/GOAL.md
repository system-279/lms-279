---
updated: 2026-08-20 (PR-A #628 マージ済み反映)
---

## 現在のミッション
出席レポートの入退室ログ整合性を強化する。レッスン入室最小間隔(F1、異なるレッスンへの入室を退室から1分間ブロック)+セッション重複ログ異常検知(F2、重複/負滞在/stale activeの3種をレポートで検知)を実装する。

## 背景・why
2026-06-10のGoogle Chatスレッドで開発者から出席レポート不整合について①〜⑦の指摘があった。①②③④⑤は既存Issue #533等で対応済みと確認したが、⑥(前後レッスンの退室ログが同時刻になる問題)と⑦(明らかにおかしいログへのエラー検知)は未対応のまま残っていた。以前完了と判定したGOAL.md(テスト任意化ミッション)はこの2件を含んでおらず、決裁者から「ゴール設定が甘かった、しっかりオーダー通り対応」の指示があり本ミッションを新設した。

開発者判断: ⑥は表示調整のみの簡易案ではなく実際の1分間隔ブロック(構造変更)、受講者が困惑しないよう分かりやすい説明文を表示すること。⑦は実装する。

計画はplan mode承認済み(2026-08-20)、Codexセカンドオピニオン(MCP版、effort=high)+実測検証(Firestore複合indexの要否を本番環境へのクエリで確認)を経て確定。計画全文: `/Users/yyyhhh/.claude/plans/shimmying-sleeping-moth.md`。判断材料の図解: `/private/tmp/claude-501/-Users-yyyhhh-Projects-279-lms/a9be797d-c139-4582-a660-52785541ba47/scratchpad/grip-20260820-192901-lesson-entry-gap-plan.html`(セッション終了後は失われるため、次セッションでの再確認は計画ファイルを正とする)。

## 完了の定義
- PR-A(F2異常検知、約8ファイル)がmainにmerge済み（証明: `gh pr list --state merged --search "F2" --search "異常検知"`で該当PRがヒット、または計画ファイルのPR-Aセクション記載ファイル群のgit履歴で確認）
- PR-B(F1入室ギャップ、約11-13ファイル)がmainにmerge済み（証明: 同様にPR-Bセクション記載ファイル群を確認）
- `firestore.indexes.json`の`lesson_sessions(userId,courseId)`複合indexが本番デプロイ済み（証明: `gcloud firestore indexes composite list --project=lms-279`で該当indexの`state: READY`を確認）
- 本番`LESSON_ENTRY_GAP_MS`が`60000`(有効化)まで切替完了（証明: Cloud Run実機のenv値を確認。PR-Aマージ後最低1週間の観測期間を経てから切替する運用のため、即時ではない）
- 計画ファイル記載の受入基準(AC)9項目すべてを満たす（証明: `/Users/yyyhhh/.claude/plans/shimmying-sleeping-moth.md`の「検証・受入基準(AC)」セクション参照、各項目のテストコマンドを実行）

## 進行中のtasks
- [x] PR-A: F2異常検知の実装(session-anomaly.ts新設、super-admin.ts/analytics.tsへの組込み、shared-types拡張、FE2箇所へのバッジ+フィルタ追加)
- [x] PR-A: codex review + pr-review-toolkit 2エージェント並列実施(large tier該当、計7件の指摘すべて反映)
- [x] PR-A: マージ(PR #628、2026-08-20)、観測期間(最低1週間、〜2026-08-27目安)開始
- [ ] 観測期間終了後、`stale_active`/`overlap_previous`の実発生件数を確認(super-admin.ts attendance-reportまたはFirestore該当コレクションを確認)
- [ ] PR-B: F1入室ギャップの実装(トランザクション化されたgap判定+session作成、firestore.indexes.json追加、FE事前ゲート、EntryCooldownNotice新設)
- [ ] PR-B: codex review実施(large tier該当)
- [ ] PR-B: マージ、`LESSON_ENTRY_GAP_MS=0`でデプロイ(挙動不変)
- [ ] 本番監視後、`LESSON_ENTRY_GAP_MS=60000`へ切替(2段階ロールアウト完了)
- [x] ADR-027改訂・CLAUDE.md重要な設計判断・docs/data-model.md更新(PR-A分。docs/api.mdはPR-A時点で新規エラーコードなしのため対象外、PR-B時に`entry_too_soon`を追記予定)

## 🔄 中断点（in-flight）
- 対象タスク: PR-A完了。観測期間中(最低1週間)、PR-B(F1入室ギャップ)着手前の待機
- 直前の状態: PR #628マージ済み(mainに反映済み)。異常検知はread-onlyのため受講者影響なし、追加のデプロイ作業不要（Cloud Runの通常CI/CDパイプラインで自動反映想定、手動デプロイ確認は次セッションで`gh run list`等により確認）
- 次の一手: 観測期間(目安2026-08-27以降)経過後、super出席レポート(`/super/attendance`)またはFirestore `lesson_sessions`で`stale_active`/`overlap_previous`の実発生件数を確認してから、`/Users/yyyhhh/.claude/plans/shimmying-sleeping-moth.md`の「PR-B: F1 入室最小間隔」セクションに従い着手する
- 検証コマンド: `git log --oneline -5`でPR #628マージ済みを確認 → `cat /Users/yyyhhh/.claude/plans/shimmying-sleeping-moth.md`で計画全文を再確認
