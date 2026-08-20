---
updated: 2026-08-20
---

## 現在のミッション
テスト任意化(テナント単位スキップ)の6段階実装計画を完遂する。

## 背景・why
決裁者指示: 「講座のテストを必須としない方針。希望によってテストを実施できるようにする」。あわせて、出席レポートでの「合格」重複表示・時系列の乱れ(既存のケースD後方互換設計に起因、Issue #533で一部backfill済み)の根治もこの機に統合実施することが決裁済み。計画全文: `~/.claude/plans/synchronous-nibbling-crescent.md`（plan mode承認済み）。

## 完了の定義
- 計画の実装順序6段階すべてがmainにマージされている（証明: `~/.claude/plans/synchronous-nibbling-crescent.md`「実装順序」の各Stageに対応するPRが全てmerged状態）
- ケースD厳格化(Stage 5)が本番反映されている（証明: `QUIZ_REQUIRE_ACTIVE_SESSION=true`がデプロイ済み環境変数として設定されている）
- Stage 6のADR-040(新規)+ADR-019/027/036/020の改訂がdocs/adr/に存在する（証明: `ls docs/adr/ | grep -i "ADR-040"`が1件以上ヒット）

## 進行中のtasks
- [x] Stage 1: データモデル+進捗ロジック（`quizSkipped`/`quizSkippedAt`追加、`computeLessonCompleted`実装、PR #594、2026-08-18 main merge済み）
- [x] Stage 2: テナント設定(既定OFF) — `TenantQuizPolicy`型+Firestore/InMemory実装+API+`TenantQuizPolicyEditor`（PR #596、2026-08-19 main merge済み。Codex review(medium+high共に0件)+pr-review-toolkit second opinion(Medium 1件、logger.warnテスト未検証を反映済み)）
- [x] Stage 3: スキップ機能本体 — `POST /quizzes/:quizId/skip`+`createSyntheticSkippedSession`+受講者UI(スキップボタン・確認ダイアログ)（PR #599、2026-08-19 main merge済み。plan modeでCodex plan review(Critical 2件・High複数件反映)を経て実装。Codex review CLIは環境固有要因(サンドボックスEPERM/CLI引数非互換/read-only早期終了)で3回連続失敗し断念、代わりにpr-review-toolkit second opinionでImportant 1件(`SessionRulesNotice`への`quizSkipEnabled`配線誤り)を検出・修正済み。PDF文言はStage 4前のテナント側ON化と矛盾しないよう抽象表現にトーンダウン済み(設計判断6)）
- [x] Stage 4: 資料PDF許可 — PDFゲート変更(合格 OR (スキップ AND テナント許可))+`LessonPdfButton`3状態化(PR #601、2026-08-19 main merge済み。判定をサーバー側純粋関数2つに集約しFE/BE乖離を構造的に防止。codex review CLIは4回連続早期終了のため断念、pr-review-toolkit 3エージェント+evaluatorへ振替、収束指摘(page.tsx配線テスト0件)を反映)
- [ ] Stage 5: ケースD厳格化(単独リリース必須、Stage 3/4と同一リリースにしない) — 実装(有効セッション必須化+合格後再受験の遮断+`QUIZ_REQUIRE_ACTIVE_SESSION`env)はPR #604で2026-08-19 main merge済み。ただし本番反映は2段階ロールアウト設計のため未完了: ①`QUIZ_REQUIRE_ACTIVE_SESSION=false`でコードのみ先行デプロイ済み(挙動不変) ②本番監視後、別PRで`=true`へ切替(未着手、GOAL.md完了の定義の条件2に対応)。codex review×2(medium/strict-config) + pr-review-toolkit 3エージェント並列(code-reviewer/pr-test-analyzer/type-design-analyzer)を実施、収束指摘4件を反映済み(`QuizByLessonResponse.sessionRequired`の削除・`lessons.ts`のhasQuiz条件追加・PATCH の`resolveActiveSessionForQuiz`共用化・監査スクリプトコメント訂正)
- [ ] Stage 6: ADR-040新規+ADR-019/027/036/020改訂+ドキュメント更新（PR #608 main merge済み）+ 重複行整理Phase A（読み取り専用監査スクリプト、PR #609 main merge済み）は完了。Phase A本番監査を実行（`audit-duplicate-synthetic-sessions.yml`が`@lms-279/shared-types`のbuildステップ欠落で初回失敗→PR #613で修正・再実行成功）。実測結果（全テナント横断・3テナント）: 複数行候補62グループ/余剰行101行、うちprotected(super-admin編集済)27グループ、synthetic_skip_multi異常シグナルは0件。Phase B決定: 対応が必要なsafeグループはmixed_synthetic_real 2件(atali82iテナント)のみのため自動統合/削除スクリプトの新規開発は見送り、super-adminによる手動編集で対応する方針。監査スクリプトは`schedule`(毎週月曜)による定期監視に転用し、異常検知時は終了コード3で失敗を可視化するよう改修済み（本PR #614）。**未完了**: safeな2グループの実際の手動編集はPII制限（監査スクリプトはuserId/doc id非出力）によりsuper-adminが別途特定・対応する必要があり本セッション時点で未着手。詳細: ADR-040「Stage 6 Phase A/B」節

## 🔄 中断点（in-flight）
なし(Stage 5の実装自体は完了・PR #604 main merge済み。残るのは監視期間経過後の別PRでのflag切替のみで、コードレベルの部分着手は存在しない)
