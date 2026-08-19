# ADR-040: テスト任意化（テナント単位スキップ）

## ステータス

承認済み・実装完了（Stage 1〜5 が main マージ済み。Stage 5 の本番 flag 切替は監視期間経過後に別 PR で実施予定）

## コンテキスト

開発者指示: 「講座のテストを必須としない方針。希望によってテストを実施できるようにする」というテナント単位の任意化要望。

これと並行して、現場から「合格のみ抽出 PDF に滞在時間 1〜2 分の合格が混入する」という指摘があり、調査の結果、根本原因は「動画を見直さずテストだけ再受験できる」既存の後方互換ロジック（ADR-027 でいう「ケース D」）にあると判明した。両者は開発者判断により統合実施が決裁された。

計画全文: `~/.claude/plans/synchronous-nibbling-crescent.md`（plan mode 承認済み）。本 ADR はその実装順序（Stage 1〜6）が完了した時点での傘となる決定を記録する。個別の技術判断は ADR-019/020/027/036 の該当改訂を参照。

## 決定

1. **`UserProgress.quizPassed` は上書きしない**。新規 `quizSkipped: boolean` + `quizSkippedAt: string | null` を加算方式で追加する。`quizPassed` は 5 箇所以上の表示・レポート・PDF ゲートで「テスト合格」の意味で参照されており、スキップを合流させると全箇所が事実誤認表示になるため。
2. **レッスン完了判定を `lessonCompleted = videoCompleted && (quizPassed || quizSkipped)` に拡張**。動画視聴は今回も必須のまま（任意化はテストのみ）。
3. **テナント設定はサブコレクション方式**（`tenants/{tenantId}/quiz_policy/_config`）を採用。`quizSkipEnabled`（マスタースイッチ、既定 OFF）と `pdfDownloadAllowedForSkipped`（既定 OFF、マスター OFF 時も値を保持し AND 判定で実効化）の 2 フィールド。
4. **スキップは受講者向け新規 API `POST /quizzes/:quizId/skip`** で行う。動画完了ゲートは `quiz.requireVideoCompletion` の値によらず無条件適用（動画自体は任意化しないため）。冪等判定（既にスキップ済みなら他ゲートより前に 200 を返す）を最優先にし、スキップ成功後にテナント側でポリシーを OFF に戻しても 2 回目の同一呼び出しは常に 200 を維持する。
5. **合成セッションはスキップ専用に新規実装**（`createSyntheticSkippedSession`、doc id = `synthetic_skip_{userId}_{lessonId}`）。既存の合格用 `createSyntheticCompletedSession`（doc id = `synthetic_{attemptId}`、ADR-027）は流用しない。attempt 単位の doc id 設計そのものが既存の重複行問題の原因であるため、スキップ版は最初から (受講者, レッスン) 単位の決定的 ID にし構造的に 1 行へ固定する。
6. **講座資料 PDF ダウンロードゲートを 3 状態に拡張**（ADR-036 改訂）: `合格 OR (スキップ AND テナントが quizSkipEnabled && pdfDownloadAllowedForSkipped を許可)`。
7. **ケース D（動画なしテスト単独再受験、ADR-027）を厳格化**。スキップという正規の抜け道ができたため、暗黙の抜け道（`activeSession=null` での後方互換受験）は塞ぐ。`QUIZ_REQUIRE_ACTIVE_SESSION`（default `true`）で有効セッション必須化を制御し、`false` 時のみ旧挙動を維持する単独ロールバック経路を残す。合わせて合格後の再受験導線自体を閉じる（`quizBestScore` は既に最高点保持のため再受験の業務的必然性が薄く、合格後再受験で `max_attempts_failed` に到達すると学習データが全消去される「合格を失う」バグ経路も同時に塞げるため）。

## 実装順序（段階リリース）

各段階で独立デプロイ・ロールバック可能な設計とした（詳細: 実装計画）。

| Stage | 内容 | PR | 状態 |
|---|---|---|---|
| 1 | データモデル+進捗ロジック（`quizSkipped`/`quizSkippedAt`、`computeLessonCompleted`） | #594 | main merge済み(2026-08-18) |
| 2 | テナント設定（既定OFF）: `TenantQuizPolicy`+API+`TenantQuizPolicyEditor` | #596 | main merge済み(2026-08-19) |
| 3 | スキップ機能本体: `POST /quizzes/:quizId/skip`+`createSyntheticSkippedSession`+受講者UI | #599 | main merge済み(2026-08-19) |
| 4 | 資料PDF許可: PDFゲート変更+`LessonPdfButton`3状態化 | #601 | main merge済み(2026-08-19) |
| 5 | ケースD厳格化: 有効セッション必須化+合格後再受験の遮断 | #604 | コード main merge済み(2026-08-19)。本番 flag は `QUIZ_REQUIRE_ACTIVE_SESSION=false` で先行デプロイ中、監視期間経過後に別PRで `=true` へ切替予定 |
| 6 | ADR改訂+ドキュメント更新+既存重複データの整理スクリプト | 本PR（文書化部分）+ 別PR（整理スクリプト） | 進行中 |

## 根拠

- **加算方式（`quizPassed`温存）**: 既存の合格ベース表示・レポート・PDFゲートを一切書き換えずに済み、既存不具合の混入リスクを避けられる。三値（合格/スキップ/未合格）表示への拡張は表示層のみで完結する。
- **サブコレクション方式のテナント設定**: `FirestoreDataSource.collection()` は `tenants/{tid}/` 配下にしか到達できない実装制約があり（`firestore.ts` 実測確認済み）、受講者向けAPI経路（スキップ判定・PDFゲート・コース応答）からテナント設定を読む必要があるため、DataSource経由で読めるサブコレクション方式でなければ `InMemoryDataSource` 中心の統合テスト戦略（ADR-028）が成立しない。テナントdocへの直接フィールド追加（`TenantNotificationCcConfig`方式）は不採用。
- **スキップ専用合成セッション**: 既存の attempt 単位 doc id 設計（`synthetic_{attemptId}`）を流用すると、1 レッスンに対して複数回スキップ操作が発生し得る経路で重複行が再発するリスクがある。(受講者, レッスン) 単位の決定的 ID にすることで構造的に防ぐ。
- **ケースD厳格化を Stage 3/4 と別リリースにした理由**: 締め付け変更のため、問題発生時にスキップ機能を巻き込まずロールバックできる必要がある。`QUIZ_REQUIRE_ACTIVE_SESSION` を false で先行投入→本番監視後に true へ切替という 2 段階ロールアウトにより、コードデプロイと挙動変更のタイミングを分離した。

## 影響

- **データモデル**: `UserProgress` に `quizSkipped`/`quizSkippedAt` 追加（ADR-020 改訂参照）。新規サブコレクション `tenants/{tenantId}/quiz_policy/_config`。`lesson_sessions.exitReason` に `quiz_skipped` 追加（ADR-027 改訂参照）。
- **API**: `POST /quizzes/:quizId/skip`（受講者）、`GET`/`PUT /super/tenants/:tenantId/quiz-policy`（Super Admin）を新規追加。`GET /quizzes/by-lesson/:lessonId` 応答に `skipAvailable`/`quizSkipped` を追加。`GET /lessons/:lessonId/pdf-download` のゲート判定を拡張（ADR-036改訂参照）。
- **UI**: 受講者向けスキップボタン+確認ダイアログ、資料PDFボタンの3状態化、スーパー管理者向け `TenantQuizPolicyEditor`。
- **env**: `QUIZ_REQUIRE_ACTIVE_SESSION`（default `true`）を新規追加（CLAUDE.md 環境変数表反映済み）。

## 関連ADR

- ADR-018（Course-Lesson階層、`quizPassed`が参照される既存構造）
- ADR-019（動画完了がテストアクセスをゲート、改訂: スキップAPIも動画ゲートは無条件適用）
- ADR-020（進捗トラッキングの非正規化、改訂: `quizSkipped`/`quizSkippedAt`追加）
- ADR-027（レッスンセッション出席管理、改訂: `quiz_skipped`退室理由・ケースD厳格化）
- ADR-028（DataSourceテスト戦略、サブコレクション方式採用の前提）
- ADR-036（講座資料PDF配信、改訂: DLゲート3状態化）

## 検討した代替案

- **`quizPassed` にスキップ状態を合流させる案**: 不採用。既存の合格ベース参照箇所すべてが事実誤認表示になるため加算方式を採用。
- **テナントdocへの直接フィールド追加**: 不採用。受講者向けAPI経路からDataSource経由で読む必要があり、サブコレクション方式でなければ統合テスト戦略が成立しない。
- **既存合成セッション（`createSyntheticCompletedSession`）の流用**: 不採用。attempt単位のdoc id設計自体が既存の重複行問題の原因であるため、レッスン単位の決定的IDで新規実装。
- **ケースDのリセット廃止・動画ゲート撤廃**: 不採用（2026-05-20時点で既に検討済み、ADR-027参照）。今回のスキップ機能でも動画視聴の必須性は維持。
