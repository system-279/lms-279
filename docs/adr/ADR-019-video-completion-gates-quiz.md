# ADR-019: 動画完了がテストアクセスをゲート

## ステータス
承認済み

## コンテキスト
動画を視聴せずにテストだけ受験することを防止する必要

## 決定
video_analytics.isComplete=trueの確認後にのみテスト開始を許可

## 根拠
動画視聴は学習の必須プロセス。完了判定はサーバーサイドで算出済み（ADR-014）

## 影響
POST /quizzes/:quizId/attempts でvideo_analyticsを検証。requireVideoCompletion=trueのテストのみゲート適用
