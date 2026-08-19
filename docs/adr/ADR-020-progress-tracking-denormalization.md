# ADR-020: 進捗トラッキングの非正規化

## ステータス
承認済み（2026-08-19 改訂: テスト任意化 ADR-040、quizSkipped/quizSkippedAt追加）

## 改訂履歴

- **2026-08-19（テスト任意化、ADR-040）**: **動機**: テストをスキップして完了扱いにする機能を追加するにあたり、既存の `quizPassed`（合格ベースの進捗判定）をそのまま流用すると、5箇所以上ある表示・レポート・PDFゲートの参照先すべてが「合格」と「スキップ」を混同する事実誤認表示になる。**決定**: `quizPassed` は上書きせず、新規 `quizSkipped: boolean` + `quizSkippedAt: string | null` を加算方式で追加。完了判定式を `lessonCompleted = videoCompleted && (quizPassed || quizSkipped)` に拡張（動画視聴は今回も必須のまま、任意化はテストのみ）。判定ロジックは `computeLessonCompleted()` として純粋関数に切り出し。

## コンテキスト
受講者の進捗表示のパフォーマンス

## 決定
user_progress（レッスン単位）+ course_progress（コース単位）で非正規化して高速読み取り

## 根拠
コース一覧画面で全受講者の進捗を表示する際、都度集計は遅い。更新頻度（動画完了・テスト合格時）は読み取り頻度より低い

## 影響
user_progress（ID=userId_lessonId）にvideoCompleted, quizPassed, quizSkipped, quizSkippedAt, lessonCompleted。course_progress（ID=userId_courseId）にcompletedLessons, totalLessons, progressRatio, isCompleted
