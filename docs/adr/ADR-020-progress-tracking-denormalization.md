# ADR-020: 進捗トラッキングの非正規化

## ステータス
承認済み

## コンテキスト
受講者の進捗表示のパフォーマンス

## 決定
user_progress（レッスン単位）+ course_progress（コース単位）で非正規化して高速読み取り

## 根拠
コース一覧画面で全受講者の進捗を表示する際、都度集計は遅い。更新頻度（動画完了・テスト合格時）は読み取り頻度より低い

## 影響
user_progress（ID=userId_lessonId）にvideoCompleted, quizPassed, lessonCompleted。course_progress（ID=userId_courseId）にcompletedLessons, totalLessons, progressRatio, isCompleted
