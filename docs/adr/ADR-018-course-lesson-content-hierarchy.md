# ADR-018: 講座-レッスン-コンテンツ階層

## ステータス
承認済み

## コンテキスト
コンテンツの構造設計

## 決定
Course → Lessons(順序付き) → Video + Quiz（各任意）の3階層

## 根拠
1レッスンに動画1本+テスト1個の単純な構造で、複雑なネストを避ける。lessonOrder配列で順序管理

## 影響
coursesにlessonOrder[]フィールド。lessonsにcourseId, order, hasVideo, hasQuizフィールド
