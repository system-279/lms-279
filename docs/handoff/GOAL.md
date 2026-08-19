---
updated: 2026-08-19
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
- [ ] Stage 2: テナント設定(既定OFF) — `TenantQuizPolicy`型+Firestore/InMemory実装+API+`TenantQuizPolicyEditor`
- [ ] Stage 3: スキップ機能本体 — `POST /quizzes/:quizId/skip`+`createSyntheticSkippedSession`+受講者UI(スキップボタン・確認ダイアログ)
- [ ] Stage 4: 資料PDF許可 — PDFゲート変更(合格 OR (スキップ AND テナント許可))+`LessonPdfButton`3状態化
- [ ] Stage 5: ケースD厳格化(単独リリース必須、Stage 3/4と同一リリースにしない) — 有効セッション必須化+合格後再受験の遮断+`QUIZ_REQUIRE_ACTIVE_SESSION`env
- [ ] Stage 6: ADR-040新規+ADR-019/027/036/020改訂+ドキュメント更新+既存重複synthetic行の整理スクリプト

## 🔄 中断点（in-flight）
Stage 2 実装完了・ローカル feature ブランチ `feat/quiz-optional-stage2-tenant-policy`（commit `3f071f7`）にコミット済み、**未 push・未 PR**。plan mode 承認済み計画（`~/.claude/plans/imperative-bubbling-dijkstra.md`）に基づき実装、Codex plan review（MCP, effort=high）でセカンドオピニオン取得済み、`codex review --base main`（effort=medium）で findings 0 件。新規テスト27件（API 20 + UIコンポーネント7）含め lint/type-check/test 全ワークスペースPASS。次アクション: push → PR作成 → 決裁者へのPRマージ認可依頼（番号単位）。AC-4は当初想定のPlaywright実機ウォークスルーが `/super/*` のFirebase実認証ゲートにより不可能と判明したため、コンポーネントテストで代替した（詳細は計画ファイル参照）。
